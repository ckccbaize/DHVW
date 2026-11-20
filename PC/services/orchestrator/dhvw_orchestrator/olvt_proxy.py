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

_CLICHE_PHRASES: tuple[str, ...] = (
    "讲真",
    "说实话",
    "话说回来",
    "对了，之前说",
    "突然想起来",
    "记小本本",
    "踩踩点",
    "踩点",
    "行吧",
    "太会了",
    "也太会",
    "那味儿",
    "拉满",
    "生活气息",
    "看着还挺",
    "估计就",
    "永远的神",
    "yyds",
    "云吃",
    "云参观",
)
_CJK_TOKEN_RE = re.compile(r"[\u4e00-\u9fa5]{2,4}")
_STOP_TOKENS = frozenset(
    {
        "这个", "那个", "这样", "那样", "现在", "时候", "自己", "其实", "但是",
        "不过", "感觉", "今天", "昨天", "晚上", "早上", "没有", "是不是", "怎么样", "知道",
    }
)
_NEUTRAL_HEDGE_RE = re.compile(
    r"(?:各有各的|都不错|挺好(?:的|看|听|玩)?|还行吧|听起来不错|挺经典|看个人|顺其自然|慢慢来|先别[写了做想动]|放一边|劳逸结合|需要下班|别太累|也挺好|都可以|有道理|好哭|后劲[儿]?大)"
)
_EXPRESSIVE_CHAR_RE = re.compile(r"[!！?？哼切哈呀啊偏烦嫌扯算拉倒离谱]")
_PARTICLE_RE = re.compile(r"[呀啊呢吧嘛哇哦哼切唉诶咧咯捏哒啦哈呗]")
_TRAILING_PARTICLE_RE = re.compile(r"([呀啊呢吧嘛哇哦哼切唉诶咧咯捏哒啦哈呗])[！!？?~～\s]*$")

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
    m = re.match(
        r"^(那我|那你|这|那|不过|其实|话说|行吧|好吧|不是|嗯哼|嘿嘿|唔|哦|诶|哼|啊|哈\？?|切|哇|嘿|哎呀?|好呀|好啊|好的|说真的)",
        cleaned,
    )
    if m:
        return m.group(1)
    head = re.split(r"[，,。\.！？!\?～~\s]", cleaned, maxsplit=1)[0]
    return head[:6] if len(head) >= 2 else ""


