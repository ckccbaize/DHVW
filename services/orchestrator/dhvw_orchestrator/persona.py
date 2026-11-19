"""Persona & L0 memory authoring jobs driven by embedded pi CLI + web research."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from .scene import LOG_TAIL, _python_env, _sanitize, find_pi, public, write_pi_models_json
from .store import Store

JOB_TIMEOUT = 600


def _skill_path() -> Path:
    return Path(__file__).resolve().parent / "PERSONA-DESIGN.md"


def _web_search_path() -> Path:
    return Path(__file__).resolve().parent / "web_search.py"


def _orchestrator_pythonpath() -> str:
    # Make `python -m dhvw_orchestrator.web_search` resolve regardless of cwd
    pkg_parent = str(Path(__file__).resolve().parent.parent)
    existing = os.environ.get("PYTHONPATH", "")
    parts = [pkg_parent] + [p for p in existing.split(os.pathsep) if p and p != pkg_parent]
    return os.pathsep.join(parts)


def _normalize_result(raw: dict[str, Any], fallback_name: str, human_name: str) -> dict[str, Any]:
    """Validate and normalize `persona_result.json` produced by the pi agent."""
    card_wrap = raw.get("card") if isinstance(raw.get("card"), dict) else {}
    data = card_wrap.get("data") if isinstance(card_wrap.get("data"), dict) else card_wrap
    if not isinstance(data, dict):
        raise ValueError("persona_result.json 缺少 card.data 对象")

    name = str(data.get("name") or fallback_name).strip()[:60]
    description = str(data.get("description") or "").strip()
    personality = str(data.get("personality") or "").strip()
    scenario = str(data.get("scenario") or "").strip()
    first_mes = str(data.get("first_mes") or "").strip()
    mes_example = str(data.get("mes_example") or "").strip()
    system_prompt = str(data.get("system_prompt") or "").strip()
    post_history = str(data.get("post_history_instructions") or "").strip()
    creator_notes = str(data.get("creator_notes") or "").strip()
    tags = [str(t).strip() for t in (data.get("tags") or []) if str(t).strip()][:12]

    if not name or not description:
        raise ValueError("persona_result.json 缺少角色名或核心描述 description")

    compiled = str(raw.get("compiled_prompt") or "").strip()
    if not compiled:
        raise ValueError("persona_result.json 缺少 compiled_prompt")

    l0_raw = raw.get("l0_memories")
    if not isinstance(l0_raw, list):
        raise ValueError("persona_result.json 缺少 l0_memories 数组")
    l0_memories: list[dict[str, str]] = []
    seen_texts: set[str] = set()
    for item in l0_raw:
        if isinstance(item, str):
            text = item.strip()
            cat = "core"
        elif isinstance(item, dict):
            text = str(item.get("text") or "").strip()
            cat = str(item.get("category") or "core").strip() or "core"
        else:
            continue
        if not text or text in seen_texts:
            continue
        seen_texts.add(text)
        l0_memories.append({"text": text[:240], "category": cat[:32]})
    if len(l0_memories) < 3:
        raise ValueError(f"生成的 L0 核心记忆不足 3 条（当前 {len(l0_memories)} 条）")

    summary = str(raw.get("summary") or "").strip()
    sources_out: list[dict[str, str]] = []
    for s in raw.get("sources") or []:
        if isinstance(s, dict) and (s.get("url") or s.get("title")):
            sources_out.append(
                {
                    "title": str(s.get("title") or s.get("url") or "").strip()[:120],
                    "url": str(s.get("url") or "").strip()[:400],
                }
            )

    l0_out = []
    for item in l0_memories[:12]:
        digest = hashlib.sha1(f"{name}:{item['text']}".encode("utf-8")).hexdigest()[:12]
        l0_out.append(
            {
                "id": f"l0-{digest}",
                "text": item["text"],
                "tier": "L0",
                "importance": 0.95,
                "category": item["category"],
            }
        )

    return {
        "card": {
            "name": name,
            "description": description,
            "personality": personality,
            "scenario": scenario,
            "first_mes": first_mes,
            "mes_example": mes_example,
            "system_prompt": system_prompt,
            "post_history_instructions": post_history,
            "creator_notes": creator_notes,
            "tags": tags,
            "creator": "DHVW Agent",
            "character_version": "1.0",
            "spec": "chara_card_v2",
            "sources": sources_out[:10],
        },
        "compiledPrompt": compiled,
        "l0Memories": l0_out,
        "summary": summary or f"已检索公开资料并生成角色「{name}」与 {len(l0_out)} 条 L0 核心记忆",
        "sources": sources_out[:10],
    }


class PersonaRunner:
    """Manages async web-researched persona + L0 memory authoring jobs."""

    def __init__(self, store: Store, data_dir: Path) -> None:
        self.store = store
        self.root = Path(data_dir) / "persona-jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.home = Path(data_dir) / "agent-home"
        self.llm: dict[str, Any] = {}
        self.jobs: dict[str, dict[str, Any]] = {}
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._load()

    def _load(self) -> None:
        raw = self.store.get_kv("persona_jobs")
        if isinstance(raw, list):
            for job in raw:
                if isinstance(job, dict) and job.get("id"):
                    if job.get("state") in ("queued", "running"):
                        job["state"] = "failed"
                        job["stage"] = "失败（重启中断）"
                        job["finishedAt"] = job.get("finishedAt") or int(time.time() * 1000)
                        job["error"] = "编排器重启，任务中断"
                    self.jobs[job["id"]] = job

    def _save(self) -> None:
        self.store.put_kv("persona_jobs", list(self.jobs.values())[-30:])

    def set_llm(self, llm: dict[str, Any]) -> None:
        self.llm = {**self.llm, **llm}

    @property
    def busy(self) -> bool:
        return any(j.get("state") in ("queued", "running") for j in self.jobs.values())

    def public_job(self, job: dict[str, Any]) -> dict[str, Any]:
        clean = public(job)
        state = str(clean.get("state") or "queued")
        status = "error" if state == "failed" else state
        raw_log = clean.get("logTail") or ""
        log_lines = (
            raw_log
            if isinstance(raw_log, list)
            else [ln for ln in str(raw_log).splitlines() if ln.strip()][-25:]
        )
        return {
            "id": clean.get("id"),
            "query": clean.get("target") or "",
            "humanName": clean.get("humanName") or "主人",
            "extraPrompt": clean.get("styleNote") or "",
            "autoApply": bool(clean.get("autoApply", True)),
            "status": status,
            "stage": clean.get("stage") or "",
            "createdAt": clean.get("startedAt") or 0,
            "startedAt": clean.get("startedAt"),
            "finishedAt": clean.get("finishedAt"),
            "error": clean.get("error"),
            "result": clean.get("result"),
            "logTail": log_lines,
        }

    def list_jobs(self) -> list[dict[str, Any]]:
        return [self.public_job(j) for j in sorted(self.jobs.values(), key=lambda j: j.get("startedAt", 0), reverse=True)]

    def _kill_proc_only(self, proc: asyncio.subprocess.Process | None) -> None:
        if proc is None or proc.returncode is not None:
            return
        try:
            if os.name == "nt" and proc.pid:
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)
            else:
                proc.kill()
        except Exception:
            pass

    def _terminate_job(self, job_id: str) -> None:
        proc = self._procs.pop(job_id, None)
        self._kill_proc_only(proc)
        task = self._tasks.pop(job_id, None)
        if task and not task.done():
            task.cancel()

    def spawn(self, job: dict[str, Any]) -> asyncio.Task[None]:
        task = asyncio.create_task(self.run(job))
        self._tasks[job["id"]] = task
        return task

    def stop_job(self, job_id: str) -> tuple[dict[str, Any] | None, str | None]:
        """暂停/中止正在运行或排队的人设生成任务，保留工作目录与历史记录以便后续重试。"""
        job = self.jobs.get(job_id)
        if not job:
            return None, f"找不到任务：{job_id}"
        if job.get("state") in ("queued", "running"):
            job["state"] = "failed"
            job["stage"] = "已暂停"
            job["error"] = "任务已手动暂停，可随时点击「重试」重新运行或「删除」移除"
            job["finishedAt"] = int(time.time() * 1000)
            job["logTail"] = (str(job.get("logTail") or "") + "\n[job] 已手动暂停\n")[-LOG_TAIL:]
            self._save()
            self._terminate_job(job_id)
        return job, None

    def resume(self, job_id: str) -> tuple[dict[str, Any] | None, str | None]:
        """重启或重试人设生成任务；若任务正在运行，会先中止旧进程再重新执行。"""
        job = self.jobs.get(job_id)
        if not job:
            return None, f"找不到任务：{job_id}"
        if any(
            jid != job_id and j.get("state") in ("queued", "running")
            for jid, j in self.jobs.items()
        ):
            return None, "另有任务正在执行，请先暂停或删除当前运行中的任务"
        pi = find_pi()
        if pi is None:
            return None, "找不到 pi CLI（可设 PI_BIN 指向 pi.exe）"
        if not self.llm.get("apiKey"):
            return None, "LLM 密钥未配置，先在「设置」保存密钥"
        skill = _skill_path()
        if not skill.is_file():
            return None, f"人设规范缺失：{skill}"

        if job.get("state") in ("queued", "running"):
            self._terminate_job(job_id)

        (self.root / job_id).mkdir(parents=True, exist_ok=True)
        job["state"] = "queued"
        job["stage"] = "准备重启"
        job["error"] = None
        job["finishedAt"] = None
        job["startedAt"] = int(time.time() * 1000)
        job.pop("result", None)
        job.pop("warnings", None)
        job["logTail"] = (str(job.get("logTail") or "") + "\n[job] 手动重启/重试任务\n")[-LOG_TAIL:]
        job["_pi"] = pi
        job["_skill"] = str(skill)
        self._save()
        return job, None

    def delete_job(self, job_id: str) -> bool:
        """随时删除人设任务；若任务正在运行或排队，会先强行中止并清理目录。"""
        if job_id not in self.jobs:
            return False
        self.jobs.pop(job_id, None)
        self._terminate_job(job_id)
        self._save()
        shutil.rmtree(self.root / job_id, ignore_errors=True)
        return True

    def submit(self, spec: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
        target = str(spec.get("query") or spec.get("target") or "").strip()
        if not target:
            return None, "请填写要调研/创作的角色名称或设定主题"
        if self.busy:
            return None, "人设 Agent 正在忙碌中，请稍候"
        pi = find_pi()
        if pi is None:
            return None, "找不到 pi CLI（可设 PI_BIN 指向 pi.exe）"
        if not self.llm.get("apiKey"):
            return None, "LLM 密钥未配置，先在「设置」保存密钥"
        skill = _skill_path()
        if not skill.is_file():
            return None, f"人设规范缺失：{skill}"

        slug = _sanitize(target, "persona")
        ts = int(time.time()) % 100000
        job_id = f"persona-{slug}-{ts}"
        n = 2
        while job_id in self.jobs or (self.root / job_id).exists():
            job_id = f"persona-{slug}-{ts}-{n}"
            n += 1

        job: dict[str, Any] = {
            "id": job_id,
            "target": target[:80],
            "humanName": str(spec.get("humanName") or "主人").strip()[:30] or "主人",
            "styleNote": str(spec.get("extraPrompt") or spec.get("styleNote") or "").strip()[:500],
            "referenceUrl": str(spec.get("referenceUrl") or "").strip()[:400],
            "autoApply": bool(spec.get("autoApply", True)),
            "state": "queued",
            "stage": "排队",
            "startedAt": int(time.time() * 1000),
            "logTail": "",
            "_pi": pi,
            "_skill": str(skill),
        }
        self.jobs[job_id] = job
        (self.root / job_id).mkdir(parents=True, exist_ok=True)
        self._save()
        return job, None

    def _prompt(self, job: dict[str, Any], workdir: Path, skill: str) -> str:
        py = sys.executable.replace("\\", "/")
        wd_posix = str(workdir).replace("\\", "/")
        out_path = str(workdir / "persona_result.json").replace("\\", "/")
        local_skill = str(workdir / "PERSONA-DESIGN.md").replace("\\", "/")
        lines = [
            f"请为 DHVW 数字人角色【{job['target']}】撰写完整的酒馆 V2 兼容人设，并同时编写 L0 核心记忆。",
            "",
            f"工作目录（当前）：{wd_posix}",
            f"设计规范文件（已在当前目录准备好）：{local_skill}（原路径：{skill.replace(chr(92), '/')}）",
            f"输出文件（必须写入）：{out_path}",
            f"用户称呼（{{{{user}}}}）：{job['humanName']}",
            "重要约束：规范文件已直接放在当前目录 ./PERSONA-DESIGN.md，严禁执行 `find /` 或全盘目录遍历。",
            "",
            "可用联网检索工具（已复制到当前目录，直接用下方命令运行即可，无需 cd）：",
            f'  1. 搜索角色资料："{py}" ./web_search.py search "{job["target"]}" --limit 6',
            f'  2. 拉取网页正文："{py}" ./web_search.py fetch "<url>"',
        ]
        if job.get("referenceUrl"):
            lines.append(
                f'用户指定了参考链接，请优先拉取阅读："{py}" ./web_search.py fetch "{job["referenceUrl"]}"'
            )
        if job.get("styleNote"):
            lines.append(f"额外风格与设定要求：{job['styleNote']}")
        lines += [
            "",
            "persona_result.json 结构（UTF-8 JSON 对象，顶层键如下）：",
            '  { "card": { "spec": "chara_card_v2", "spec_version": "2.0", "data": {',
            '      "name", "description"(300-700字), "personality", "scenario",',
            '      "first_mes", "mes_example", "system_prompt",',
            '      "post_history_instructions", "creator_notes", "tags": [...] } },',
            '    "compiled_prompt": "第一人称实时语音人设（禁止Markdown和括号动作描写，用真实名字替换占位符）",',
            '    "l0_memories": [ {"text": "15-55字具体锚点记忆", "category": "identity|personality|taboo|preference|relationship|speech"} ], (6-10条)',
            '    "summary": "简述参考来源与设定要点",',
            '    "sources": [ {"title": "...", "url": "https://..."} ] }',
            "",
            "执行步骤（直接按顺序执行，不要花回合搜索目录）：",
            f'  1. 读取 ./PERSONA-DESIGN.md 确认细节，同时运行 `"{py}" ./web_search.py search "{job["target"]}"` 搜索角色设定（必要时用 fetch 读详情页）。',
            f'  2. 直接在当前目录写出 ./persona_result.json，并用 `"{py}"` 验证为合法 UTF-8 JSON、compiled_prompt 无 Markdown/括号动作、l0_memories 含 6-10 条。',
            f"最后一行只输出：PERSONA_READY {out_path}",
        ]
        return "\n".join(lines)

    async def run(self, job: dict[str, Any]) -> None:
        job_id = job["id"]
        workdir = self.root / job_id
        pi = job.pop("_pi")
        skill = job.pop("_skill")
        job["state"] = "running"
        job["stage"] = "拉起人设 Agent（准备联网调研）"
        self._save()

        # 把规范文件与检索脚本复制到工作目录，避免 embeddable python 忽略 PYTHONPATH 或全局搜索
        try:
            shutil.copyfile(skill, workdir / "PERSONA-DESIGN.md")
            ws = _web_search_path()
            if ws.is_file():
                shutil.copyfile(ws, workdir / "web_search.py")
        except Exception:
            pass

        write_pi_models_json(self.home, self.llm)
        env = _python_env(sys.executable)
        env["HOME"] = str(self.home)
        env["USERPROFILE"] = str(self.home)
        env["PYTHONPATH"] = _orchestrator_pythonpath()
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
            skill,
            self._prompt(job, workdir, skill),
        ]
        log_buf: list[str] = []

        def tail(extra: str) -> None:
            if not extra:
                return
            log_buf.append(extra)
            job["logTail"] = "".join(log_buf)[-LOG_TAIL:]

        def handle_event_line(raw_line: str) -> None:
            s = raw_line.strip()
            if not s:
                return
            if not s.startswith("{"):
                tail(s + "\n")
                return
            try:
                evt = json.loads(s)
            except json.JSONDecodeError:
                tail(s[:200] + "\n")
                return
            etype = str(evt.get("type") or "")
            if etype == "tool_execution_start":
                tool = str(evt.get("toolName") or evt.get("tool") or "")
                targs = evt.get("args") if isinstance(evt.get("args"), dict) else {}
                cmd = str(targs.get("command") or targs.get("path") or "")
                line = f"[tool:{tool}] {cmd[:180]}".strip()
                tail(line + "\n")
                if "web_search" in cmd and "fetch" in cmd:
                    job["stage"] = "正在抓取参考网页正文"
                elif "web_search" in cmd:
                    job["stage"] = "正在联网检索角色资料"
                elif "persona_result.json" in cmd or tool in ("write", "edit"):
                    job["stage"] = "正在撰写人设与 L0 记忆"
            elif etype == "tool_execution_end":
                tool = str(evt.get("toolName") or "")
                is_err = bool(evt.get("isError"))
                if is_err:
                    tail(f"[tool:{tool}:error]\n")
            elif etype == "message_end":
                msg = evt.get("message") if isinstance(evt.get("message"), dict) else {}
                if msg.get("role") == "assistant":
                    for blk in msg.get("content") or []:
                        if isinstance(blk, dict) and blk.get("type") == "text":
                            txt = str(blk.get("text") or "").strip()
                            if txt:
                                tail(f"[agent] {txt[:240]}\n")

        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=str(workdir),
                env=env,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                limit=8 * 1024 * 1024,
            )
            self._procs[job_id] = proc

            async def pump() -> None:
                assert proc.stdout is not None
                line_buf = ""
                while True:
                    chunk = await proc.stdout.read(65536)
                    if not chunk:
                        if line_buf and job_id in self.jobs:
                            handle_event_line(line_buf)
                            self._save()
                        break
                    line_buf += chunk.decode("utf-8", "replace")
                    if "\n" not in line_buf:
                        continue
                    parts = line_buf.split("\n")
                    line_buf = parts.pop()
                    for part in parts:
                        handle_event_line(part)
                    if job_id in self.jobs:
                        self._save()

            try:
                await asyncio.wait_for(asyncio.gather(pump(), proc.wait()), timeout=JOB_TIMEOUT)
            except asyncio.TimeoutError:
                self._kill_proc_only(proc)
                raise RuntimeError(f"人设 Agent 超时（{JOB_TIMEOUT}s）") from None

            if job_id not in self.jobs:
                return

            warnings: list[str] = []
            if proc.returncode != 0:
                warnings.append(f"agent 退出码 {proc.returncode}，按产物文件判定")

            out_file = workdir / "persona_result.json"
            if not out_file.is_file():
                raise RuntimeError("agent 未生成 persona_result.json")

            raw = json.loads(out_file.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise RuntimeError("persona_result.json 顶层必须是 JSON 对象")

            result = _normalize_result(raw, job["target"], job["humanName"])
            job["result"] = result
            job["state"] = "done"
            job["stage"] = "已完成" if not warnings else "已完成（有告警）"
            job["finishedAt"] = int(time.time() * 1000)
            job["error"] = None
            job["warnings"] = warnings or None
            self._save()
        except asyncio.CancelledError:
            self._kill_proc_only(self._procs.get(job_id))
            return
        except Exception as err:
            import traceback

            if job_id not in self.jobs:
                return
            job["state"] = "failed"
            job["stage"] = "失败"
            job["finishedAt"] = int(time.time() * 1000)
            job["error"] = str(err)
            tail(f"\n[job] {err}\n{traceback.format_exc()}\n")
            from .__main__ import log

            log("error", "人设作业失败", job=job_id, error=str(err))
            self._save()
        finally:
            self._procs.pop(job_id, None)
            self._tasks.pop(job_id, None)
