"""场景作业：把「生成一张地图」交给嵌入式 agent（pi CLI）+ 地图 skill。

用户口径：一个场景（家、街道……）就是**一张连续地图**，切换靠加载；PC 只产出设备可运行
的场景包（MAP-SCENE-DESIGN §13.4 / §15.1），不渲染、不展示。

链路：
    POST /dhvw/scene ─► 建工作目录 data/scenes/<id>/
                     ─► pi -p --skill docs/MAP-SCENE-DESIGN.md（HOME 隔离，写入 models.json）
                     ─► agent 写 <id>.map.json 并跑 paint_home / pack_scene / validate_scene
                     ─► 编排器自己再跑一次 validate_scene.py 作为收包闸门
                     ─► 通过后交给编排器决定是否推送（手动 / 自动，见 Orchestrator.push_scene）
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
    "dist/light_day.png",
    "dist/interactions.json",
    "dist/character/sheet.png",
    "dist/character/sheet.json",
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
            base = here.parents[up]
            candidates.append(base)
            candidates.append(base / "map-toolchain")
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


def _python_env(cand: str) -> dict[str, str]:
    env = dict(os.environ)
    site_pkg = Path(cand).resolve().parent / "site-packages"
    if site_pkg.is_dir():
        cur = env.get("DHVW_PYTHONPATH", "")
        parts = [p for p in cur.split(os.pathsep) if p]
        if str(site_pkg) not in parts:
            parts.append(str(site_pkg))
            env["DHVW_PYTHONPATH"] = os.pathsep.join(parts)
    return env


def find_map_python() -> str | None:
    """画图脚本需要 PIL + numpy；外壳内嵌运行时可挂 site-packages。"""
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
                env=_python_env(cand),
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
        # 作业完成回调：推不推给设备由编排器按设置决定，runner 不直接发 scene:ready
        self.on_done: Callable[[dict[str, Any]], Awaitable[None]] | None = None
        self.llm: dict[str, Any] = {}
        self.jobs: dict[str, dict[str, Any]] = {}
        # 运行中的 agent 进程：删除任务时要能立即杀掉，不能只把状态改成失败
        self.procs: dict[str, asyncio.subprocess.Process] = {}
        self.cancelled: set[str] = set()
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
        if str(self.llm.get("mode") or "") == "local":
            return None, "本地 LLM 模式不开放地图生成"
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

    def _has_pi_session(self, workdir: Path) -> bool:
        sessions_root = self.home / ".pi" / "agent" / "sessions"
        if not sessions_root.is_dir():
            return False
        slug = "--" + re.sub(r"[^A-Za-z0-9-]+", "-", str(workdir)).strip("-") + "--"
        sdir = sessions_root / slug
        if sdir.is_dir() and any(sdir.glob("*.jsonl")):
            return True
        tail = workdir.name
        return any(d.is_dir() and tail in d.name and any(d.glob("*.jsonl")) for d in sessions_root.iterdir())

    def resume(self, job_id: str) -> tuple[dict[str, Any] | None, str | None]:
        """继续/重试失败或超时的场景任务：保留工作目录与 pi 会话历史接着画。"""
        job = self.jobs.get(job_id)
        if not job:
            return None, f"找不到任务：{job_id}"
        if job.get("state") in ("queued", "running"):
            return None, "任务正在进行中"
        if str(self.llm.get("mode") or "") == "local":
            return None, "本地 LLM 模式不开放地图生成"
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

        workdir = self.root / job_id
        workdir.mkdir(parents=True, exist_ok=True)
        has_session = self._has_pi_session(workdir)
        job["state"] = "queued"
        job["stage"] = "准备续画" if has_session else "准备重试"
        job.pop("error", None)
        job.pop("finishedAt", None)
        job["startedAt"] = int(time.time() * 1000)
        job["_toolchain"] = str(toolchain)
        job["_pi"] = pi
        job["_python"] = py
        job["_continue"] = has_session
        self._save()
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

    def cancel(self, job_id: str) -> None:
        """用户删除任务：先杀 agent 进程，再清掉请求账本；产物目录由调用方删。"""
        self.cancelled.add(job_id)
        proc = self.procs.get(job_id)
        if proc is not None and proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        job = self.jobs.get(job_id)
        rid = str(job.get("request") or "") if job else ""
        if rid:
            self.requests.pop(rid, None)
            self._save_requests()

    def mark_request(self, rid: str, state: str, **extra: Any) -> None:
        if not rid:
            return
        entry = {**self.requests.get(rid, {}), "state": state, "ts": int(time.time() * 1000), **extra}
        self.requests[rid] = entry
        self._save_requests()

    async def run(self, job: dict[str, Any]) -> None:
        job_id = job["id"]
        if job_id in self.cancelled:
            return
        workdir = self.root / job_id
        toolchain = Path(job.pop("_toolchain"))
        pi = job.pop("_pi")
        py = job.pop("_python")
        is_continue = bool(job.pop("_continue", False))
        job["state"] = "running"
        job["stage"] = "续画拉起 agent" if is_continue else "拉起 agent"
        self._save()

        self._write_models_json()
        prompt = (
            self._continue_prompt(job, toolchain, py, workdir)
            if is_continue
            else self._prompt(job, toolchain, py, workdir)
        )
        env = _python_env(py)
        env["HOME"] = str(self.home)
        env["USERPROFILE"] = str(self.home)
        env.pop("ELECTRON_RUN_AS_NODE", None)

        args = [pi]
        if is_continue:
            args.append("--continue")
        args += [
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
            self.procs[job_id] = proc
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
            if job_id in self.cancelled:
                return
            warnings: list[str] = []
            if proc.returncode != 0:
                # agent 进程可能在上报结果后崩（端点流式报错）；产物齐不齐以收包闸门为准
                warnings.append(f"agent 退出码 {proc.returncode}，产物仍按闸门判定")

            job["stage"] = "收包校验"
            self._save()
            spec_file = workdir / f"{job_id}.map.json"
            if not spec_file.is_file():
                raise RuntimeError(f"agent 未产出 {spec_file.name}")
            expected = REQUIRED + [
                f"dist/{job_id}.built.json",
                f"dist/{job_id}.png",
                f"dist/{job_id}@2x.png",
            ]
            missing = [f for f in expected if not (workdir / f).is_file()]
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
            if self.on_done:
                await self.on_done(job)
        except Exception as err:  # 任何失败都如实记录，不留占位
            if job_id in self.cancelled:
                return
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
        finally:
            self.procs.pop(job_id, None)
            self.cancelled.discard(job_id)

    async def _run_script(self, py: str, script: Path, workdir: Path) -> tuple[int, str]:
        proc = await asyncio.create_subprocess_exec(
            py,
            str(script),
            str(workdir),
            env=_python_env(py),
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
        is_office = job["kind"] == "office"
        is_outdoor = job["kind"] in ("street", "outdoor", "park", "market", "lively")
        ref_schema = (
            toolchain / "assets/scenes/office/office.map.json"
            if is_office
            else toolchain / "assets/scenes/home/home.map.json"
        )
        acts_file = toolchain / "assets/scenes/_shared/acts.json"
        lines = [
            "你在为 DHVW 设备独立创作一张【连续地图】场景包。严格按 skill 文档 docs/MAP-SCENE-DESIGN.md 的",
            "§2 数据模型、§3.6 独立主题创作、§13.4 包结构、§15 交付标准执行，确保最终包 100% 可向 ARM 端交付。",
            "",
            f"工具链根：{toolchain}",
            f"Python（含 PIL/numpy）：{py}",
            f"工作目录（当前）：{workdir}",
            f"要写的 spec：{spec_file}",
            f"spec 的 name 字段必须严格写为：\"{job['id']}\"（与文件名前缀一致，不可改成别的英文名）",
            "",
            "参考 JSON 字段格式（仅作字段结构参考，严禁照搬里面的居家/办公家具清单）：",
            f"  {ref_schema}",
            f"  {acts_file}（仅参考 act 结构；专属物件请在 spec[\"customActs\"] 自定义动作）",
            "",
            "场景参数：",
            f"  kind={job['kind']}  name={job['name']}  seed={job['seed']}",
            "  独立创作与高细节规范：",
            "  1. 地图尺寸由你自主决定：不要套用固定的 24×18 / 32×24，按题材体量自由设定 grid.w × grid.h（建议 14..40 × 10..28，cell=16）。",
            "  2. 禁止复用居家/办公错位物件：严禁在非居家场景塞入 rug / bed / stove / cat_tree / toilet / door_mat 等无关家具。",
            "  3. 地面统一有质感：现代室内优先用 terrazzo（水磨石）/ concrete（微水泥）/ parquet（拼花木）/ marble / tatami；",
            "     不要把大厅切成田字格棋盘或乱条纹！主空间用统一材质，只在真正需要区分的操作区（如吧台内侧）克制使用 zones。",
            "  4. 强烈建议在工作目录编写 custom_painter.py（与 spec 同目录），导出 PROP_SIZES、FURNITURE(draw, gx, gy, w, h)、",
            "     可选 DECOR / WALLPROPS / FLOORS，用 PIL（rounded_rectangle、ellipse、polygon、立体阴影与高光、1px 描边）",
            "     为本场景从 0 绘制高精度专属像素物件；也可结合 spec[\"furnitureDefs\"]（支持 round_rect/ellipse/circle/gradient）。",
            "  5. 在 spec[\"customActs\"] 中为专属物件绑定对应的交互动作（trigger.props 指向专属 prop_id）。",
        ]
        if is_outdoor:
            lines += [
                "  当前为【街道场景（室外）】：在 spec 顶层设置 \"outdoor\": true、\"kind\": \"street\"；",
                "  地面使用 sidewalk / asphalt / cobble / grass / dirt（不要用室内木地板），",
                "  结合 custom_painter.py 自绘主题招牌、店铺立面、摊位、路灯/灯箱与室外绿植，禁止出现室内家具。",
            ]
        else:
            lines += [
                "  当前为【室内场景】：不要设置 outdoor:true；围绕主题规划动线与空间层次，用 custom_painter.py 做出一眼可辨的场景氛围。",
            ]
        if job.get("distance") not in (None, ""):
            lines.append(f"  distance={job['distance']}（室外场景与家的距离，米）")
        if job.get("note"):
            lines.append(f"  额外要求：{job['note']}")
        lines += [
            "",
            "步骤（顺序不可换）：",
            "  0. 不要在思考中逐格推演全部像素/坐标；先快速写出结构清晰的 spec 初稿并落盘，再靠工具报错迭代修正。",
            f"  1. 写 {spec_file}：rooms/zones/doors/windows/props/decor 等按参考 schema；一个场景是一张连续地图，",
            "     不要拆成多张；所有家具不得越出房间或重叠，门内侧留 1 格净空，spawn 必须可走。",
            f"  2. 跑：{py} {toolchain / 'scripts/paint_home.py'} {workdir / spec_file}",
            f"  3. 跑：{py} {toolchain / 'scripts/pack_scene.py'} {workdir / spec_file}",
            f"  4. 跑：{py} {toolchain / 'scripts/validate_scene.py'} {workdir}",
            "  5. 校验不通过就回到第 1 步改 spec，最多重试 5 轮。",
            "",
            f"完成标准：{dist}/ 下同时存在 scene.json、{job['id']}.built.json、{job['id']}.png、{job['id']}@2x.png、",
            "intgrid.bin、terrain.png、furniture.png、light_day.png、interactions.json、character/sheet.png、",
            "character/sheet.json、manifest.json，且 validate_scene.py 退出码为 0。",
            "最后一行只输出：SCENE_READY " + str(workdir),
        ]
        return "\n".join(lines)

    def _continue_prompt(self, job: dict[str, Any], toolchain: Path, py: str, workdir: Path) -> str:
        spec_file = f"{job['id']}.map.json"
        has_spec = (workdir / spec_file).is_file()
        has_dist = (workdir / "dist" / f"{job['id']}.built.json").is_file()
        lines = [
            "上一次生成会话因超时或中断而暂停，现在继续完成这张地图，不要从头重复读取参考文档。",
            f"工作目录：{workdir}；spec 文件：{spec_file}（当前{'已存在' if has_spec else '尚未写入'}）；"
            f"dist 产物（{'已有' if has_dist else '未生成'}）。",
            "要求：",
            "  - 不要在思考中长时间推演全部细节；立刻把可运行的 spec 写入磁盘并跑工具链验证修正。",
            f"  - 依次执行：{py} {toolchain / 'scripts/paint_home.py'} {workdir / spec_file} -> "
            f"{py} {toolchain / 'scripts/pack_scene.py'} {workdir / spec_file} -> "
            f"{py} {toolchain / 'scripts/validate_scene.py'} {workdir}",
            f"  - 确认 {job['id']}/dist 下所有必需文件齐备且 validate_scene.py 退出码为 0。",
            "最后一行只输出：SCENE_READY " + str(workdir),
        ]
        return "\n".join(lines)
