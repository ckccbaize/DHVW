"""场景作业：把「生成一张地图」交给嵌入式 agent（pi CLI）+ 地图 skill。

用户口径：一个场景（家、街道……）就是**一张连续地图**，切换靠加载；PC 只产出设备可运行
的场景包（MAP-SCENE-DESIGN §13.4 / §15.1），不渲染、不展示。

链路：
    POST /dhvw/scene ─► 建工作目录 data/scenes/<id>/
                     ─► pi -p --skill docs/MAP-SCENE-DESIGN.md（HOME 隔离，写入 models.json）
                     ─► agent 写 <id>.map.json 并跑 paint_home / pack_scene / validate_scene
                     ─► 编排器自己再跑一次 validate_scene.py 作为收包闸门
                     ─► 通过则向设备发 scene:ready {id}（id 是设备的 sceneRequests 条目 id）
任何一步缺失（pi 不在、缺 PIL、缺工具链、LLM 未配置）都显式失败，不产占位包。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from .store import Store

JOB_TIMEOUT = 1800
LOG_TAIL = 8000
SPEC_NAME = "map-scene-design"

REQUIRED = [
    "dist/scene.json",
    "dist/intgrid.bin",
    "dist/terrain.png",
    "dist/furniture.png",
    "dist/interactions.json",
    "dist/manifest.json",
]


def _sanitize(text: str, fallback: str) -> str:
    cleaned = re.sub(r"[^a-z0-9-]+", "-", text.strip().lower()).strip("-")
    return cleaned[:32] or fallback


def find_toolchain() -> Path | None:
    """地图工具链根（含 docs/MAP-SCENE-DESIGN.md 与 scripts/paint_home.py）。"""
    candidates: list[Path] = []
    env = os.environ.get("DHVW_MAP_TOOLCHAIN")
    if env:
        candidates.append(Path(env))
    here = Path(__file__).resolve()
    # PC/services/orchestrator/dhvw_orchestrator/scene.py -> PC/services/orchestrator -> ...
    for up in range(2, 6):
        try:
            candidates.append(here.parents[up])
        except IndexError:
            break
    for cand in candidates:
        if (cand / "docs/MAP-SCENE-DESIGN.md").is_file() and (cand / "scripts/paint_home.py").is_file():
            return cand
    return None


def find_pi() -> str | None:
    env = os.environ.get("PI_BIN")
    if env and Path(env).is_file():
        return env
    which = shutil.which("pi")
    if which:
        return which
    for guess in (
        Path("D:/Program Files/pi-windows-x64/pi.exe"),
        Path.home() / "AppData/Roaming/npm/pi.cmd",
    ):
        if guess.is_file():
            return str(guess)
    return None


def find_map_python() -> str | None:
    """画图脚本需要 PIL + numpy；外壳内嵌运行时没有，所以可单独指定。"""
    env = os.environ.get("DHVW_MAP_PYTHON")
    candidates = [env] if env else []
    candidates += [sys.executable, shutil.which("python") or "", shutil.which("python3") or ""]
    for cand in candidates:
        if not cand or not Path(cand).is_file():
            continue
        try:
            import subprocess

            probe = subprocess.run(
                [cand, "-c", "import PIL, numpy"],
                capture_output=True,
                timeout=20,
            )
            if probe.returncode == 0:
                return cand
        except Exception:
            continue
    return None


def public(job: dict[str, Any]) -> dict[str, Any]:
    """对外只给公开字段，执行期内部字段（_pi/_python/_toolchain）不外泄。"""
    return {k: v for k, v in job.items() if not k.startswith("_")}


class SceneRunner:
    def __init__(self, store: Store, data_dir: Path, push: Callable[[str, dict], Awaitable[None]]) -> None:
        self.store = store
        self.root = Path(data_dir) / "scenes"
        self.root.mkdir(parents=True, exist_ok=True)
        self.home = Path(data_dir) / "agent-home"
        self.push = push
        self.llm: dict[str, Any] = {}
        self.jobs: dict[str, dict[str, Any]] = {}
        # 设备的 sceneRequests 条目 -> 作业映射。设备每个 digest 会重复报同一条 pending，
        # 靠这本账目做幂等：一个请求只生成一次，不论成功失败。
        self.requests: dict[str, dict[str, Any]] = self.store.get_kv("scene_requests", {}) or {}
        self._load()
        self._save_requests()

    # ---------- 持久化：重启后任务表仍在，running 视为 failed ----------
    def _load(self) -> None:
        raw = self.store.get_kv("scene_jobs")
        if isinstance(raw, list):
            for job in raw:
                if isinstance(job, dict) and job.get("id"):
                    if job.get("state") in ("queued", "running"):
                        job["state"] = "failed"
                        job["stage"] = "失败（重启中断）"
                        job["finishedAt"] = job.get("finishedAt") or int(time.time() * 1000)
                        job["error"] = "编排器重启，任务中断"
                        rid = job.get("request")
                        if rid:
                            # 账本不能停在 running，否则界面显示「生成中」而作业早已中断
                            self.requests[rid] = {
                                **self.requests.get(rid, {}),
                                "state": "failed",
                                "job": job["id"],
                                "reason": "编排器重启，任务中断",
                                "ts": int(time.time() * 1000),
                            }
                    if job.get("state") == "failed" and str(job.get("error") or "").startswith("编排器重启"):
                        job["stage"] = "失败（重启中断）"
                    self.jobs[job["id"]] = job

    def _save(self) -> None:
        self.store.put_kv("scene_jobs", list(self.jobs.values())[-50:])

    def _save_requests(self) -> None:
        # 只留最近 100 条，避免账本无限长
        if len(self.requests) > 100:
            keep = sorted(self.requests.items(), key=lambda kv: kv[1].get("ts", 0), reverse=True)[:100]
            self.requests = dict(keep)
        self.store.put_kv("scene_requests", self.requests)

    def list_requests(self) -> list[dict[str, Any]]:
        return [
            {"id": rid, **info}
            for rid, info in sorted(self.requests.items(), key=lambda kv: kv[1].get("ts", 0), reverse=True)
        ]

    def request_state(self, rid: str) -> dict[str, Any] | None:
        return self.requests.get(rid)

    def list_jobs(self) -> list[dict[str, Any]]:
        return [public(j) for j in sorted(self.jobs.values(), key=lambda j: j.get("startedAt", 0), reverse=True)]

    def set_llm(self, llm: dict[str, Any]) -> None:
        self.llm = {**self.llm, **llm}

    # ---------- 提交 ----------
    def create(self, spec: dict[str, Any]) -> dict[str, Any]:
        kind = _sanitize(str(spec.get("kind") or "scene"), "scene")
        seed = _sanitize(str(spec.get("seed") or ""), "")
        if not seed:
            seed = f"{int(time.time()) % 100000}"
        base = f"{kind}-{seed}"
        job_id = base
        n = 2
        while job_id in self.jobs or (self.root / job_id).exists():
            job_id = f"{base}-{n}"
            n += 1
        job = {
            "id": job_id,
            "name": str(spec.get("name") or job_id).strip()[:40],
            "kind": kind,
            "seed": seed,
            "note": str(spec.get("note") or "")[:200],
            "distance": spec.get("distance"),
            "state": "queued",
            "stage": "排队",
            "startedAt": int(time.time() * 1000),
            "logTail": "",
        }
        self.jobs[job_id] = job
        (self.root / job_id).mkdir(parents=True, exist_ok=True)
        self._save()
        return job

    def submit(self, spec: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
        """同步前置检查；通过后返回任务，由调用方 create_task 执行。"""
        toolchain = find_toolchain()
        if toolchain is None:
            return None, "地图工具链缺失：需要 docs/MAP-SCENE-DESIGN.md 与 scripts/（可设 DHVW_MAP_TOOLCHAIN）"
        pi = find_pi()
        if pi is None:
            return None, "找不到 pi CLI（可设 PI_BIN 指向 pi.exe）"
        py = find_map_python()
        if py is None:
            return None, "找不到带 PIL+numpy 的 Python（可设 DHVW_MAP_PYTHON）"
        if not self.llm.get("apiKey"):
            return None, "LLM 密钥未配置，先在「配置 → 设置」保存密钥"
        job = self.create(spec)
        job["_toolchain"] = str(toolchain)
        job["_pi"] = pi
        job["_python"] = py
        return job, None

    def submit_request(self, request: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
        """设备侧 sceneRequests 的一条 pending → 作业。同一条请求只处理一次。"""
        rid = str(request.get("id") or "").strip()
        if not rid:
            return None, "sceneRequest 缺 id"
        seen = self.requests.get(rid)
        if seen:
            return None, f"该请求已处理（{seen.get('state')}）"
        spec = request.get("mapSpec") if isinstance(request.get("mapSpec"), dict) else {}
        if not spec:
            self.requests[rid] = {"state": "failed", "reason": "缺少 mapSpec", "ts": int(time.time() * 1000)}
            self._save_requests()
            return None, "缺少 mapSpec"
        merged = {**spec}
        reason = str(request.get("reason") or "").strip()
        if reason:
            merged["note"] = f"设备请求原因：{reason}"[:200]
        job, err = self.submit(merged)
        if job is None:
            self.requests[rid] = {"state": "failed", "reason": err, "ts": int(time.time() * 1000)}
            self._save_requests()
            return None, err
        job["request"] = rid
        self.requests[rid] = {"state": "running", "job": job["id"], "ts": int(time.time() * 1000)}
        self._save_requests()
        return job, None

    def mark_request(self, rid: str, state: str, **extra: Any) -> None:
        if not rid:
            return
        entry = {**self.requests.get(rid, {}), "state": state, "ts": int(time.time() * 1000), **extra}
        self.requests[rid] = entry
        self._save_requests()

    async def run(self, job: dict[str, Any]) -> None:
        job_id = job["id"]
        workdir = self.root / job_id
        toolchain = Path(job.pop("_toolchain"))
        pi = job.pop("_pi")
        py = job.pop("_python")
        job["state"] = "running"
        job["stage"] = "拉起 agent"
        self._save()

        self._write_models_json()
        prompt = self._prompt(job, toolchain, py, workdir)
        env = dict(os.environ)
        env["HOME"] = str(self.home)
        env["USERPROFILE"] = str(self.home)
        env.pop("ELECTRON_RUN_AS_NODE", None)

        args = [
            pi,
            "-p",
            "--mode",
            "json",
            "--provider",
            "dhvw",
            "--model",
            str(self.llm.get("model") or ""),
            "--skill",
            str(toolchain / "docs/MAP-SCENE-DESIGN.md"),
            prompt,
        ]
        log_buf: list[str] = []

        def tail(extra: str) -> None:
            log_buf.append(extra)
            text = "".join(log_buf)
            job["logTail"] = text[-LOG_TAIL:]

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=str(workdir),
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                # pi 的 --mode json 单行可以超 64 KiB，默认 stream limit 会直接抛 ValueError
                limit=8 * 1024 * 1024,
            )
            job["stage"] = "agent 生成中"
            self._save()

            async def pump() -> None:
                assert proc.stdout is not None
                while True:
                    chunk = await proc.stdout.read(65536)
                    if not chunk:
                        break
                    tail(chunk.decode("utf-8", "replace"))
                    self._save()

            try:
                await asyncio.wait_for(asyncio.gather(pump(), proc.wait()), timeout=JOB_TIMEOUT)
            except asyncio.TimeoutError:
                proc.kill()
                raise RuntimeError(f"agent 超时（{JOB_TIMEOUT}s）") from None
            warnings: list[str] = []
            if proc.returncode != 0:
                # agent 进程可能在上报结果后崩（端点流式报错）；产物齐不齐以收包闸门为准
                warnings.append(f"agent 退出码 {proc.returncode}，产物仍按闸门判定")

            job["stage"] = "收包校验"
            self._save()
            spec_file = workdir / f"{job_id}.map.json"
            if not spec_file.is_file():
                raise RuntimeError(f"agent 未产出 {spec_file.name}")
            missing = [f for f in REQUIRED if not (workdir / f).is_file()]
            if missing:
                raise RuntimeError("缺件：" + "、".join(missing))
            code, out = await self._run_script(py, toolchain / "scripts/validate_scene.py", workdir)
            if code != 0:
                raise RuntimeError("validate_scene 未通过：" + out.strip()[-600:])

            job["state"] = "done"
            job["stage"] = "已完成" if not warnings else "已完成（有告警）"
            job["finishedAt"] = int(time.time() * 1000)
            job["error"] = None
            job["warnings"] = warnings or None
            self._save()
            self.mark_request(job.get("request") or "", "done", job=job_id)
            # 设备的 sceneRequests 以它自己的 id 为准；纯 PC 提交的任务用作业 id 兜底
            await self.push(
                "scene:ready",
                {"id": job.get("request") or job_id, "job": job_id, "path": str(workdir), "name": job["name"]},
            )
        except Exception as err:  # 任何失败都如实记录，不留占位
            import traceback

            job["state"] = "failed"
            job["stage"] = "失败"
            job["finishedAt"] = int(time.time() * 1000)
            job["error"] = str(err)
            tail(f"\n[job] {err}\n{traceback.format_exc()}\n")
            from .__main__ import log

            log("error", "场景作业失败", job=job_id, error=str(err), trace=traceback.format_exc()[-1500:])
            self.mark_request(job.get("request") or "", "failed", job=job_id, reason=str(err)[:300])
            self._save()

    async def _run_script(self, py: str, script: Path, workdir: Path) -> tuple[int, str]:
        proc = await asyncio.create_subprocess_exec(
            py,
            str(script),
            str(workdir),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await proc.communicate()
        return proc.returncode or 0, out.decode("utf-8", "replace")

    def _write_models_json(self) -> None:
        target = self.home / ".pi/agent/models.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        base = str(self.llm.get("baseUrl") or "").rstrip("/")
        if not base.endswith("/v1"):
            base = base + "/v1" if base and not base.endswith("/v1") else base
        payload = {
            "providers": {
                "dhvw": {
                    "api": "openai-completions",
                    "baseUrl": base,
                    "apiKey": str(self.llm.get("apiKey") or ""),
                    # codex.mintcat.work 不认 developer 角色与 reasoning_effort
                    "compat": {"supportsDeveloperRole": False, "supportsReasoningEffort": False},
                    "models": [{"id": str(self.llm.get("model") or "")}],
                }
            }
        }
        target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def _prompt(self, job: dict[str, Any], toolchain: Path, py: str, workdir: Path) -> str:
        spec_file = f"{job['id']}.map.json"
        dist = f"{job['id']}/dist"
        lines = [
            "你在为 DHVW 设备生成一张【连续地图】场景包。严格按 skill 文档 docs/MAP-SCENE-DESIGN.md 的",
            "§2 数据模型、§3 预设场景、§13.4 包结构、§15 交付标准执行。只允许通过 Python 工具链出图，",
            "不要手写像素、不要在 dist/ 里伪造文件。",
            "",
            f"工具链根：{toolchain}",
            f"Python（含 PIL/numpy）：{py}",
            f"工作目录（当前）：{workdir}",
            f"要写的 spec：{spec_file}",
            "",
            "参考 schema（直接读，字段名照抄）：",
            f"  {toolchain / 'assets/scenes/home/home.map.json'}",
            "",
            "场景参数：",
            f"  kind={job['kind']}  name={job['name']}  seed={job['seed']}",
        ]
        if job.get("distance") not in (None, ""):
            lines.append(f"  distance={job['distance']}（室外场景与家的距离，米）")
        if job.get("note"):
            lines.append(f"  额外要求：{job['note']}")
        lines += [
            "",
            "步骤（顺序不可换）：",
            f"  1. 写 {spec_file}：rooms/doors/windows/props/lighting 等按参考 schema；一个场景是一张连续地图，",
            "     不要拆成多张；所有家具不得越出房间或重叠，门内侧留 1 格净空，spawn 必须可走。",
            f"  2. 跑：{py} {toolchain / 'scripts/paint_home.py'} {workdir / spec_file}",
            f"  3. 跑：{py} {toolchain / 'scripts/pack_scene.py'} {workdir / spec_file}",
            f"  4. 跑：{py} {toolchain / 'scripts/validate_scene.py'} {workdir}",
            "  5. 校验不通过就回到第 1 步改 spec，最多重试 5 轮。",
            "",
            f"完成标准：{dist}/ 下同时存在 scene.json、intgrid.bin、terrain.png、furniture.png、",
            "interactions.json、manifest.json，且 validate_scene.py 退出码为 0。",
            "最后一行只输出：SCENE_READY " + str(workdir),
        ]
        return "\n".join(lines)
