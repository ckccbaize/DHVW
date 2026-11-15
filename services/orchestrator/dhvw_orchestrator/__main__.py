"""编排器服务入口：`python -m dhvw_orchestrator --port 8877`。

对外只有三样东西：
  - `GET /health`（宿主探活）
  - `WS /dhvw`（设备通道，经网关暴露为 `wss://<pc>:8443/ws/orchestrator`）
  - `GET /dhvw/digest`、`GET /dhvw/mood`、`POST /dhvw/config`（外壳/GUI 用，回环）
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse

from . import APP_ID, service_version
from . import actions
from .memory_extract import extract_facts_from_events, extract_facts_from_turns
from .saves import SaveStore
from .scene import SceneRunner
from .store import Store

PROTO = 1
HEARTBEAT_TIMEOUT = 60.0
OVERVIEW_INTERVAL = 5.0
KNOWN_INBOUND = {
    "hello",
    "facts:ack",
    "heartbeat",
    "present:request",
    "present:begin",
    "present:end",
    "events:batch",
    "facts:candidates",
    "memory:push",
    "memory:query",
    "assets:manifest",
    "world:digest",
    "mood:state",
    "pc:action",
    "world:stop",
    "world:resume",
    "wake:state",
    "llm:state",
    "state:save",
    "state:restore:ack",
}


def envelope(type_: str, payload: dict | None = None, reply_to: str | None = None) -> dict:
    msg = {"v": PROTO, "id": uuid.uuid4().hex, "type": type_, "ts": int(time.time() * 1000), "payload": payload or {}}
    if reply_to:
        msg["replyTo"] = reply_to
    return msg


def log(level: str, message: str, **extra: object) -> None:
    line = {"ts": round(time.time(), 3), "level": level, "scope": APP_ID, "message": message, **extra}
    print(json.dumps(line, ensure_ascii=False), flush=True)


class Orchestrator:
    def __init__(self, store: Store) -> None:
        self.store = store
        self.clients: set[WebSocket] = set()
        self.device_id = ""
        self.last_seen = 0.0
        self.connected = False
        self.tier = "idle"
        self.session: str | None = None
        self.digest: dict = store.read_digest()
        self.mood: dict = store.get_kv("mood", {}) or {}
        self.llm: dict = store.get_kv("llm", {}) or {}
        self.tts_ready = bool(store.get_kv("tts_ready", False))
        self.live2d_ready = bool(store.get_kv("live2d_ready", False))
        self.olvt_port = int(store.get_kv("olvt_port", 0) or 0)
        self.gateway_port = int(store.get_kv("gateway_port", 0) or 0)
        self.world_running = True
        self.started = time.time()
        self.saves = SaveStore(store)
        self.scenes = SceneRunner(store, store.root, self._push_scene)
        self.scenes.on_done = self.handle_scene_done
        self.scenes.set_llm(self.llm)
        # 地图推送到设备：auto_push_scene 关时只生成、由人在产出验收里手动提交。
        # scene_pushes 记每条产出的推送状态，未推成功的在设备上线后重试。
        self.auto_push_scene = bool(store.get_kv("auto_push_scene", False))
        self.scene_pushes: dict[str, dict] = store.get_kv("scene_pushes", {}) or {}
        self._last_push_flush = 0.0
        # memory:facts 回流：msg_id -> 本次下发的最大 updated_at，设备 ack 后才推进游标
        self.facts_pending: dict[str, int] = {}
        self.facts_sent_ids: set[str] = set()
        # 档位迁移计数（本次进程内），首页状态机统计表直接读它
        self.tier_transitions: dict[str, int] = {}

    async def _push_scene(self, kind: str, payload: dict) -> None:
        await self.broadcast(kind, payload)

    # ---------- 发送 ----------
    async def send(
        self, ws: WebSocket, type_: str, payload: dict | None = None, reply_to: str | None = None
    ) -> str | None:
        msg = envelope(type_, payload, reply_to)
        try:
            await ws.send_text(json.dumps(msg, ensure_ascii=False))
            return str(msg["id"])
        except Exception as err:  # 连接已断：交给心跳超时处理
            log("warn", "发送失败", type=type_, error=str(err))
            return None

    async def broadcast(self, type_: str, payload: dict | None = None) -> list[str]:
        sent: list[str] = []
        for ws in list(self.clients):
            msg_id = await self.send(ws, type_, payload)
            if msg_id:
                sent.append(msg_id)
        return sent

    # ---------- 状态 ----------
    @staticmethod
    def _weekday(clock: dict) -> tuple[int, str]:
        names = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")
        wd = clock.get("weekday")
        wn = clock.get("weekdayName")
        if isinstance(wd, int) and 1 <= wd <= 7 and isinstance(wn, str) and wn:
            return wd, wn
        iso = datetime.now().isoweekday()
        return iso, names[iso - 1]

    def overview(self) -> dict:
        clock = self.digest.get("clock") or {}
        world = self.digest.get("world") or {}
        wd, wn = self._weekday(clock)
        return {
            "work_tier": self.tier,
            "conn_state": "up" if self.connected else "down",
            "pos_checksum": world.get("pos_checksum") or "n/a",
            "clock": {
                "day": clock.get("day", ""),
                "minute": clock.get("minute", 0),
                "phase": clock.get("phase", ""),
                "weekday": wd,
                "weekdayName": wn,
            },
            "agent": {},
        }

    async def push_facts(self) -> int:
        """把 PC 侧新增/更新的事实增量推给设备；设备 ack 后才推进游标。"""
        since = int(self.store.get_kv("facts_since", 0) or 0)
        facts, upto = self.store.facts_since(since)
        if not facts or not self.clients:
            return 0
        # 已发过且设备还没 ack 的同一条不再重发；新事实照发，避免未回执批次把后续全堵住
        if all(f["id"] in self.facts_sent_ids for f in facts):
            return 0
        summary = "；".join(f["text"] for f in facts[:5])
        payload = {"since": since, "facts": facts, "summary": summary}
        sent = await self.broadcast("memory:facts", payload)
        if not sent:
            return 0
        for msg_id in sent:
            self.facts_pending[msg_id] = upto
        self.facts_sent_ids.update(f["id"] for f in facts)
        log("info", "记忆回流下发", count=len(facts), since=since)
        return len(facts)

    async def consume_scene_requests(self) -> None:
        """设备 digest 里的 pending sceneRequests → 场景作业；同一 id 只做一次。

        设备每 5 s 重发摘要，pending 会反复出现；幂等靠 SceneRunner 的请求账本，
        失败也不自动重试（避免坏 spec 无限烧 token），重试走 /dhvw/scene/retry。
        """
        items = (self.digest or {}).get("sceneRequests")
        if not isinstance(items, list):
            return
        for req in items:
            if not isinstance(req, dict) or str(req.get("status") or "") != "pending":
                continue
            rid = str(req.get("id") or "")
            if not rid or self.scenes.request_state(rid):
                continue
            job, err = self.scenes.submit_request(req)
            if job is None:
                log("warn", "场景请求未受理", request=rid, reason=err)
                continue
            log("info", "受理设备场景请求", request=rid, job=job["id"], kind=job["kind"])
            asyncio.create_task(self.scenes.run(job))

    # ---------- 地图推送到设备 ----------
    def _save_pushes(self) -> None:
        # 只留最近 200 条，避免账本无限长
        if len(self.scene_pushes) > 200:
            keep = sorted(self.scene_pushes.items(), key=lambda kv: kv[1].get("ts", 0), reverse=True)[:200]
            self.scene_pushes = dict(keep)
        self.store.put_kv("scene_pushes", self.scene_pushes)

    def push_state(self, job_id: str) -> dict:
        return dict(self.scene_pushes.get(job_id) or {})

    def _scene_meta(self, job_id: str) -> dict:
        """推送载荷里给设备用的名称/类型/距离；拿不到就不编。"""
        job = self.scenes.jobs.get(job_id) or {}
        dist = self.scenes.root / job_id / "dist"
        name = str(job.get("name") or job_id)
        title = ""
        for cand in (dist / f"{job_id}.built.json", *sorted(dist.glob("*.built.json"))[:1], dist / "scene.json"):
            if not cand.is_file():
                continue
            try:
                data = json.loads(cand.read_text(encoding="utf-8"))
            except Exception:
                continue
            if isinstance(data, dict) and (data.get("title") or data.get("name")):
                title = str(data.get("title") or data.get("name"))
                break
        if title:
            name = title
        kind = str(job.get("kind") or "")
        if kind not in ("street", "indoor"):
            kind = "street" if job_id.startswith(("street-", "outdoor-", "city-")) else "indoor"
        meta: dict = {"name": name, "kind": kind}
        distance = job.get("distance")
        if isinstance(distance, (int, float)):
            meta["distance"] = distance
        return meta

    def verify_scene_package(self, job_id: str) -> tuple[bool, str, list[str]]:
        """资源核验：必需文件齐全 + manifest 里每个文件在盘上且大小/校验和对得上。"""
        from .scene import REQUIRED

        if not re.fullmatch(r"[A-Za-z0-9_-]+", job_id):
            return False, "invalid_job_id", []
        workdir = self.scenes.root / job_id
        dist = workdir / "dist"
        if not dist.is_dir():
            return False, "没有产出目录（还没有生成或已被删除）", []
        # REQUIRED 里带 dist/ 前缀（与 scene.py 的收包闸门同源）
        missing = [f for f in REQUIRED if not (workdir / f).is_file()]
        if missing:
            return False, "缺件：" + "、".join(missing), []
        manifest_file = dist / "manifest.json"
        try:
            manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        except Exception as err:
            return False, f"manifest.json 读不动：{err}", []
        files = manifest.get("files") if isinstance(manifest, dict) else None
        if not isinstance(files, list) or not files:
            return False, "manifest.json 没有文件清单", []
        rels: list[str] = []
        for item in files:
            rel = str((item or {}).get("path") or "").strip()
            if not rel or ".." in rel:
                return False, f"manifest 里有非法路径：{rel or '(空)'}", []
            target = dist / rel
            if not target.is_file():
                return False, f"清单里的文件不存在：{rel}", []
            want_size = item.get("size")
            if isinstance(want_size, int) and target.stat().st_size != want_size:
                return False, f"文件大小与清单不符：{rel}", []
            want_hash = str(item.get("sha256") or "").strip().lower()
            if want_hash:
                digest = hashlib.sha256(target.read_bytes()).hexdigest()
                if digest != want_hash:
                    return False, f"文件校验和不符：{rel}", []
            rels.append(rel)
        if "manifest.json" not in rels:
            rels.append("manifest.json")
        return True, "", rels

    async def push_scene(self, job_id: str, reason: str) -> dict:
        """把一条产出推给设备（scene:ready）。投递成功才记 pushed，离线保持 pending 等重试。"""
        ok, err, rels = await asyncio.to_thread(self.verify_scene_package, job_id)
        if not ok:
            return {"ok": False, "job": job_id, "error": err, "state": "failed"}
        meta = self._scene_meta(job_id)
        payload = {
            "sceneId": job_id,
            "job": job_id,
            "basePath": f"/dhvw/scenes/{job_id}/dist",
            "manifestUrl": f"/dhvw/scenes/{job_id}/dist/manifest.json",
            "gatewayBasePath": f"/orchestrator/dhvw/scenes/{job_id}/dist",
            "gatewayManifestUrl": f"/orchestrator/dhvw/scenes/{job_id}/dist/manifest.json",
            "name": meta["name"],
            "kind": meta["kind"],
            "files": len(rels),
            "t_server": int(time.time() * 1000),
        }
        if "distance" in meta:
            payload["distance"] = meta["distance"]
        sent = len(await self.broadcast("scene:ready", payload))
        prev = self.scene_pushes.get(job_id) or {}
        entry = {
            **prev,
            "state": "pushed" if sent else "pending",
            "reason": reason,
            "attempts": int(prev.get("attempts", 0)) + 1,
            "updatedAt": int(time.time() * 1000),
            "lastError": None if sent else "设备未连接",
            "sent": sent,
            "payload": payload,
        }
        self.scene_pushes[job_id] = entry
        self._save_pushes()
        log(
            "info" if sent else "warn",
            "地图推送",
            job=job_id,
            reason=reason,
            sent=sent,
            attempt=entry["attempts"],
        )
        if not sent:
            return {"ok": False, "job": job_id, "error": "设备未连接，已排队等设备上线重试", "state": "pending"}
        return {"ok": True, "job": job_id, "state": "pushed", "sent": sent}

    async def handle_scene_done(self, job: dict) -> None:
        """闸门通过后的分叉：自动推送开就直接发，关就等人在产出验收里提交。"""
        job_id = str(job.get("id") or "")
        if not job_id:
            return
        prev = self.scene_pushes.get(job_id) or {}
        if prev.get("state") != "pushed":
            self.scene_pushes[job_id] = {
                **prev,
                "state": "unpushed",
                "reason": "auto" if self.auto_push_scene else "manual-required",
                "updatedAt": int(time.time() * 1000),
                "attempts": int(prev.get("attempts", 0)),
                "lastError": prev.get("lastError"),
            }
            self._save_pushes()
        if self.auto_push_scene:
            await self.push_scene(job_id, "auto")
        else:
            log("info", "地图已产出，等待手动提交", job=job_id)

    async def flush_scene_pushes(self, force: bool = False) -> int:
        """把所有 pending 的推送重发一次；设备每上线/每 15 s 调用一次。"""
        if not self.clients:
            return 0
        now = time.time()
        if not force and now - self._last_push_flush < 15:
            return 0
        self._last_push_flush = now
        pending = [jid for jid, st in self.scene_pushes.items() if st.get("state") == "pending"]
        sent = 0
        for job_id in pending:
            res = await self.push_scene(job_id, "retry")
            if res.get("ok"):
                sent += 1
        if pending:
            log("info", "地图推送重试", pending=len(pending), sent=sent)
        return sent

    async def set_tier(self, value: str) -> None:
        if value == self.tier:
            return
        self.tier = value
        self.tier_transitions[value] = self.tier_transitions.get(value, 0) + 1
        log("info", "档位切换", tier=value)
        await self.broadcast("tier", {"value": value})

    # ---------- 消息 ----------
    async def handle(self, ws: WebSocket, msg: dict) -> None:
        msg_id = msg.get("id") if isinstance(msg.get("id"), str) else None
        if msg.get("v") != PROTO:
            await self.send(ws, "error", {"code": "bad_version", "msg": f"v 必须为 {PROTO}"}, msg_id)
            return
        type_ = msg.get("type")
        payload = msg.get("payload")
        if not isinstance(type_, str) or not isinstance(payload, dict):
            await self.send(ws, "error", {"code": "bad_payload", "msg": "缺 type 或 payload 不是对象"}, msg_id)
            return
        if type_ not in KNOWN_INBOUND:
            await self.send(ws, "error", {"code": "bad_type", "msg": f"未知 type: {type_}"}, msg_id)
            return

        if type_ == "facts:ack":
            reply_to = msg.get("replyTo")
            if isinstance(reply_to, str) and reply_to in self.facts_pending:
                upto = self.facts_pending.pop(reply_to)
                self.store.put_kv("facts_since", upto)
                log("info", "设备确认记忆回流", since=upto)
            return

        if type_ == "hello":
            self.device_id = str(payload.get("uuid") or payload.get("client_uid") or payload.get("id") or "device")
            self.connected = True
            self.last_seen = time.time()
            log("info", "设备握手", device=self.device_id, proto=payload.get("proto"))
            await self.send(
                ws,
                "hello",
                {
                    "host_id": APP_ID,
                    "t_server": int(time.time() * 1000),
                    "tts": self.tts_ready,
                    "live2d": self.live2d_ready,
                    "olvt_port": self.olvt_port,
                    "gateway_port": self.gateway_port,
                    "world_tier": self.tier,
                    "agent": {},
                },
                msg_id,
            )
            if self.llm.get("baseUrl") and self.llm.get("model"):
                await self.send(ws, "llm:config", self.llm_payload(), msg_id)
            await self.send(ws, "digest:get", {})
            await self.send(ws, "mood:get", {})
            # 设备一上线就请求一份完整存档；PC 侧自动留一份最近备份
            await self.send(ws, "state:export", {"reason": "connect"})
            # 新连接要能拿到未确认的积压，即使本进程此前已经发过
            self.facts_sent_ids.clear()
            await self.push_facts()
            # 离线期间没推成功的地图，设备一上线就补推
            await self.flush_scene_pushes(force=True)
            return

        # 心跳与其余消息都算「设备活着」
        self.last_seen = time.time()
        self.connected = True

        if type_ == "heartbeat":
            return

        if type_ == "events:batch":
            result = self.store.add_events(list(payload.get("events") or []))
            if result["seq"]:
                await self.send(ws, "events:ack", {"seq": result["seq"]}, msg_id)
            log("info", "事件入库", inserted=result["inserted"], duplicated=result["duplicated"], seq=result["seq"])
            return

        if type_ == "facts:candidates":
            result = self.store.upsert_facts(list(payload.get("facts") or []), src="device")
            await self.send(ws, "facts:ack", result, msg_id)
            log("info", "事实入库", accepted=len(result["accepted"]), merged=len(result["merged"]), rejected=len(result["rejected"]))
            return

        if type_ == "memory:push":
            facts = list(payload.get("facts") or [])
            events = list(payload.get("events") or [])
            result = self.store.upsert_facts(facts, src="device") if facts else {"accepted": [], "merged": [], "rejected": []}
            if events:
                self.store.add_events(events)
            self.store.put_kv("context", {k: payload.get(k) for k in ("mood", "phase", "weather", "place", "since")})
            if facts:
                await self.send(ws, "facts:ack", result, msg_id)
            return

        if type_ == "memory:query":
            text = str(payload.get("text") or "")
            k = int(payload.get("k") or 8)
            started = time.perf_counter()
            hits, semantic = self.store.search_hybrid(text, k)
            elapsed = round((time.perf_counter() - started) * 1000, 1)
            await self.send(ws, "memory:result", {"req_id": payload.get("req_id"), "hits": hits, "semantic": semantic}, msg_id)
            log("info", "记忆检索", req=payload.get("req_id"), hits=len(hits), ms=elapsed, semantic=semantic)
            return

        if type_ == "state:save":
            try:
                meta = self.saves.put(payload.get("save"), str(payload.get("reason") or "auto"))
            except ValueError as err:
                await self.send(ws, "error", {"code": "bad_save", "msg": str(err)}, msg_id)
                return
            await self.send(ws, "state:saved", meta, msg_id)
            log("info", "设备存档备份", id=meta["id"], reason=meta["reason"], bytes=meta["bytes"])
            return

        if type_ == "state:restore:ack":
            log("info", "设备确认存档恢复", id=payload.get("id"), ok=payload.get("ok"))
            return

        if type_ == "world:digest":
            digest = payload.get("digest")
            if isinstance(digest, dict):
                self.digest = digest
                self.store.write_digest(digest)
                await self.consume_scene_requests()
            return

        if type_ == "mood:state":
            self.mood = payload
            self.store.put_kv("mood", payload)
            return

        if type_ == "present:request":
            await self.present_request(ws, msg_id)
            return

        if type_ == "present:begin":
            self.session = str(payload.get("session_id") or "")
            self.store.begin_session(self.session)
            await self.set_tier("host")
            log("info", "显现开始", session=self.session)
            return

        if type_ == "present:end":
            session = str(payload.get("session_id") or self.session or "")
            self.store.end_session(session)
            self.session = None
            await self.set_tier("idle")
            log("info", "显现结束", session=session)
            return

        if type_ == "pc:action":
            await self.run_action(ws, msg_id, payload)
            return

        if type_ == "assets:manifest":
            self.store.put_kv("assets", payload.get("assets") or [])
            return

        if type_ == "world:stop":
            self.world_running = False
            self.store.put_kv("world_running", False)
            return

        if type_ == "world:resume":
            self.world_running = True
            self.store.put_kv("world_running", True)
            return

        if type_ in ("wake:state", "llm:state"):
            self.store.put_kv(type_, payload)
            return

    async def present_request(self, ws: WebSocket, msg_id: str | None) -> None:
        if self.session:
            await self.send(ws, "present:deny", {"reason": "已在显现"}, msg_id)
            return
        if not self.tts_ready:
            await self.send(ws, "present:deny", {"reason": "语音（TTS）未就绪"}, msg_id)
            log("warn", "拒绝显现", reason="tts_not_ready")
            return
        await self.send(ws, "present:grant", {}, msg_id)
        log("info", "允许显现")

    async def run_action(self, ws: WebSocket, msg_id: str | None, payload: dict) -> None:
        action_id = str(payload.get("id") or "")
        action = str(payload.get("action") or "")
        args = payload.get("args") if isinstance(payload.get("args"), dict) else {}
        if not action_id:
            await self.send(ws, "pc:action:ack", {"id": action_id, "ok": False, "result": {"reason": "缺 id"}}, msg_id)
            return
        if action == "map.generate":
            job, reason = self.scenes.submit(args)
            if job is None:
                ok, result = False, {"reason": reason}
            else:
                asyncio.create_task(self.scenes.run(job))
                ok, result = True, {"job": job["id"], "dir": str(self.scenes.root / job["id"])}
            self.store.record_action(action_id, action, args, ok, result)
            await self.send(ws, "pc:action:ack", {"id": action_id, "ok": ok, "result": result}, msg_id)
            log("info" if ok else "warn", "PC 动作", action=action, ok=ok, result=result)
            return
        try:
            ok, result = await asyncio.to_thread(actions.run, action, args)
        except Exception as err:
            ok, result = False, {"reason": f"执行异常：{err}"}
        self.store.record_action(action_id, action, args, ok, result)
        await self.send(ws, "pc:action:ack", {"id": action_id, "ok": ok, "result": result}, msg_id)
        log("info" if ok else "warn", "PC 动作", action=action, ok=ok, result=result)

    # ---------- 配置下发 ----------
    def llm_payload(self) -> dict:
        return {
            "baseUrl": self.llm.get("baseUrl"),
            "apiKey": self.llm.get("apiKey"),
            "model": self.llm.get("model"),
            "timeoutMs": self.llm.get("timeoutMs"),
            "maxAttempts": self.llm.get("maxAttempts"),
            "retryBaseMs": self.llm.get("retryBaseMs"),
        }

    async def apply_config(self, cfg: dict) -> dict:
        if "tts" in cfg:
            self.tts_ready = bool(cfg["tts"])
            self.store.put_kv("tts_ready", self.tts_ready)
        if "live2d" in cfg:
            self.live2d_ready = bool(cfg["live2d"])
            self.store.put_kv("live2d_ready", self.live2d_ready)
        if "olvtPort" in cfg:
            self.olvt_port = int(cfg["olvtPort"] or 0)
            self.store.put_kv("olvt_port", self.olvt_port)
        if "gatewayPort" in cfg:
            self.gateway_port = int(cfg["gatewayPort"] or 0)
            self.store.put_kv("gateway_port", self.gateway_port)
        if "boost" in cfg:
            # 界面层开关：只持久化与回显，不改变生产行为
            self.store.put_kv("boost", bool(cfg["boost"]))
        if "autoPushScene" in cfg:
            # 地图自动推送：关 = 必须人工在产出验收里提交；开 = 闸门通过即推
            self.auto_push_scene = bool(cfg["autoPushScene"])
            self.store.put_kv("auto_push_scene", self.auto_push_scene)
            log("info", "地图自动推送", enabled=self.auto_push_scene)
        llm = cfg.get("llm")
        if isinstance(llm, dict) and llm.get("baseUrl"):
            merged = {**self.llm, **{k: v for k, v in llm.items() if v is not None}}
            self.llm = merged
            self.store.put_kv("llm", merged)
            self.scenes.set_llm(self.llm)
            await self.broadcast("llm:config", self.llm_payload())
            log("info", "下发 LLM 配置", baseUrl=merged.get("baseUrl"), model=merged.get("model"))
        return {
            "ok": True,
            "tts": self.tts_ready,
            "live2d": self.live2d_ready,
            "llm": bool(self.llm.get("model")),
            "autoPushScene": self.auto_push_scene,
        }

    async def overview_loop(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            try:
                if self.clients:
                    if self.connected and time.time() - self.last_seen > HEARTBEAT_TIMEOUT:
                        self.connected = False
                        log("warn", "设备心跳超时，判离线", device=self.device_id)
                        await self.set_tier("idle")
                await asyncio.sleep(OVERVIEW_INTERVAL - 0.5)
                if self.clients:
                    await self.broadcast("state:overview", self.overview())
                    # 30 s 一次兜底：PC 侧新写的事实即使没走端点也能尽快回流
                    if int(time.time() - self.started) % 30 < OVERVIEW_INTERVAL:
                        await self.push_facts()
                    await self.flush_scene_pushes()
            except Exception as err:  # 循环不能死
                log("error", "状态循环异常", error=str(err))


def create_app(store: Store, orch: Orchestrator) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        task = asyncio.create_task(orch.overview_loop())
        log("info", "编排器就绪", data=str(store.root), memory=store.memory_count())
        try:
            yield
        finally:
            task.cancel()

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict:
        return {
            "ok": True,
            "service": APP_ID,
            "version": service_version(),
            "pid": os.getpid(),
            "uptime": round(time.time() - orch.started, 1),
            "device": {"connected": orch.connected, "id": orch.device_id, "tier": orch.tier},
            "digest_ts": (orch.digest or {}).get("ts", 0),
            "facts_since": store.get_kv("facts_since", 0),
            "memory": store.memory_count(),
        }

    @app.get("/dhvw/digest")
    async def digest() -> JSONResponse:
        return JSONResponse(orch.digest)

    @app.get("/dhvw/mood")
    async def mood() -> JSONResponse:
        return JSONResponse(orch.mood)

    @app.post("/dhvw/display")
    async def display_set(request: Request) -> JSONResponse:
        """设备显示态二切（总观 / 显现）：PC 只发指令，实际画面在设备上。

        这是对设备契约的新增下行消息 `display:set {state}`；设备固件尚未实现时它会被忽略，
        因此返回值只报「已投递到几条连接」，是否生效以设备回传的 digest.world.display 为准。
        """
        body = await request.json()
        state = body.get("state") if isinstance(body, dict) else None
        if state not in ("overview", "present"):
            return JSONResponse({"ok": False, "error": "state 必须是 overview 或 present"}, status_code=400)
        delivered = len(
            await orch.broadcast(
                "display:set",
                {
                    "state": state,
                    "t_server": int(time.time() * 1000),
                    "olvt_port": orch.olvt_port,
                    "gateway_port": orch.gateway_port,
                },
            )
        )
        log("info", "下发显示态", state=state, delivered=delivered)
        if delivered == 0:
            return JSONResponse({"ok": False, "delivered": 0, "error": "设备未连接"})
        return JSONResponse({"ok": True, "delivered": delivered, "state": state})

    def _list_scene_outputs(root: Path) -> list[dict[str, object]]:
        if not root.is_dir():
            return []
        items: list[dict[str, object]] = []
        for entry in root.iterdir():
            if not entry.is_dir():
                continue
            dist_dir = entry / "dist"
            if not dist_dir.is_dir():
                continue
            built_files = sorted(dist_dir.glob("*.built.json"))
            if not built_files:
                continue
            preferred = dist_dir / f"{entry.name}.built.json"
            built_file = preferred if preferred.is_file() else built_files[0]
            info: dict[str, object] = {
                "id": entry.name,
                "name": entry.name,
                "updatedAt": int(built_file.stat().st_mtime * 1000),
            }
            try:
                built = json.loads(built_file.read_text(encoding="utf-8"))
                if isinstance(built, dict):
                    info["name"] = str(built.get("title") or built.get("name") or entry.name)
                    if built.get("kind"):
                        info["kind"] = str(built["kind"])
                    rows = built.get("intGrid")
                    if isinstance(rows, list) and rows and isinstance(rows[0], str):
                        info["grid"] = f"{len(rows[0])}×{len(rows)}"
                    props = built.get("props")
                    if isinstance(props, list):
                        info["hotspots"] = len(props)
            except Exception:
                pass
            inter_file = dist_dir / "interactions.json"
            if inter_file.is_file():
                try:
                    inter = json.loads(inter_file.read_text(encoding="utf-8"))
                    acts = inter.get("acts") if isinstance(inter, dict) else None
                    if isinstance(acts, (dict, list)):
                        info["acts"] = len(acts)
                except Exception:
                    pass
            items.append(info)
        items.sort(key=lambda x: int(x.get("updatedAt") or 0), reverse=True)
        return items

    @app.get("/dhvw/saves")
    async def saves_list() -> JSONResponse:
        return JSONResponse({"ok": True, "saves": orch.saves.list()})

    @app.post("/dhvw/saves/backup")
    async def saves_backup() -> JSONResponse:
        """让在线设备立刻上报一份存档；设备回 state:save 后自动落盘。"""
        if not orch.clients:
            return JSONResponse({"ok": False, "error": "设备未连接"}, status_code=409)
        ids = await orch.broadcast("state:export", {"reason": "manual"})
        return JSONResponse({"ok": True, "requested": len(ids)})

    @app.get("/dhvw/saves/{save_id}", response_model=None)
    async def saves_download(save_id: str) -> FileResponse | JSONResponse:
        path = orch.saves.path(save_id)
        if path is None:
            return JSONResponse({"ok": False, "error": "找不到存档"}, status_code=404)
        return FileResponse(path, media_type="application/json", filename=f"{save_id}.json")

    @app.post("/dhvw/saves/{save_id}/restore")
    async def saves_restore(save_id: str) -> JSONResponse:
        save = orch.saves.read(save_id)
        if save is None:
            return JSONResponse({"ok": False, "error": "找不到存档"}, status_code=404)
        if not orch.clients:
            return JSONResponse({"ok": False, "error": "设备未连接"}, status_code=409)
        ids = await orch.broadcast("state:restore", {"id": save_id, "save": save})
        log("info", "下发存档恢复", id=save_id, sent=len(ids))
        return JSONResponse({"ok": True, "sent": len(ids)})

    @app.delete("/dhvw/saves/{save_id}")
    async def saves_delete(save_id: str) -> JSONResponse:
        if not orch.saves.delete(save_id):
            return JSONResponse({"ok": False, "error": "找不到存档"}, status_code=404)
        return JSONResponse({"ok": True})

    @app.get("/dhvw/scenes")
    async def scenes_list() -> JSONResponse:
        return JSONResponse(
            {
                "ok": True,
                "jobs": orch.scenes.list_jobs(),
                "requests": orch.scenes.list_requests(),
                "outputs": [
                    {**item, "push": orch.push_state(str(item["id"]))}
                    for item in _list_scene_outputs(orch.scenes.root)
                ],
                "autoPush": orch.auto_push_scene,
            }
        )

    @app.post("/dhvw/scenes/{job_id}/push")
    async def scene_push(job_id: str) -> JSONResponse:
        """手动把一条产出推给设备（产出验收里的「提交 ARM 侧」）。"""
        res = await orch.push_scene(job_id, "manual")
        if res.get("ok"):
            return JSONResponse(res)
        # 核验失败是 400；设备离线是 409（已排队，等上线重试）
        code = 400 if res.get("state") == "failed" else 409
        return JSONResponse(res, status_code=code)

    @app.get("/dhvw/scenes/{job_id}/dist/{file_path:path}", response_model=None)
    async def scene_dist_file(job_id: str, file_path: str) -> FileResponse | JSONResponse:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", job_id):
            return JSONResponse({"ok": False, "error": "invalid_job_id"}, status_code=400)
        dist_root = (orch.scenes.root / job_id / "dist").resolve()
        if not dist_root.is_dir():
            return JSONResponse({"ok": False, "error": "scene_not_found"}, status_code=404)
        target = (dist_root / file_path).resolve()
        try:
            target.relative_to(dist_root)
        except ValueError:
            return JSONResponse({"ok": False, "error": "forbidden"}, status_code=403)
        if not target.is_file() and file_path == f"{job_id}.built.json":
            built_files = sorted(dist_root.glob("*.built.json"))
            if built_files:
                target = built_files[0]
        if not target.is_file():
            return JSONResponse({"ok": False, "error": "file_not_found"}, status_code=404)
        return FileResponse(target)

    @app.delete("/dhvw/scenes/{job_id}")
    async def scene_delete(job_id: str) -> JSONResponse:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", job_id):
            return JSONResponse({"ok": False, "error": "invalid_job_id"}, status_code=400)
        job = orch.scenes.jobs.get(job_id)
        if job and job.get("state") in ("queued", "running"):
            return JSONResponse({"ok": False, "error": "任务进行中，不能删除"}, status_code=409)
        target_dir = (orch.scenes.root / job_id).resolve()
        try:
            target_dir.relative_to(orch.scenes.root.resolve())
        except ValueError:
            return JSONResponse({"ok": False, "error": "forbidden"}, status_code=403)
        if target_dir.is_dir():
            shutil.rmtree(target_dir, ignore_errors=True)
        if job_id in orch.scenes.jobs:
            orch.scenes.jobs.pop(job_id, None)
            orch.scenes._save()
        log("info", "删除产出地图", job=job_id)
        return JSONResponse({"ok": True, "id": job_id})

    @app.post("/dhvw/scene/retry")
    async def scene_retry(request: Request) -> JSONResponse:
        """重试一条设备场景请求：丢掉旧账本条目后按摘要里的 mapSpec 重提。"""
        body = await request.json()
        rid = str((body or {}).get("id") or "").strip() if isinstance(body, dict) else ""
        if not rid:
            return JSONResponse({"ok": False, "error": "缺 id"}, status_code=400)
        items = (orch.digest or {}).get("sceneRequests")
        req = next(
            (i for i in items or [] if isinstance(i, dict) and str(i.get("id") or "") == rid),
            None,
        )
        if req is None:
            return JSONResponse({"ok": False, "error": "当前摘要里没有这条 sceneRequest"})
        orch.scenes.requests.pop(rid, None)
        job, reason = orch.scenes.submit_request(req)
        if job is None:
            return JSONResponse({"ok": False, "error": reason})
        asyncio.create_task(orch.scenes.run(job))
        log("info", "重试场景请求", request=rid, job=job["id"])
        return JSONResponse({"ok": True, "job": job["id"], "request": rid})

    @app.post("/dhvw/scene/job-retry")
    async def scene_job_retry(request: Request) -> JSONResponse:
        """继续/重试失败或超时的场景生成任务，保留原工作目录与 pi 会话历史。"""
        body = await request.json()
        jid = str((body or {}).get("id") or "").strip() if isinstance(body, dict) else ""
        if not jid:
            return JSONResponse({"ok": False, "error": "缺 id"}, status_code=400)
        job, reason = orch.scenes.resume(jid)
        if job is None:
            return JSONResponse({"ok": False, "error": reason})
        asyncio.create_task(orch.scenes.run(job))
        log("info", "续画重试场景任务", job=job["id"])
        from .scene import public

        return JSONResponse({"ok": True, "job": public(job)})

    @app.post("/dhvw/scene")
    async def scene_create(request: Request) -> JSONResponse:
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse({"ok": False, "error": "bad_payload"}, status_code=400)
        job, reason = orch.scenes.submit(body)
        if job is None:
            return JSONResponse({"ok": False, "error": reason})
        asyncio.create_task(orch.scenes.run(job))
        log("info", "场景任务提交", job=job["id"], kind=job["kind"])
        from .scene import public

        return JSONResponse({"ok": True, "job": public(job)})

    @app.get("/dhvw/stats")
    async def stats() -> JSONResponse:
        """首页状态机统计表的数据源：只用真实收到的数据，拿不到的字段不给。"""
        digest = orch.digest or {}
        agenda = digest.get("agenda") if isinstance(digest.get("agenda"), list) else []
        scenes = digest.get("sceneRequests") if isinstance(digest.get("sceneRequests"), list) else []
        actions = digest.get("pcActions") if isinstance(digest.get("pcActions"), list) else []

        def by_status(items: list) -> dict[str, int]:
            out: dict[str, int] = {}
            for item in items:
                if isinstance(item, dict):
                    key = str(item.get("status") or "unknown")
                    out[key] = out.get(key, 0) + 1
            return out

        day_ago = int(time.time() * 1000) - 24 * 3600 * 1000
        return JSONResponse(
            {
                "ok": True,
                "device": {
                    "connected": orch.connected,
                    "id": orch.device_id,
                    "tier": orch.tier,
                    "last_seen_s": round(time.time() - orch.last_seen, 1) if orch.last_seen else None,
                },
                "digest": {
                    "seq": digest.get("seq", 0),
                    "age_s": round((time.time() * 1000 - digest.get("ts", 0)) / 1000, 1) if digest.get("ts") else None,
                    "clock": digest.get("clock") or {},
                    "agenda": by_status(agenda),
                    "scene_requests": by_status(scenes),
                    "pc_actions": by_status(actions),
                    "behaviors": len(digest.get("behaviors") or []),
                    "event_pool": len(digest.get("eventPool") or {}) if isinstance(digest.get("eventPool"), dict) else 0,
                },
                "tier_transitions": orch.tier_transitions,
                "events_24h": store.events_by_kind(day_ago),
                "mood": {"band": (orch.mood or {}).get("band"), "dims": (orch.mood or {}).get("dims") or {}},
                "memory": store.memory_count(),
                "uptime": round(time.time() - orch.started, 1),
            }
        )

    @app.get("/dhvw/events")
    async def events(limit: int = 20) -> JSONResponse:
        return JSONResponse(store.recent_events(max(1, min(limit, 200))))

    @app.get("/dhvw/actions")
    async def action_help() -> JSONResponse:
        return JSONResponse(actions.describe())

    @app.post("/dhvw/facts")
    async def add_facts(req: Request) -> JSONResponse:
        """PC 侧（OLVT / WakeTrace / GUI）写事实，随即回流给在线设备。"""
        body = await req.json()
        facts = body.get("facts") if isinstance(body, dict) else None
        if not isinstance(facts, list):
            return JSONResponse({"ok": False, "error": "facts 必须是数组"}, status_code=400)
        result = store.upsert_facts(facts, src="pc")
        pushed = await orch.push_facts()
        return JSONResponse({"ok": True, **result, "pushed": pushed})

    @app.post("/dhvw/memory/rebuild")
    async def rebuild_memory() -> JSONResponse:
        """删除并由 mem_meta 正文重建 FTS5 与 vec0 向量索引。"""
        return JSONResponse({"ok": True, **store.rebuild_indexes()})

    @app.post("/dhvw/memory/extract")
    async def extract_memory(req: Request) -> JSONResponse:
        """从显现会话轮次抽取事实，写入 memory.db 向量库并回流到设备深层记忆。"""
        body = await req.json()
        turns = body.get("turns") if isinstance(body, dict) else None
        if not isinstance(turns, list):
            return JSONResponse({"ok": False, "error": "turns 必须是数组"}, status_code=400)
        facts, mood_delta, err = await extract_facts_from_turns(orch.llm, turns)
        if err:
            return JSONResponse({"ok": False, "reason": err, "extracted": 0, "pushed": 0})
        mood_pushed = 0
        if mood_delta:
            sent = await orch.broadcast("mood:delta", {"source": "user", **mood_delta})
            mood_pushed = len(sent)
        if not facts:
            return JSONResponse({"ok": True, "extracted": 0, "accepted": [], "merged": [], "rejected": [], "pushed": 0, "mood_pushed": mood_pushed})
        result = store.upsert_facts(facts, src="pc")
        pushed = await orch.push_facts()
        log("info", "显现记忆抽取", extracted=len(facts), accepted=len(result["accepted"]), pushed=pushed, mood_pushed=mood_pushed)
        return JSONResponse({"ok": True, "extracted": len(facts), **result, "pushed": pushed, "mood_pushed": mood_pushed})

    @app.post("/dhvw/memory/consolidate")
    async def consolidate_events(limit: int = 40) -> JSONResponse:
        """主机空闲期批量归纳 life.db 未处理设备事件，写入向量库并回流设备。"""
        since_seq = int(store.get_kv("events_consolidated_seq", 0) or 0)
        events, max_seq = store.events_since(since_seq, max(3, min(int(limit), 100)))
        if len(events) < 3:
            return JSONResponse({"ok": False, "reason": "not_enough_events", "scanned": len(events), "since_seq": since_seq})
        facts, err = await extract_facts_from_events(orch.llm, events)
        if err:
            return JSONResponse({"ok": False, "reason": err, "scanned": len(events), "since_seq": since_seq})
        result = store.upsert_facts(facts, src="pc") if facts else {"accepted": [], "merged": [], "rejected": []}
        store.put_kv("events_consolidated_seq", max_seq)
        pushed = await orch.push_facts() if facts else 0
        log("info", "事件批量归纳", scanned=len(events), max_seq=max_seq, extracted=len(facts), pushed=pushed)
        return JSONResponse({"ok": True, "scanned": len(events), "max_seq": max_seq, "extracted": len(facts), **result, "pushed": pushed})

    @app.get("/dhvw/memory/stats")
    async def memory_stats() -> JSONResponse:
        return JSONResponse(store.memory_stats())

    def _describe_mood(mood: dict | None) -> str:
        if not isinstance(mood, dict) or not mood:
            return ""
        band_map = {"calm": "平静", "happy": "开心", "excited": "雀跃", "tired": "疲惫", "low": "低落"}
        band = str(mood.get("band") or "").lower()
        dims = mood.get("dims") if isinstance(mood.get("dims"), dict) else {}
        notes: list[str] = []
        if band in band_map:
            notes.append(band_map[band])
        e = dims.get("energy")
        v = dims.get("valence")
        s = dims.get("social")
        f = dims.get("focus")
        if isinstance(e, (int, float)):
            if e < 0.35:
                notes.append("精力偏低")
            elif e > 0.72:
                notes.append("精力充沛")
        if isinstance(v, (int, float)):
            if v < 0.38:
                notes.append("有些低落")
            elif v > 0.62:
                notes.append("心情不错")
        if isinstance(s, (int, float)):
            if s < 0.3:
                notes.append("想找人聊聊")
            elif s > 0.68:
                notes.append("很想倾诉互动")
        if isinstance(f, (int, float)) and f > 0.68:
            notes.append("很专注")
        return "，".join(notes)

    @app.get("/dhvw/memory/context")
    async def memory_context(q: str = "", k: int = 5) -> JSONResponse:
        """供 OLVT 每轮对话前拉取相关向量记忆与设备近况（ADR-PC-004）。"""
        k = max(1, min(int(k), 12))
        hits, semantic = store.search_hybrid(q, k, min_score=0.35, mood=orch.mood) if q.strip() else ([], False)
        l0 = store.get_l0_facts(3)
        hit_ids = {h["id"] for h in hits}
        l0_extra = [f for f in l0 if f["id"] not in hit_ids]
        ctx = store.get_kv("context", {}) or {}
        clock = (orch.digest or {}).get("clock") or {}
        _, weekday_name = orch._weekday(clock)
        lines: list[str] = []
        parts = [p for p in (weekday_name, clock.get("phase"), ctx.get("place"), ctx.get("weather")) if p]
        if parts:
            lines.append("当前状态：" + " / ".join(str(p) for p in parts))
        mood_desc = _describe_mood(orch.mood)
        if mood_desc:
            lines.append(f"当前心情：{mood_desc}")
        if l0_extra:
            lines.append("核心偏好（L0）：")
            for f in l0_extra:
                lines.append(f"- [L0] {f.get('text', '')}")
        if hits:
            lines.append("相关记忆：")
            for h in hits:
                tier = h.get("tier") or "L2"
                lines.append(f"- [{tier}] {h.get('text', '')}")
        block = "\n".join(lines)
        return JSONResponse({"ok": True, "semantic": semantic, "hits": hits, "l0": l0_extra, "context": ctx, "block": block})

    @app.post("/dhvw/config")
    async def config(request: Request) -> JSONResponse:
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse({"ok": False, "error": "bad_payload"}, status_code=400)
        return JSONResponse(await orch.apply_config(body))

    @app.websocket("/dhvw")
    async def device_ws(ws: WebSocket) -> None:
        await ws.accept()
        orch.clients.add(ws)
        peer = f"{ws.client.host}:{ws.client.port}" if ws.client else "?"
        log("info", "设备连接", clients=len(orch.clients), peer=peer)
        await orch.send(
            ws,
            "hello",
            {
                "host_id": APP_ID,
                "t_server": int(time.time() * 1000),
                "tts": orch.tts_ready,
                "live2d": orch.live2d_ready,
                "olvt_port": orch.olvt_port,
                "gateway_port": orch.gateway_port,
                "world_tier": orch.tier,
                "agent": {},
            },
        )
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    await orch.send(ws, "error", {"code": "bad_payload", "msg": "不是合法 JSON"})
                    continue
                if not isinstance(msg, dict):
                    await orch.send(ws, "error", {"code": "bad_payload", "msg": "信封必须是对象"})
                    continue
                await orch.handle(ws, msg)
        except WebSocketDisconnect:
            pass
        finally:
            orch.clients.discard(ws)
            # 以存活连接为准：旧连接的 finally 晚于新连接握手时，不能把在线判成离线
            orch.connected = bool(orch.clients)
            log("info", "设备断开", clients=len(orch.clients), peer=peer)

    return app


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="dhvw_orchestrator")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    ns = parser.parse_args(argv)

    store = Store()
    orch = Orchestrator(store)
    app = create_app(store, orch)
    log("info", "启动编排器", host=ns.host, port=ns.port)
    uvicorn.run(app, host=ns.host, port=ns.port, log_level="warning", ws="auto", access_log=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(argv=__import__("sys").argv[1:]))
