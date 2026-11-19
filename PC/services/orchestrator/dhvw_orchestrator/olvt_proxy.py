"""OLVT 对话代理与记忆/世界上下文节流辅助模块。

职责：
1. /dhvw/memory/context：把世界状态从“每轮当成 user 消息硬塞”降频为按变化/间隔轻度播报，
   并且不再每轮无脑倾倒全部 L0 静态人设记忆。
2. /dhvw/llm/v1/chat/completions：给 OpenAI 兼容转发补充防复读采样参数与跨轮高频词约束，
   同时把最近重复的开头/世界词压下去，避免本地与快速 API 模型机械复读。
"""

from __future__ import annotations

import copy
import re
import time
from typing import Any

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)

#: 只有用户主动问及环境/作息/心情时才放行实时世界近况
WORLD_QUERY_RE = re.compile(
    r"天气|下雨|下雪|起雾|大雾|雾|晴|风|冷|热|温度|气候|几点|时间|星期|周几|在哪|干嘛|做什么|心情|累不累|虚拟仓"
)

_LEADING_TAG_RE = re.compile(r"^\s*(?:\[[a-zA-Z0-9_:-]{1,32}\]\s*)+")
_LEADING_PUNCT_RE = re.compile(r"^[\s，,。\.！？!\?～~…、：:]+")
_EXTRACT_JSON_HINT_RE = re.compile(r"记忆整理助手|只输出\s*JSON|events_consolidated", re.I)

_MOTIF_RULES: list[tuple[str, re.Pattern[str], re.Pattern[str]]] = [
    ("雾/天气", re.compile(r"雾|灰蒙蒙|天永远是蓝|蓝汪汪|天气"), re.compile(r"雾|天气|下雨|晴|冷|热")),
    ("虚拟仓", re.compile(r"虚拟仓|仓里"), re.compile(r"虚拟仓|仓里|住哪|房间")),
    ("白饭/梅子梗", re.compile(r"白米饭|白饭|梅子|事已至此先吃饭"), re.compile(r"白饭|白米饭|梅子|吃饭|吃啥|想吃|饿")),
    ("心情自述", re.compile(r"心情不错|心情正好"), re.compile(r"心情|开心|低落")),
    ("出题套路", re.compile(r"出个题|我出题|猜猜.*想干嘛|接着聊书.*换个话题"), re.compile(r"出题|猜猜")),
]


def _extract_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                t = item.get("text")
                if isinstance(t, str) and t:
                    parts.append(t)
        return " ".join(parts)
    return ""


def _opening_phrase(text: str) -> str:
    cleaned = _LEADING_TAG_RE.sub("", text or "")
    cleaned = _LEADING_PUNCT_RE.sub("", cleaned)
    if not cleaned:
        return ""
    m = re.match(r"^(嗯哼|嘿嘿|唔|哦|诶|哼|啊|哈+|好呀|好啊|好的|行吧|那我|不过|说真的|其实)", cleaned)
    if m:
        return m.group(1)
    head = re.split(r"[，,。\.！？!\?～~\s]", cleaned, maxsplit=1)[0]
    return head[:6] if len(head) >= 2 else ""


def detect_repetition_hint(messages: list[dict[str, Any]]) -> str | None:
    """扫描最近几轮 assistant 回复，提取重复起手词与高黏着意象，返回轻量防复读提醒。"""
    if not isinstance(messages, list) or len(messages) < 2:
        return None

    recent_assistant: list[str] = []
    latest_user = ""
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        txt = _extract_text(msg.get("content")).strip()
        if not txt:
            continue
        if role == "user" and not latest_user:
            latest_user = txt
        elif role == "assistant" and len(recent_assistant) < 4:
            recent_assistant.append(txt)

    if not recent_assistant:
        return None

    banned_openers: list[str] = []
    last_opener = _opening_phrase(recent_assistant[0])
    if last_opener:
        banned_openers.append(last_opener)
    opener_counts: dict[str, int] = {}
    for reply in recent_assistant:
        op = _opening_phrase(reply)
        if op:
            opener_counts[op] = opener_counts.get(op, 0) + 1
    for op, cnt in opener_counts.items():
        if cnt >= 2 and op not in banned_openers:
            banned_openers.append(op)

    avoid_motifs: list[str] = []
    window_text = "\n".join(recent_assistant[:3])
    for label, reply_pat, user_pat in _MOTIF_RULES:
        if user_pat.search(latest_user):
            continue
        hits = sum(1 for r in recent_assistant[:3] if reply_pat.search(r))
        if hits >= 1 and (hits >= 2 or reply_pat.search(recent_assistant[0])):
            avoid_motifs.append(label)

    tic_notes: list[str] = []
    if sum(1 for r in recent_assistant[:2] if "嗯哼" in r) >= 1:
        tic_notes.append("本轮不要用“嗯哼”")
    if window_text.count("～") >= 4 or recent_assistant[0].count("～") >= 2:
        tic_notes.append("少用或不用“～”")

    clauses: list[str] = []
    if banned_openers:
        clauses.append("不要再用「" + " / ".join(banned_openers[:3]) + "」开头")
    if avoid_motifs:
        clauses.append("避开刚提过的「" + "、".join(avoid_motifs[:4]) + "」")
    clauses.extend(tic_notes)
    if not clauses:
        return None

    return (
        "[本轮表达微调] 为避免说话套路化："
        + "；".join(clauses)
        + "。请直接顺着用户刚才的话接下去，换一个自然的新起手式。"
    )


