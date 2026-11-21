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
from collections import deque
import random
import re
import time
from datetime import datetime
from typing import Any

from loguru import logger

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
        self._recent_openers: deque[str] = deque(maxlen=8)
        self._recent_angles: deque[str] = deque(maxlen=5)
        self._speak_seq = 0
        self._last_world_seq = -2
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

    def note_ai_finished(self, client_uid: str = "") -> None:
        """AI 一轮回复/播报完成时刷新空闲起点，避免长回复还没说完就开始倒数 idle。"""
        now = self._clock()
        if now > self.last_activity:
            self.last_activity = now
        if client_uid and not self.last_client:
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

    def _extract_world_snippets(self) -> list[str]:
        raw = str(self.cfg.get("context") or "").strip()
        if not raw or "还没有回报状态" in raw:
            return []
        snippets: list[str] = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            # 不把干巴巴的心率/数值条直接当话题，只保留动作、地点、天气、日程等鲜活细节
            if line.startswith(("正在做：", "接下来的计划：", "角色所在地点：", "天气：")):
                snippets.append(line)
        return snippets

    def _forbidden_topics(self) -> list[str]:
        stop = {
            "这个", "那个", "这样", "那样", "现在", "时候", "自己", "其实", "但是", "不过",
            "感觉", "今天", "昨天", "晚上", "早上", "没有", "是不是", "怎么样", "知道", "什么",
            "对方", "主人", "虚拟仓", "天气", "还行", "真的", "神奇", "离谱", "有点", "今天",
        }
        counts: dict[str, int] = {}
        samples = list(self._recent_openers)[-6:]
        client_uid = self._pick_client()
        ctx = getattr(self.handler, "client_contexts", {}).get(client_uid) if client_uid else None
        mem = getattr(getattr(ctx, "agent_engine", None), "_memory", None)
        if isinstance(mem, list):
            for item in mem[-6:]:
                if isinstance(item, dict) and isinstance(item.get("content"), str):
                    samples.append(item["content"])
        for text in samples:
            toks: set[str] = set()
            for seg in re.split(r"[的了了吗呢吧呀啊哇嘛咧哼切咧是在和与跟就也都还太真\s，,。\.！？!\?～~…]+", text or ""):
                for run in re.findall(r"[\u4e00-\u9fa5]{2,}", seg):
                    if len(run) <= 4 and run not in stop:
                        toks.add(run)
                    if len(run) > 2:
                        for i in range(len(run) - 1):
                            bg = run[i : i + 2]
                            if bg not in stop:
                                toks.add(bg)
                            if i <= len(run) - 3:
                                tg = run[i : i + 3]
                                if tg not in stop:
                                    toks.add(tg)
            for tok in toks:
                counts[tok] = counts.get(tok, 0) + 1
        ranked = sorted(
            (k for k, v in counts.items() if v >= 2),
            key=lambda k: (counts[k], len(k)),
            reverse=True,
        )
        picked: list[str] = []
        for tok in ranked:
            if any(tok in p for p in picked):
                continue
            picked.append(tok)
            if len(picked) >= 6:
                break
        return picked

    def _compose_prompt(self, now: float | None = None) -> str:
        self._speak_seq += 1
        ts = self._clock() if now is None else now
        hour = datetime.fromtimestamp(ts).hour
        if 7 <= hour < 10:
            clock_desc = "早起犯困/开启一天"
        elif 10 <= hour < 14:
            clock_desc = "临近或刚过午饭点"
        elif 14 <= hour < 18:
            clock_desc = "下午犯困摸鱼高峰"
        elif 18 <= hour < 22:
            clock_desc = "傍晚放松或纠结夜宵"
        else:
            clock_desc = "深夜夜猫子时间"

        angle_pool: list[tuple[str, str]] = [
            (
                "routine_slice",
                f"切入角度【当下现实作息切片（当前约 {clock_desc}）】：抓一个这个钟点真实会遇到的小状态吐槽或犯懒，禁止泛泛问候“在干嘛”。",
            ),
            (
                "hot_debate",
                "切入角度【脑洞二选一偏心站队】：抛一个全新生活/口味/怪癖二选一（与近期聊过的内容无关），你先强势偏心站一边，逼对方接招。",
            ),
            (
                "odd_tidbit",
                "切入角度【反常识小冷知识】：抛一个生活里反常识的小冷知识或奇怪事实，用“我刚反应过来这也太离谱”的口吻吐槽两句（不是每轮都有，本轮限定只讲一个点）。",
            ),
            (
                "self_theater",
                "切入角度【自己身上的突发小乌龙】：现编一个刚才发生在自己身上的小尴尬、奇思妙想或小傲娇吐槽（禁复读旧物件/旧设定）。",
            ),
            (
                "playful_tease",
                "切入角度【熟人盲猜/轻挑衅】：直接拿捏对方此刻状态打个赌或拆台（比如猜他电量快红了、姿势歪了、偷偷摸鱼），语气灵动带勾子。",
            ),
            (
                "taste_roast",
                "切入角度【随机品味安利或嫌弃】：在神曲歌单/老番旧片/奇葩零食饮品/童年游戏里抽一个近期没聊过的新方向，直接辣评。",
            ),
            (
                "brainhole_whatif",
                "切入角度【奇葩脑洞假设】：抛一个完全跳脱的脑洞假设（如重力突然减半一小时、物体能给自己打分），顺嘴玩一个梗。",
            ),
        ]
        recent_set = set(self._recent_angles)
        candidates = [
            item
            for item in angle_pool
            if item[0] not in recent_set
            and not (item[0] == "odd_tidbit" and "odd_tidbit" in list(self._recent_angles)[-2:])
        ]
        if not candidates:
            candidates = [item for item in angle_pool if item[0] != (self._recent_angles[-1] if self._recent_angles else "")]
        angle_id, seed_block = random.choice(candidates)
        self._recent_angles.append(angle_id)

        world_snippets = self._extract_world_snippets()
        can_use_world = bool(world_snippets) and (self._speak_seq - self._last_world_seq >= 4)
        world_overlay = ""
        if can_use_world and (random.random() < 0.25):
            self._last_world_seq = self._speak_seq
            pick = random.choice(world_snippets)
            world_overlay = f"顺带可轻量叠加一句近况点缀（也可不用，别列数据或问天气）：{pick}"

        lines = [
            "[主动找话题指令] 现在你主动对用户说 1 到 2 句简短口语，像真人熟人忽然在耳边或微信里冒泡搭话/吐槽一样鲜活。",
            seed_block,
        ]
        if world_overlay:
            lines.append(world_overlay)
        forbidden = self._forbidden_topics()
        if forbidden:
            lines.append(f"【强制全新角度，严禁翻旧账】本轮禁止再提近期出现过的词：{'、'.join(forbidden)}。")
        if self._recent_openers:
            recent_list = list(self._recent_openers)
            recent_str = " / ".join(f"「{item}」" for item in recent_list[-4:])
            lines.append(f"最近已经说过的开头与话头（本轮禁止重复）：{recent_str}")
            last_p = re.search(r"([呀啊呢吧嘛哇哦哼切唉诶咧咯捏哒啦哈呗])[！!？?~～\s]*$", recent_list[-1])
            if last_p:
                lines.append(f"上轮用过尾音「{last_p.group(1)}」，本轮换别的语气词（嘛/呀/吧/咧/哼/切/呗）或直接收住。")
        lines.append(
            "性格与硬性约束：1. 活泼俏皮有态度、敢偏心吐槽，每轮自然带 1~2 个口语语气词（嘛/呀/吧/咧/哼/切/呗/啦），绝不干巴巴说教关心（禁用“别太累/劳逸结合/顺其自然/挺好的”）；"
            "2. 禁止用“对了，之前说…”“突然想起来，你之前说…”翻旧账套话，也别再揪着前天聊死的老梗重复追问；"
            "3. 禁止用“嗯哼”或固定同一词开头；禁止用“猜猜我最想干嘛”“聊聊书还是换话题”“心情不错/心情正好”“雾散了没”“永远的神/拉满/那味儿”；"
            "4. 长短自由起伏，可极短一句直出，不要自报时间数字，不要输出 Markdown、括号动作或方括号标签。"
        )
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

        async def _run_proactive() -> str:
            try:
                reply = await process_single_conversation(
                    context=context,
                    websocket_send=websocket.send_text,
                    client_uid=client_uid,
                    user_input=prompt,
                    images=None,
                    session_emoji=random.choice(EMOJI_LIST),
                    metadata={"proactive_speak": True, "skip_memory": True, "skip_history": True},
                )
                clean_reply = re.sub(r"\s+", " ", str(reply or "")).strip()
                if clean_reply:
                    self._recent_openers.append(clean_reply[:48])
                self.last_error = ""
                return clean_reply
            except asyncio.CancelledError:
                raise
            except Exception as err:
                self.last_error = str(err)
                raise
            finally:
                self.note_ai_finished(client_uid)

        task = asyncio.create_task(_run_proactive())
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
