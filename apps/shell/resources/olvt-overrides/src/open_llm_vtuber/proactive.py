"""DHVW 主动说话调度器（只用于 OLVT）。

上游 OLVT 已经具备 `ai-speak-signal` → `proactive_speak_prompt` 的链路，但触发在浏览器前端：
谁看到页面谁才有“主动说话”，而且前端只看本地 idle，不知道角色此刻在什么世界、是不是在总观。
这里把触发搬到服务端，由外壳/编排器按「显现模式」下发开关与节奏，并直接投递到当前
已连接的客户端（设备上的 OLVT 页面就是那个客户端），音频与口型仍走 OLVT 原链路。

不烦人的约束全在 should_speak()/tick() 里：
- 只在显式 enabled（PC 判定处于显现模式）时动作；
- 用户刚说过话要安静 idleSeconds；
- 两次主动说话之间至少 gapSeconds，连续自说自话按 ×1.6 退避到 maxGapSeconds；
- 有未完成的对话任务（正在说话）就不插嘴；
- 静默时段与每日上限；
- 没有客户端连接（没人看/没人在听）就不说。
"""

from __future__ import annotations

import asyncio
import random
import time
from datetime import datetime
from typing import Any

from loguru import logger

from prompts import prompt_loader

from .conversations.conversation_utils import EMOJI_LIST
from .conversations.single_conversation import process_single_conversation

DEFAULTS: dict[str, Any] = {
    "enabled": False,
    "idleSeconds": 150,
    "gapSeconds": 240,
    "maxGapSeconds": 1200,
    "dailyMax": 10,
    "quietStart": "23:30",
    "quietEnd": "07:30",
    "context": "",
}

#: 最多连续几次自说自话，之后退避到 maxGapSeconds（用户一说话就复位）
MAX_UNANSWERED = 3
#: 多少秒检查一次
TICK_SECONDS = 10


def _clock_minutes(value: str) -> int | None:
    try:
        hh, mm = str(value).split(":")
        h, m = int(hh), int(mm)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h * 60 + m
    except Exception:
        return None
    return None