def sanitize_proxy_payload(payload: dict[str, Any], is_local: bool) -> tuple[dict[str, Any], bool]:
    """为对话类转发请求注入温和防复读参数与动态表达约束。

    跳过低温/短输出的结构化抽取请求（如 memory_extract），避免干扰 JSON 输出。
    """
    out = copy.deepcopy(payload)
    messages = out.get("messages")
    if not isinstance(messages, list) or not messages:
        return out, False

    first_text = _extract_text(messages[0].get("content") if isinstance(messages[0], dict) else "")
    temp = out.get("temperature")
    is_extraction = bool(_EXTRACT_JSON_HINT_RE.search(first_text)) or (
        isinstance(temp, (int, float)) and temp <= 0.25 and isinstance(out.get("max_tokens"), int)
    )
    if is_extraction:
        return out, False

    injected_penalties = False
    if "frequency_penalty" not in out:
        out["frequency_penalty"] = 0.25 if is_local else 0.42
        injected_penalties = True
    if "presence_penalty" not in out:
        out["presence_penalty"] = 0.15 if is_local else 0.28
        injected_penalties = True

    hint = detect_repetition_hint(messages)
    if hint:
        sys_idx = next((i for i, m in enumerate(messages) if isinstance(m, dict) and m.get("role") == "system"), -1)
        if sys_idx >= 0 and isinstance(messages[sys_idx].get("content"), str):
            if "[本轮表达微调]" not in messages[sys_idx]["content"]:
                messages[sys_idx]["content"] = messages[sys_idx]["content"].rstrip() + "\n\n" + hint
        else:
            messages.insert(0, {"role": "system", "content": hint})

    return out, injected_penalties


def _is_fresh_ctx_since(since_val: Any, now: float, max_age_s: float = 7200.0) -> bool:
    if isinstance(since_val, (int, float)):
        ts = float(since_val)
        if ts > 1e12:
            ts /= 1000.0
        return ts > 0 and (now - ts) <= max_age_s
    return False


def build_memory_context_block(
    *,
    store: Any,
    digest: dict[str, Any],
    mood: dict[str, Any],
    mood_desc: str,
    weekday_name: str,
    q: str,
    k: int,
    turn: int,
    proactive: bool,
    last_sig: str,
    last_at: float,
    turns_since_world: int,
    now: float | None = None,
) -> tuple[str, dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], bool, str, float, int]:
    """按对话轮次与状态变化节流拼装给 OLVT 的记忆与世界背景块。"""
    ts = time.time() if now is None else now
    q_clean = q.strip()
    hits, semantic = store.search_hybrid(q_clean, k, min_score=0.35, mood=mood) if q_clean else ([], False)
    hit_ids = {h["id"] for h in hits}

    # L0 锚点：人设已经自带完整性格与设定，不再每轮塞 10 条重复锚点。
    # 仅首轮（或老客户端 turn==0）附带最多 2 条，后续靠混合检索命中再召回。
    l0_extra: list[dict[str, Any]] = []
    if not proactive and turn <= 1:
        l0 = store.get_l0_facts(4)
        l0_extra = [f for f in l0 if f["id"] not in hit_ids][:2]

    ctx = store.get_kv("context", {}) or {}
    clock = (digest or {}).get("clock") or {}
    world = (digest or {}).get("world") or {}

    # 优先使用实时 world:digest；旧 context KV 超过 2 小时即视为陈旧丢弃（防一直念“清早/雾”）
    ctx_fresh = _is_fresh_ctx_since(ctx.get("since"), ts)
    phase = str(clock.get("phase") or (ctx.get("phase") if ctx_fresh else "") or "").strip()
    place = str(world.get("place") or (ctx.get("place") if ctx_fresh else "") or "").strip()
    weather = str(world.get("weather") or (ctx.get("weather") if ctx_fresh else "") or "").strip()
    doing = str(world.get("doing") or "").strip()

    state_parts = [p for p in (weekday_name, phase, place, weather, f"在{doing}" if doing else "") if p]
    state_sig = "|".join([phase, place, weather, mood_desc]) if (state_parts or mood_desc) else ""

    explicit_world_ask = bool(q_clean and WORLD_QUERY_RE.search(q_clean))
    changed = bool(state_sig and state_sig != last_sig and (last_at == 0.0 or (ts - last_at) >= 120.0))
    periodic = bool(state_sig and turns_since_world >= 6 and (ts - last_at) >= 480.0)

    # 主动说话轮已有 ProactiveScheduler 独立决定是否带世界状态，这里不二次塞入
    include_world = (not proactive) and bool(state_sig) and (explicit_world_ask or changed or periodic)

    lines: list[str] = []
    if include_world:
        if state_parts:
            lines.append(
                "环境微况（后台状态，除非用户主动问起否则顺嘴一笔带过或完全不提，切勿反问对方天气）："
                + " / ".join(state_parts)
            )
        if mood_desc:
            lines.append(f"当前心情底色：{mood_desc}")
        next_sig = state_sig
        next_at = ts
        next_turns = 0
    else:
        next_sig = last_sig
        next_at = last_at
        next_turns = turns_since_world + (0 if proactive else 1)

    if l0_extra:
        lines.append("核心设定备忘：")
        for f in l0_extra:
            lines.append(f"- {f.get('text', '')}")

    if hits:
        lines.append("相关长期记忆：")
        for h in hits:
            tier = h.get("tier") or "L2"
            lines.append(f"- [{tier}] {h.get('text', '')}")

    block = "\n".join(lines)
    return block, ctx, hits, l0_extra, semantic, next_sig, next_at, next_turns
