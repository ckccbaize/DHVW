"""从显现会话轮次抽取长期记忆事实（L0/L1/L2），用于回写 memory.db 与设备深层记忆。"""

from __future__ import annotations

import json
import re

import httpx

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
)

EXTRACT_PROMPT = """你是记忆整理助手。请从下面这段角色与用户的近期对话中，抽取值得长期记住的「事实」。
要求：
1. 只输出 JSON：`{"facts":[{"text":"...","tier":"L0|L1|L2"}]}`，不要任何解释。
2. tier 含义：
   - L0：长期核心偏好、禁忌、称呼、作息底线（极少，确定才写）。
   - L1：近期重要约定、习惯、环境与物品细节。
   - L2：具体发生过的事、聊过的重要话题或计划。
3. 每条 text 10–120 字，用客观第三人称或明确主语（如“你/用户”“她”），时间/地点/对象明确。
4. 寒暄、无实质信息（如“你好”“嗯嗯”“哈哈”）不要抽取，没有新事实就输出 `{"facts":[]}`。

对话内容：
"""


def _extract_json_obj(raw: str) -> dict | None:
    text = raw.strip()
    m = re.search(r"\{[\s\S]*\}", text)
    if not m:
        return None
    try:
        obj = json.loads(m.group(0))
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        return None


def _chat_url(base_url: str) -> str:
    base = base_url.strip().rstrip("/")
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


async def extract_facts_from_turns(llm_cfg: dict, turns: list[dict]) -> tuple[list[dict], str | None]:
    """调用配置的 DeepSeek 兼容接口抽取事实。返回 (facts, error_reason)。"""
    base_url = str(llm_cfg.get("baseUrl") or "").strip()
    model = str(llm_cfg.get("model") or "").strip()
    api_key = str(llm_cfg.get("apiKey") or "").strip()
    if not base_url or not model or not api_key:
        return [], "llm_not_configured"

    lines: list[str] = []
    for t in turns[-16:]:
        if not isinstance(t, dict):
            continue
        role = "用户" if t.get("role") == "user" else "角色"
        content = t.get("content")
        if isinstance(content, list):
            content = " ".join(str(p.get("text") or "") for p in content if isinstance(p, dict) and p.get("type") == "text")
        text = str(content or t.get("text") or "").strip()
        if text:
            lines.append(f"{role}: {text[:300]}")
    if len(lines) < 2:
        return [], "not_enough_turns"

    body = {
        "model": model,
        "messages": [{"role": "user", "content": EXTRACT_PROMPT + "\n".join(lines)}],
        "temperature": 0.2,
        "max_tokens": 450,
        "reasoning_effort": "none",
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "User-Agent": BROWSER_UA,
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(_chat_url(base_url), headers=headers, json=body)
            if resp.status_code >= 400:
                return [], f"http_{resp.status_code}"
            data = resp.json()
    except Exception as exc:
        return [], str(exc)

    choices = data.get("choices") or []
    raw_text = str(((choices[0] if choices else {}).get("message") or {}).get("content") or "")
    obj = _extract_json_obj(raw_text)
    if not obj or not isinstance(obj.get("facts"), list):
        return [], "invalid_json"

    out: list[dict] = []
    for item in obj["facts"][:6]:
        if not isinstance(item, dict):
            continue
        text = " ".join(str(item.get("text") or "").split())
        if len(text) < 10 or len(text) > 120:
            continue
        tier = str(item.get("tier") or "L2").upper()
        if tier not in ("L0", "L1", "L2"):
            tier = "L2"
        out.append({"text": text, "tier": tier})
    return out, None


EVENT_EXTRACT_PROMPT = """你是生活事件记忆归纳助手。请从下面的角色生活事件流中，归纳出 0–5 条值得长期记住的「事实」。
要求：
1. 只输出 JSON：`{"facts":[{"text":"...","tier":"L1|L2"}]}`，不要任何解释。
2. 每条 text 10–120 字，明确时间/地点/动作/对象；流水账或无意义状态切换不要抽取。

事件列表：
"""


async def extract_facts_from_events(llm_cfg: dict, events: list[dict]) -> tuple[list[dict], str | None]:
    """从 life.db 设备事件流批量归纳事实。"""
    base_url = str(llm_cfg.get("baseUrl") or "").strip()
    model = str(llm_cfg.get("model") or "").strip()
    api_key = str(llm_cfg.get("apiKey") or "").strip()
    if not base_url or not model or not api_key:
        return [], "llm_not_configured"
    if len(events) < 3:
        return [], "not_enough_events"

    compact = json.dumps(
        [{"kind": e.get("kind"), "payload": e.get("payload"), "t": e.get("t_local")} for e in events[-40:]],
        ensure_ascii=False,
    )[:3600]
    body = {
        "model": model,
        "messages": [{"role": "user", "content": EVENT_EXTRACT_PROMPT + compact}],
        "temperature": 0.2,
        "max_tokens": 450,
        "reasoning_effort": "none",
    }
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json", "User-Agent": BROWSER_UA}
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            resp = await client.post(_chat_url(base_url), headers=headers, json=body)
            if resp.status_code >= 400:
                return [], f"http_{resp.status_code}"
            data = resp.json()
    except Exception as exc:
        return [], str(exc)

    choices = data.get("choices") or []
    raw_text = str(((choices[0] if choices else {}).get("message") or {}).get("content") or "")
    obj = _extract_json_obj(raw_text)
    if not obj or not isinstance(obj.get("facts"), list):
        return [], "invalid_json"
    out: list[dict] = []
    for item in obj["facts"][:5]:
        if not isinstance(item, dict):
            continue
        text = " ".join(str(item.get("text") or "").split())
        if len(text) < 10 or len(text) > 120:
            continue
        tier = "L1" if str(item.get("tier") or "").upper() == "L1" else "L2"
        out.append({"text": text, "tier": tier})
    return out, None