class ProactiveScheduler:
    """挂在 WebSocketHandler 上的服务端主动说话循环。"""

    def __init__(self, handler, clock=time.time):
        self.handler = handler
        self._clock = clock
        self.cfg = dict(DEFAULTS)
        self._base_gap = float(DEFAULTS["gapSeconds"])
        self.last_activity = clock()
        self.last_spoke = 0.0
        self.gap = float(DEFAULTS["gapSeconds"])
        self.unanswered = 0
        self.day_key = ""
        self.day_count = 0
        self.last_client = ""
        self.last_error = ""
        self.last_reason = "尚未启动"
        self.spoken_total = 0
        self._task: asyncio.Task | None = None
        # 自己记一份在途任务：上游在链路里会清 handler.current_conversation_tasks，
        # 只信那张表会导致上一轮还在合成语音时又开下一轮。
        self._inflight: asyncio.Task | None = None

    # ---- 控制面 ----

    def note_activity(self, client_uid: str = "") -> None:
        """用户有任何输入（或音频）就当作“有人在场”：复位节奏与未答计数。"""
        self.last_activity = self._clock()
        self.unanswered = 0
        self.gap = float(self.cfg["gapSeconds"])
        if client_uid:
            self.last_client = client_uid

    def configure(self, patch: dict[str, Any]) -> dict[str, Any]:
        """部分更新；非法值保持原样，返回生效后的完整配置。"""
        if isinstance(patch, dict):
            for key, value in patch.items():
                if key not in self.cfg:
                    continue
                if key == "enabled":
                    self.cfg[key] = bool(value)
                elif key in ("idleSeconds", "gapSeconds", "maxGapSeconds", "dailyMax"):
                    try:
                        num = int(value)
                    except (TypeError, ValueError):
                        continue
                    if num >= 0:
                        self.cfg[key] = num
                elif key in ("quietStart", "quietEnd"):
                    if _clock_minutes(value) is not None:
                        self.cfg[key] = str(value)
                elif key == "context":
                    self.cfg[key] = str(value or "")[:1200]
        if not self.cfg["enabled"]:
            self.unanswered = 0
            self.last_reason = "已关闭（非显现模式）"
        # 只有基准间隔被改过才重算 gap：编排器每 20 s 会重下发同一份配置，
        # 若无条件复位 gap，连续自说自话的退避就永远不会生效。
        if float(self.cfg["gapSeconds"]) != self._base_gap:
            self._base_gap = float(self.cfg["gapSeconds"])
            self.gap = self._base_gap
            self.unanswered = 0
        logger.info(f"主动说话配置更新：{self.cfg}")
        return dict(self.cfg)

    def state(self) -> dict[str, Any]:
        now = self._clock()
        return {
            "config": dict(self.cfg),
            "clients": len(self.handler.client_connections),
            "enabled": bool(self.cfg["enabled"]),
            "gap": round(self.gap, 1),
            "unanswered": self.unanswered,
            "dailyCount": self.day_count,
            "lastActivityAge": round(now - self.last_activity, 1),
            "lastSpokeSecondsAgo": round(now - self.last_spoke, 1) if self.last_spoke else None,
            "speaking": bool(self._inflight is not None and not self._inflight.done()),
            "spokenTotal": self.spoken_total,
            "reason": self.last_reason,
            "error": self.last_error or None,
        }

    # ---- 判定 ----

    def _quiet_now(self, now: float) -> bool:
        start = _clock_minutes(self.cfg["quietStart"])
        end = _clock_minutes(self.cfg["quietEnd"])
        if start is None or end is None or start == end:
            return False
        minute = datetime.fromtimestamp(now).hour * 60 + datetime.fromtimestamp(now).minute
        if start < end:
            return start <= minute < end
        return minute >= start or minute < end

    def _reset_daily(self, now: float) -> None:
        key = datetime.fromtimestamp(now).strftime("%Y-%m-%d")
        if key != self.day_key:
            self.day_key = key
            self.day_count = 0

    def should_speak(self, now: float | None = None) -> tuple[bool, str]:
        """纯判定：能不能说、为什么。便于测试与界面展示。"""
        now = self._clock() if now is None else now
        self._reset_daily(now)
        if not self.cfg["enabled"]:
            return False, "未启用（非显现模式）"
        if not self.handler.client_connections:
            return False, "没有已连接的客户端"
        if self._inflight is not None and not self._inflight.done():
            return False, "上一句还没说完"
        if now - self.last_activity < float(self.cfg["idleSeconds"]):
            wait = float(self.cfg["idleSeconds"]) - (now - self.last_activity)
            return False, f"用户刚有动静，再等 {wait:.0f}s"
        if self.last_spoke and now - self.last_spoke < self.gap:
            wait = self.gap - (now - self.last_spoke)
            return False, f"距上次开口不到间隔，再等 {wait:.0f}s"
        if self._quiet_now(now):
            return False, f"静默时段 {self.cfg['quietStart']}-{self.cfg['quietEnd']}"
        if self.day_count >= int(self.cfg["dailyMax"]):
            return False, f"今日已达上限 {self.cfg['dailyMax']} 次"
        busy = [
            uid
            for uid, task in self.handler.current_conversation_tasks.items()
            if task is not None and not task.done()
        ]
        if busy:
            return False, "正在对话中"
        return True, "可以开口"

    def _pick_client(self) -> str:
        conns = self.handler.client_connections
        if self.last_client in conns:
            return self.last_client
        return next(iter(conns.keys()), "")

    def _compose_prompt(self) -> str:
        try:
            base = prompt_loader.load_util("proactive_speak_prompt").strip()
        except Exception:
            base = ""
        if not base:
            base = "Please say something that would be engaging and appropriate for the current context."
        lines = [
            base,
            "",
            "以下是角色此刻所在世界的真实状态（由主机端提供）：",
            str(self.cfg.get("context") or "（无）").strip(),
            "",
            "要求：用角色自己的口吻只说一到两句，不列举状态、不复述设定、不要 Markdown；"
            "如果刚才已经说过类似的话就换个话题，实在没什么可说就保持沉默。",
        ]
        return "\n".join(lines)

    # ---- 执行 ----

    async def speak_now(self) -> dict[str, Any]:
        ok, reason = self.should_speak()
        if not ok:
            self.last_reason = reason
            return {"ok": False, "reason": reason}
        client_uid = self._pick_client()
        context = self.handler.client_contexts.get(client_uid)
        websocket = self.handler.client_connections.get(client_uid)
        if context is None or websocket is None:
            self.last_reason = "客户端上下文还没准备好"
            return {"ok": False, "reason": self.last_reason}
        prompt = self._compose_prompt()
        task = asyncio.create_task(
            process_single_conversation(
                context=context,
                websocket_send=websocket.send_text,
                client_uid=client_uid,
                user_input=prompt,
                images=None,
                session_emoji=random.choice(EMOJI_LIST),
                metadata={"proactive_speak": True, "skip_memory": True, "skip_history": True},
            )
        )
        self.handler.current_conversation_tasks[client_uid] = task
        self._inflight = task
        now = self._clock()
        self.last_spoke = now
        self.day_count += 1
        self.spoken_total += 1
        # 没人接话就越说越稀；用户一开口 note_activity 会把 gap 拉回基准
        self.unanswered += 1
        if self.unanswered >= MAX_UNANSWERED:
            self.gap = float(self.cfg["maxGapSeconds"])
        else:
            self.gap = min(float(self.cfg["maxGapSeconds"]), self.gap * 1.6)
        self.last_reason = f"已开口（今日第 {self.day_count} 次，下次间隔 {self.gap:.0f}s）"
        logger.info(f"主动说话投递：client={client_uid} answered={self.unanswered} gap={self.gap:.0f}")
        return {"ok": True, "client": client_uid, "gap": round(self.gap, 1), "reason": self.last_reason}

    async def tick(self) -> dict[str, Any] | None:
        ok, reason = self.should_speak()
        self.last_reason = reason
        if not ok:
            return None
        try:
            return await self.speak_now()
        except Exception as err:  # 单次失败不影响后续
            self.last_error = str(err)
            logger.error(f"主动说话失败：{err}")
            return None

    async def run(self) -> None:
        logger.info("主动说话调度器已启动（等待 PC 下发显现模式）")
        while True:
            try:
                await self.tick()
            except Exception as err:
                self.last_error = str(err)
                logger.error(f"主动说话循环异常：{err}")
            await asyncio.sleep(TICK_SECONDS)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self.run())
