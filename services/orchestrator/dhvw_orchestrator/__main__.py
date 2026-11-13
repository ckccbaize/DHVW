"""编排器服务入口：`python -m dhvw_orchestrator --port 8877`。

对外只有三样东西：
  - `GET /health`（宿主探活）
  - `WS /dhvw`（设备通道，经网关暴露为 `wss://<pc>:8443/ws/orchestrator`）
  - `GET /dhvw/digest`、`GET /dhvw/mood`、`POST /dhvw/config`（外壳/GUI 用，回环）
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from . import APP_ID, service_version
from . import actions
from .store import Store

PROTO = 1
HEARTBEAT_TIMEOUT = 60.0
OVERVIEW_INTERVAL = 5.0
KNOWN_INBOUND = {
    "hello",
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
        self.world_running = True
        self.started = time.time()

    # ---------- 发送 ----------
    async def send(self, ws: WebSocket, type_: str, payload: dict | None = None, reply_to: str | None = None) -> None:
        try:
            await ws.send_text(json.dumps(envelope(type_, payload, reply_to), ensure_ascii=False))
        except Exception as err:  # 连接已断：交给心跳超时处理
            log("warn", "发送失败", type=type_, error=str(err))

    async def broadcast(self, type_: str, payload: dict | None = None) -> None:
        for ws in list(self.clients):
            await self.send(ws, type_, payload)

    # ---------- 状态 ----------
    def overview(self) -> dict:
        clock = self.digest.get("clock") or {}
        world = self.digest.get("world") or {}
        return {
            "work_tier": self.tier,
            "conn_state": "up" if self.connected else "down",
            "pos_checksum": world.get("pos_checksum") or "n/a",
            "clock": {"day": clock.get("day", ""), "minute": clock.get("minute", 0), "phase": clock.get("phase", "")},
            "agent": {},
        }

    async def set_tier(self, value: str) -> None:
        if value == self.tier:
            return
        self.tier = value
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
                    "world_tier": self.tier,
                    "agent": {},
                },
                msg_id,
            )
            if self.llm.get("baseUrl") and self.llm.get("model"):
                await self.send(ws, "llm:config", self.llm_payload(), msg_id)
            await self.send(ws, "digest:get", {})
            await self.send(ws, "mood:get", {})
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
            hits = self.store.search(text, k)
            elapsed = round((time.perf_counter() - started) * 1000, 1)
            await self.send(ws, "memory:result", {"req_id": payload.get("req_id"), "hits": hits, "semantic": False}, msg_id)
            log("info", "记忆检索", req=payload.get("req_id"), hits=len(hits), ms=elapsed, semantic=False)
            return

        if type_ == "world:digest":
            digest = payload.get("digest")
            if isinstance(digest, dict):
                self.digest = digest
                self.store.write_digest(digest)
                pending = [s for s in digest.get("sceneRequests") or [] if s.get("status") == "pending"]
                if pending:
                    log("warn", "有待生成的场景请求", count=len(pending), ids=[s.get("id") for s in pending])
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
        llm = cfg.get("llm")
        if isinstance(llm, dict) and llm.get("baseUrl"):
            merged = {**self.llm, **{k: v for k, v in llm.items() if v is not None}}
            self.llm = merged
            self.store.put_kv("llm", merged)
            await self.broadcast("llm:config", self.llm_payload())
            log("info", "下发 LLM 配置", baseUrl=merged.get("baseUrl"), model=merged.get("model"))
        return {"ok": True, "tts": self.tts_ready, "live2d": self.live2d_ready, "llm": bool(self.llm.get("model"))}

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
            "memory": store.memory_count(),
        }

    @app.get("/dhvw/digest")
    async def digest() -> JSONResponse:
        return JSONResponse(orch.digest)

    @app.get("/dhvw/mood")
    async def mood() -> JSONResponse:
        return JSONResponse(orch.mood)

    @app.get("/dhvw/events")
    async def events(limit: int = 20) -> JSONResponse:
        return JSONResponse(store.recent_events(max(1, min(limit, 200))))

    @app.get("/dhvw/actions")
    async def action_help() -> JSONResponse:
        return JSONResponse(actions.describe())

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
            orch.connected = False
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