def detect_repetition_hint(messages: list[dict[str, Any]], is_local: bool = False) -> str | None:
    """扫描最近几轮 assistant 回复，提取重复起手词、套话、中立端水与语气/长度节奏偏移。"""
    if not isinstance(messages, list) or len(messages) < 2:
        return None

    recent_assistant: list[str] = []
    assistant_total = 0
    latest_user = ""
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        txt = _extract_text(msg.get("content")).strip()
        if role == "assistant" and txt:
            assistant_total += 1
            if len(recent_assistant) < 4:
                recent_assistant.append(txt)
        elif role == "user" and not latest_user and txt:
            latest_user = txt

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

    ban_words: list[str] = []
    for phrase in _CLICHE_PHRASES:
        if any(phrase in r for r in recent_assistant):
            ban_words.append(phrase)
    token_counts: dict[str, int] = {}
    for r in recent_assistant:
        for tok in set(_CJK_TOKEN_RE.findall(r)):
            if tok in _STOP_TOKENS:
                continue
            token_counts[tok] = token_counts.get(tok, 0) + 1
    for tok, cnt in token_counts.items():
        if cnt >= 2 and tok not in ban_words:
            ban_words.append(tok)

    avoid_motifs: list[str] = []
    recent3 = recent_assistant[:3]
    window_text = "\n".join(recent3)
    for label, reply_pat, user_pat in _MOTIF_RULES:
        if user_pat.search(latest_user):
            continue
        hits = sum(1 for r in recent3 if reply_pat.search(r))
        if hits >= 1 and (hits >= 2 or reply_pat.search(recent_assistant[0])):
            avoid_motifs.append(label)

    tic_notes: list[str] = []
    if sum(1 for r in recent_assistant[:2] if "嗯哼" in r) >= 1:
        tic_notes.append("本轮不要用“嗯哼”")
    if window_text.count("～") >= 4 or recent_assistant[0].count("～") >= 2:
        tic_notes.append("少用或不用“～”")

    clauses: list[str] = []
    if banned_openers:
        clauses.append("本轮严禁再以「" + " / ".join(banned_openers[:3]) + "」开头，换全新起手式")
    if ban_words:
        clauses.append("严禁复用最近高频词/套话：" + "、".join(ban_words[:6]))
    if avoid_motifs:
        clauses.append("避开刚提过的「" + "、".join(avoid_motifs[:4]) + "」")

    last_p_m = _TRAILING_PARTICLE_RE.search(recent_assistant[0])
    if last_p_m:
        prev_p = last_p_m.group(1)
        clauses.append(f"上轮刚用过尾音「{prev_p}」，本轮换别的语气词（如 呀/嘛/啦/咧/哼/咯 等）或直接收住，别连着用同一个尾音")

    trailing_questions = sum(1 for r in recent3 if re.search(r"[？?]\s*$", r))
    if not is_local and trailing_questions >= 2:
        clauses.append("最近几轮总在反问，本轮【禁止以问句收尾】，直接陈述/接梗/吐槽收住")

    bland_neutral_hits = sum(
        1 for r in recent3 if _NEUTRAL_HEDGE_RE.search(r) or not _EXPRESSIVE_CHAR_RE.search(r)
    )
    if bland_neutral_hits >= 2 or _NEUTRAL_HEDGE_RE.search(recent_assistant[0]):
        clauses.append("【拒绝端水与老好人】最近几轮太温和像标准安慰机器人！这轮必须鲜明站队、毒舌挑刺或带点傲娇小脾气，禁止用“挺好/各有优势/放一边/听起来不错/劳逸结合”打圆场")

    dry_no_particle_hits = sum(1 for r in recent3 if not _PARTICLE_RE.search(r))
    if not is_local and dry_no_particle_hits >= 2:
        clauses.append("最近几句语气词太少显得生硬，这轮适当自然加上「嘛/呀/吧/咧/哼/切/呗」这类口语尾音，让俏皮感活起来（自然带 1~2 处即可，别刻意堆砌）")

    if not is_local and len(recent_assistant) >= 2:
        long_turns = sum(1 for r in recent_assistant[:2] if len(re.sub(r"\s+", "", r)) > 42 or "\n" in r)
        lens = [len(re.sub(r"\s+", "", r)) for r in recent3]
        tight_length_band = len(lens) >= 2 and (max(lens) - min(lens) <= 10)
        if long_turns >= 2:
            clauses.append("最近两轮话太多太像模板，本轮请只说【1 句】简短口语（4~16 字），干净利落")
        else:
            mode = assistant_total % 3
            if mode == 0:
                clauses.append("【本轮节奏：极短单句】只说 1 句 4~12 字短接梗/吐槽（禁止长篇评价）")
            elif mode == 1:
                clauses.append("【本轮节奏：先槽后补】先甩一句 2~6 字短反应或吐槽，紧接着补一句 10~24 字具体接话或细节拆台")
            elif tight_length_band:
                clauses.append("【本轮节奏：换结构】最近字数太齐，这次直接针对内容里的一个具体细节接话（14~28字，禁用“这X也太…”模板）")

    clauses.extend(tic_notes)
    if not clauses:
        return None

    return "[本轮表达微调] " + "；".join(clauses) + "。顺着对方刚才的话自然接下去，保持嘴俏鲜活。"


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
    if is_local:
        # 本地部署 llama 不关闭思考、不锁死输出 token 上限，避免降低回答质量与输出欲望
        out.pop("max_tokens", None)
        if str(out.get("reasoning_effort") or "").strip().lower() == "none":
            out.pop("reasoning_effort", None)
        if out.get("enable_thinking") is False:
            out.pop("enable_thinking", None)
        if out.get("reasoning_budget") == 0:
            out.pop("reasoning_budget", None)
        if not is_extraction and (not isinstance(temp, (int, float)) or float(temp) < 1.05):
            out["temperature"] = 1.05
    elif not is_extraction:
        # 云端对话对齐 QQ/飞书 0.9 温度（避免默认 0.7 过于平淡端水）
        if not isinstance(temp, (int, float)) or (0.35 <= float(temp) < 0.88):
            out["temperature"] = 0.9

    if is_extraction:
        return out, False

    injected_penalties = False
    if "frequency_penalty" not in out:
        out["frequency_penalty"] = 0.25 if is_local else 0.42
        injected_penalties = True
    if "presence_penalty" not in out:
        out["presence_penalty"] = 0.15 if is_local else 0.28
        injected_penalties = True

    hint = detect_repetition_hint(messages, is_local=is_local)
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
