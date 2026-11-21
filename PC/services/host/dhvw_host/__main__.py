"""DHVW 服务宿主：托管 sidecar 进程、监视外壳存活、整树清理（ADR-PC-015）。"""

from __future__ import annotations

import json
import os
import re
import ctypes
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path
from queue import Empty, Queue

MARK = "@@DHVW@@ "

SYNCHRONIZE = 0x00100000
WAIT_OBJECT_0 = 0x00000000
WAIT_TIMEOUT = 0x00000102
INFINITE = 0xFFFFFFFF
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

MAX_RESTARTS = 10
RESTART_WINDOW = 300.0
HEALTH_TIMEOUT = 30.0


def emit(payload: dict) -> None:
    sys.stdout.write(MARK + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Log:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = path.open("a", encoding="utf-8")
        self._lock = threading.Lock()

    def write(self, level: str, message: str, **extra: object) -> None:
        entry = {"ts": round(time.time(), 3), "level": level, "message": message, **extra}
        line = json.dumps(entry, ensure_ascii=False)
        with self._lock:
            self._fh.write(line + "\n")
            self._fh.flush()


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        k32 = ctypes.windll.kernel32
        handle = k32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            return k32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def process_image(pid: int) -> str:
    if os.name != "nt":
        return ""
    k32 = ctypes.windll.kernel32
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = ctypes.c_uint(1024)
        buf = ctypes.create_unicode_buffer(1024)
        if k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return Path(buf.value).name.lower()
    finally:
        k32.CloseHandle(handle)
    return ""


def process_create_time(pid: int) -> int | None:
    """返回进程创建时间（FILETIME 100ns），用于 PID 复用的二次校验。"""
    if os.name != "nt":
        return None
    k32 = ctypes.windll.kernel32
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None

    class FILETIME(ctypes.Structure):
        _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]

    created, exited, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
    try:
        if not k32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                   ctypes.byref(kernel), ctypes.byref(user)):
            return None
        return (created.high << 32) | created.low
    finally:
        k32.CloseHandle(handle)


def terminate(pid: int) -> None:
    """终止进程及其整棵子树：Windows 的 venv 解释器会再起一个真实 python 子进程（ADR-PC-015）。"""
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/T", "/F", "/PID", str(pid)],
            capture_output=True,
            creationflags=0x08000000,  # CREATE_NO_WINDOW
        )
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass


class JobKeeper:
    """KILL_ON_JOB_CLOSE 作业对象：宿主一旦消失（含被强杀），Windows 直接回收全部 worker。"""

    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
    PROCESS_SET_QUOTA = 0x0100
    PROCESS_TERMINATE = 0x0001

    def __init__(self) -> None:
        self._handle = None
        if os.name != "nt":
            return
        k32 = ctypes.windll.kernel32
        handle = k32.CreateJobObjectW(None, None)
        if not handle:
            return

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", ctypes.c_uint32),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_uint32),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_uint32),
                ("SchedulingClass", ctypes.c_uint32),
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = self.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = k32.SetInformationJobObject(
            handle,
            self.JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            k32.CloseHandle(handle)
            return
        self._handle = handle

    def assign(self, pid: int) -> bool:
        if not self._handle:
            return False
        k32 = ctypes.windll.kernel32
        ph = k32.OpenProcess(self.PROCESS_SET_QUOTA | self.PROCESS_TERMINATE, False, pid)
        if not ph:
            return False
        try:
            return bool(k32.AssignProcessToJobObject(self._handle, ph))
        finally:
            k32.CloseHandle(ph)


class ShellWatcher:
    """阻塞等待外壳进程句柄；返回即表示外壳已退出。"""

    def __init__(self, pid: int) -> None:
        self.pid = pid
        self._handle = None
        self._thread: threading.Thread | None = None
        self._gone = threading.Event()

    def start(self) -> None:
        if os.name != "nt":
            self._thread = threading.Thread(target=self._poll_posix, daemon=True)
        else:
            k32 = ctypes.windll.kernel32
            self._handle = k32.OpenProcess(SYNCHRONIZE, False, self.pid)
            if not self._handle:
                self._gone.set()
                return
            self._thread = threading.Thread(target=self._wait_nt, daemon=True)
        self._thread.start()

    def _wait_nt(self) -> None:
        k32 = ctypes.windll.kernel32
        rc = k32.WaitForSingleObject(self._handle, INFINITE)
        self._gone.set()
        _ = rc

    def _poll_posix(self) -> None:
        while process_alive(self.pid):
            time.sleep(0.5)
        self._gone.set()

    @property
    def gone(self) -> bool:
        return self._gone.is_set()


class Worker:
    def __init__(self, spec: dict, services_root: Path, log_dir: Path, log: Log, job: "JobKeeper") -> None:
        self.id: str = spec["id"]
        self.name: str = spec.get("name", self.id)
        self.port: int = int(spec["port"])
        self.module: str = spec.get("module", "")
        self.args: list[str] = list(spec.get("args", []))
        self.command: list[str] | None = list(spec["command"]) if spec.get("command") else None
        self.cwd: str | None = spec.get("cwd")
        self.extra_env: dict[str, str] = dict(spec.get("env") or {})
        self.health_path: str | None = spec.get("healthPath")
        self.health_mode: str = spec.get("healthMode") or "http"
        # 慢启动服务（GPU 模型加载等）可以配更长；超时只告警一次，之后继续探测
        self.health_timeout: float = float(spec.get("healthTimeout") or HEALTH_TIMEOUT)
        self.auto_start: bool = bool(spec.get("autoStart", True))
        self.healthy: bool | None = None
        self.services_root = services_root
        self.log_dir = log_dir
        self.log = log
        self.job = job
        self.proc: subprocess.Popen | None = None
        self.restarts = 0
        self.started_at = 0.0
        self.restart_history: list[float] = []
        self.state = "stopped"

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "port": self.port,
            "pid": self.proc.pid if self.proc and self.proc.poll() is None else None,
            "state": self.state,
            "restarts": self.restarts,
            "healthy": self.healthy,
        }

    def start(self) -> None:
        if self.proc and self.proc.poll() is None:
            return
        log_path = self.log_dir / f"{self.id}.log"
        out = log_path.open("a", encoding="utf-8", errors="replace")
        env = dict(os.environ)
        # 外壳可能已注入依赖目录（安装根只读时会退到用户数据目录），必须保留而不是覆盖
        inherited = [p for p in (env.get("DHVW_PYTHONPATH") or env.get("PYTHONPATH") or "").split(os.pathsep) if p]
        search = os.pathsep.join(
            [
                str(self.services_root / "worker"),
                str(self.services_root / "host"),
                str(self.services_root / "orchestrator"),
                *inherited,
            ]
        )
        env["PYTHONPATH"] = search
        # 内置嵌入式运行时走 sitecustomize，忽略 PYTHONPATH
        env["DHVW_PYTHONPATH"] = search
        env["PYTHONUNBUFFERED"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        if self.command:
            cmd = [part.replace("{port}", str(self.port)) for part in self.command]
        else:
            cmd = [sys.executable, "-m", self.module, *self.args, "--port", str(self.port)]
        env.update({k: self._expand(v) for k, v in self.extra_env.items()})
        flags = 0x00000200 if os.name == "nt" else 0  # CREATE_NEW_PROCESS_GROUP
        self.proc = subprocess.Popen(
            cmd,
            cwd=str(self.cwd or self.services_root),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=subprocess.STDOUT,
            creationflags=flags,
            close_fds=True,
        )
        self.started_at = time.time()
        self.state = "running"
        if not self.job.assign(self.proc.pid):
            self.log.write("warn", "job assign failed", service=self.id, pid=self.proc.pid)
        emit({"ts": round(time.time() * 1000), "type": "worker.started", "service": self.id, "pid": self.proc.pid, "port": self.port})
        self.log.write("info", "worker started", service=self.id, pid=self.proc.pid, port=self.port, cmd=cmd[0])
        if self.health_path or self.health_mode == "tcp":
            self.healthy = None
            threading.Thread(target=self._probe_health, args=(self.proc.pid,), daemon=True).start()

    def _expand(self, value: str) -> str:
        """支持 {port} 与 %VAR%（值取自当前进程环境，避免配置里写死绝对路径）。"""
        value = value.replace("{port}", str(self.port))
        return re.sub(r"%([A-Za-z_][A-Za-z0-9_]*)%", lambda m: os.environ.get(m.group(1), m.group(0)), value)

    def _probe_health(self, pid: int | None) -> None:
        """探测就绪：超过 healthTimeout 只告警一次，之后仍继续探测直到进程退出。

        慢启动服务（GPT-SoVITS 加载模型约 40 s）不能因为一次超时就被判定永远不健康。
        """
        path = self.health_path or "/health"
        url = f"http://127.0.0.1:{self.port}{path}"
        started = time.time()
        warned = False
        while True:
            if not self.proc or self.proc.pid != pid or self.proc.poll() is not None:
                return
            try:
                if self.health_mode == "tcp":
                    with socket.create_connection(("127.0.0.1", self.port), timeout=1.0):
                        ok = True
                else:
                    with urllib.request.urlopen(url, timeout=1.0) as resp:
                        ok = resp.status < 400
                if ok:
                    self.healthy = True
                    ms = int((time.time() - started) * 1000)
                    emit({"ts": round(time.time() * 1000), "type": "worker.healthy", "service": self.id, "pid": pid, "ms": ms})
                    self.log.write("info", "worker healthy", service=self.id, mode=self.health_mode, ms=ms)
                    return
            except Exception:
                pass
            if not warned and time.time() - started > self.health_timeout:
                warned = True
                self.healthy = False
                emit({"ts": round(time.time() * 1000), "type": "worker.unhealthy", "service": self.id, "pid": pid})
                self.log.write(
                    "warn",
                    "worker unhealthy",
                    service=self.id,
                    port=self.port,
                    mode=self.health_mode,
                    path=path,
                    after=round(time.time() - started),
                )
            time.sleep(0.3 if not warned else 1.0)

    def stop(self, reason: str) -> None:
        proc = self.proc
        if not proc:
            self.state = "stopped"
            return
        if proc.poll() is None:
            terminate(proc.pid)
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
        self.proc = None
        self.state = "stopped"
        self.healthy = None
        emit({"ts": round(time.time() * 1000), "type": "worker.stopped", "service": self.id, "code": proc.returncode})
        self.log.write("info", "worker stopped", service=self.id, reason=reason, code=proc.returncode)

    def poll(self) -> bool:
        """返回 True 表示发生状态变化（需要重启/标记失败）。"""
        proc = self.proc
        if not proc:
            return False
        code = proc.poll()
        if code is None:
            return False
        uptime = time.time() - self.started_at
        self.proc = None
        self.healthy = None
        if uptime > 30:
            self.restart_history.clear()
        self.restarts += 1
        now = time.time()
        self.restart_history = [t for t in self.restart_history if now - t < RESTART_WINDOW]
        self.restart_history.append(now)
        emit(
            {
                "ts": round(time.time() * 1000),
                "type": "worker.exit",
                "service": self.id,
                "code": code,
                "restarts": self.restarts,
            }
        )
        self.log.write("warn", "worker exited", service=self.id, code=code, uptime=round(uptime, 1))
        if len(self.restart_history) > MAX_RESTARTS:
            self.state = "failed"
            emit({"ts": round(time.time() * 1000), "type": "worker.failed", "service": self.id, "message": "超过重启上限"})
            self.log.write("error", "worker failed", service=self.id, restarts=self.restarts)
            return False
        self.state = "starting"
        emit({"ts": round(time.time() * 1000), "type": "worker.restart", "service": self.id, "restarts": self.restarts})
        time.sleep(min(2.0, 0.4 * len(self.restart_history)))
        self.start()
        return True


def cleanup_orphans(log: Log, pid_file: Path) -> None:
    try:
        pids = json.loads(pid_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    for entry in pids if isinstance(pids, list) else []:
        if isinstance(entry, dict):
            pid, expected = entry.get("pid"), entry.get("create")
        else:
            pid, expected = entry, None
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            continue
        if pid <= 0 or not process_alive(pid):
            continue
        image = process_image(pid)
        if not image.startswith("python"):
            continue
        if expected is not None and process_create_time(pid) != expected:
            log.write("warn", "orphan pid reused, skip", pid=pid, image=image)
            continue
        log.write("warn", "killing orphan", pid=pid, image=image)
        terminate(pid)
    pid_file.unlink(missing_ok=True)


def main(argv: list[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="dhvw_host")
    parser.add_argument("--shell-pid", type=int, required=True)
    parser.add_argument("--log-dir", required=True)
    parser.add_argument("--services", required=True)
    ns = parser.parse_args(argv)

    log_dir = Path(ns.log_dir)
    services_root = Path(__file__).resolve().parents[2]
    log = Log(log_dir / "host.log")
    pid_file = log_dir / "host-children.json"

    cleanup_orphans(log, pid_file)
    specs = json.loads(Path(ns.services).read_text(encoding="utf-8"))["services"]
    job = JobKeeper()
    if not job.assign(os.getpid()):
        log.write("warn", "self job assign failed")
    workers = [Worker(spec, services_root, log_dir, log, job) for spec in specs]

    stop_all = threading.Event()
    commands: Queue[dict] = Queue()

    def read_stdin() -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                commands.put(json.loads(line))
            except ValueError:
                log.write("warn", "bad command", line=line[:200])
        stop_all.set()

    threading.Thread(target=read_stdin, daemon=True).start()

    watcher = ShellWatcher(ns.shell_pid)
    watcher.start()
    if watcher.gone:
        log.write("error", "shell already gone at startup", pid=ns.shell_pid)
        return 2

    for w in workers:
        if w.auto_start:
            w.start()
    emit({"ts": round(time.time() * 1000), "type": "host.ready", "shell_pid": ns.shell_pid,
          "workers": [w.snapshot() for w in workers]})
    log.write("info", "host ready", shell_pid=ns.shell_pid)

    pid_file.write_text(
        json.dumps([{"pid": w.proc.pid, "create": process_create_time(w.proc.pid)} for w in workers if w.proc]),
        encoding="utf-8",
    )

    last_beat = 0.0
    exit_code = 0
    try:
        while True:
            if watcher.gone:
                emit({"ts": round(time.time() * 1000), "type": "shell.gone"})
                log.write("warn", "shell gone, killing tree", shell_pid=ns.shell_pid)
                exit_code = 0
                break
            if stop_all.is_set():
                break
            try:
                cmd = commands.get(timeout=0.25)
            except Empty:
                cmd = None
            if cmd:
                action = cmd.get("cmd")
                target = cmd.get("service")
                if action == "shutdown":
                    break
                for w in workers:
                    if target and w.id != target:
                        continue
                    if action == "restart":
                        w.stop("restart-request")
                        w.start()
                    elif action == "stop":
                        w.stop("stop-request")
                    elif action == "start":
                        w.start()
            changed = False
            for w in workers:
                changed = w.poll() or changed
            now = time.time()
            if now - last_beat >= 5:
                last_beat = now
                emit({"ts": round(now * 1000), "type": "host.heartbeat",
                      "workers": [w.snapshot() for w in workers]})
            if changed:
                emit({"ts": round(now * 1000), "type": "host.heartbeat",
                      "workers": [w.snapshot() for w in workers]})
    finally:
        for w in workers:
            w.stop("host-exit")
        pid_file.unlink(missing_ok=True)
        emit({"ts": round(time.time() * 1000), "type": "host.shutdown"})
        log.write("info", "host shutdown", code=exit_code)
        log._fh.close()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
