"""通用 API 生图与融图客户端（支持 OpenAI Images、OpenAI Chat 生图兼容、Gemini 原生生图）。

提供两类核心场景提示词合成与调用：
1. 像素角色 4×4 行走基本图生成（支持纯提示词或参考图，严格约束无文字、白底、4×4 均布）；
2. QQ 互动场景融图（将设置中的角色三维参考图按 LLM 视觉分析的位置、姿势与光影融入用户场景图）。
"""

from __future__ import annotations

import base64
import io
import re
from typing import Any

import httpx
from PIL import Image

IMAGE_PROTOCOLS = ("openai-images", "openai-chat-image", "gemini-native")

DEFAULT_FUSION_STYLE_PROMPT = "\n".join(
    [
        "画风与笔触：日系二次元角色融合厚涂（Impasto）与数字水彩质感，线条纤细柔和，光影过渡自然，带有半写实的立体感与微妙的颗粒噪点。",
        "光影与摄影感：极强的电影镜头语言，主打逆光（Backlighting）、体积光（Volumetric Lighting）与丁达尔效应。大量运用浅景深（Shallow Depth of Field）、前景虚化以及夜景光斑（Bokeh），边缘光（Rim Light）勾勒发丝与衣物轮廓。",
        "色彩基调：低饱和度、清冷通透的电影调色（Muted/Desaturated Color Palette），高光带有柔和的暖色调或朦胧雾感（Haze/Glow），明暗对比柔和且富有空气感。",
    ]
)

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
)


def _normalize_openai_v1(url: str) -> str:
    u = (url or "").strip().rstrip("/")
    if not u:
        return ""
    if re.search(r"/v\d+$", u, re.I):
        return u
    return f"{u}/v1"


def _normalize_gemini_root(url: str) -> str:
    u = (url or "").strip().rstrip("/")
    if not u:
        return ""
    u = re.sub(r"/v1beta$", "", u, flags=re.I)
    u = re.sub(r"/v1$", "", u, flags=re.I)
    return u


def _prepare_png_bytes(raw: bytes, max_side: int = 1280) -> bytes:
    im = Image.open(io.BytesIO(raw))
    im.load()
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA")
    if max(im.size) > max_side:
        im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


def build_4x4_sprite_prompt(user_prompt: str = "", has_ref: bool = False) -> str:
    """构建严格约束的 4×4 上帝视角像素角色行走图提示词。"""
    desc = (user_prompt or "").strip()
    parts = [
        "Generate a clean 4x4 grid pixel art character walk-cycle sprite sheet in top-down 3/4 RPG perspective "
        "(cute Q-version 2-head-tall chibi proportions, crisp dark pixel outlines, rich shading).",
        "Layout MUST be strictly 4 rows by 4 columns (16 evenly spaced full-body sprites, completely separated with clear margin, never overlapping or touching):",
        "- Row 1 (top): walking facing DOWN / FRONT (4 walk animation frames).",
        "- Row 2: walking facing LEFT (4 walk animation frames).",
        "- Row 3: walking facing RIGHT (4 walk animation frames).",
        "- Row 4 (bottom): walking facing UP / BACK (4 walk animation frames).",
        "HARD CONSTRAINTS:",
        "- Pure solid plain white background (#FFFFFF) ONLY. ZERO ground shadows, ZERO floor tiles, ZERO scenery.",
        "- ABSOLUTELY NO text, NO letters, NO numbers, NO labels, NO row titles, NO grid lines, NO borders, NO frames, NO watermarks.",
        "- Keep character scale, outfit colors, hairstyle, and proportions 100% consistent across all 16 frames.",
    ]
    if has_ref:
        parts.insert(
            0,
            "Strictly preserve the exact character identity, hairstyle, hair color, eye color, headwear, outfit colors, "
            "and iconic accessories from the provided reference image, converting them into a cute chibi pixel-art character.",
        )
    if desc:
        parts.append(f"Character design details: {desc}")
    return "\n".join(parts)


def build_scene_fusion_prompt(
    *,
    insert_position: str,
    character_pose: str,
    lighting_mood: str = "",
    scene_desc: str = "",
    style_prompt: str | None = None,
) -> str:
    """构建场景生活照 + 角色三维参考图的纯提示词融合指令（完全交由生图模型重绘融合）。"""
    style = DEFAULT_FUSION_STYLE_PROMPT if style_prompt is None else str(style_prompt).strip()
    parts = [
        "Image 1 is the real-world scene/lifestyle photograph. Image 2 is the character 3D/turnaround reference sheet.",
        "Re-render and seamlessly integrate the character from Image 2 directly into the scene of Image 1 using full generative image synthesis (never perform flat cutout pasting; naturally re-paint light interaction, contact shadows, atmospheric haze, and perspective depth).",
        f"Placement & depth: place the character at [{insert_position.strip() or 'a natural foreground or midground spot in the scene'}]. "
        "Respect perspective, realistic proportions, depth occlusion by nearby objects, and physical surface contact.",
        f"Pose & expression: [{character_pose.strip() or 'standing or sitting naturally while interacting warmly with the surroundings'}]. "
        "Keep the pose lively, creative, and physically grounded.",
        f"Scene lighting & color harmony: [{lighting_mood.strip() or 'match exact light direction, soft contact shadows, ambient occlusion, color temperature, and lens bokeh of Image 1'}].",
        "Preservation rules: keep Image 1's environment, layout, and objects coherent; strictly keep Image 2 character's hair, eyes, outfit, and iconic accessories consistent.",
        "NO text, NO captions, NO watermarks, NO collage frames, NO split screen.",
    ]
    if scene_desc.strip():
        parts.append(f"Scene context: {scene_desc.strip()}")
    if style:
        parts.append(f"Style, cinematography & color grading aesthetic (apply cohesively across the integrated image):\n{style}")
    return "\n".join(parts)


async def _fetch_url_bytes(client: httpx.AsyncClient, url: str) -> tuple[bytes, str]:
    r = await client.get(url, headers={"User-Agent": BROWSER_UA}, follow_redirects=True)
    r.raise_for_status()
    ct = r.headers.get("content-type") or "image/png"
    return r.content, ct.split(";")[0].strip()


def _extract_image_from_chat_data(data: dict[str, Any]) -> tuple[bytes | None, str | None]:
    """从兼容 OpenAI chat/completions 的生图响应中提取 base64 或图片 URL。"""
    choices = data.get("choices") or []
    if not choices:
        return None, None
    msg = choices[0].get("message") or {}

    # 1. OpenRouter / 部分中转的 message.images 数组
    images = msg.get("images")
    if isinstance(images, list):
        for item in images:
            url = (
                item.get("image_url", {}).get("url")
                if isinstance(item, dict) and isinstance(item.get("image_url"), dict)
                else (item.get("url") if isinstance(item, dict) else None)
            )
            if isinstance(url, str) and url.strip():
                if url.startswith("data:image/"):
                    b64 = url.split(",", 1)[1]
                    return base64.b64decode(b64), None
                return None, url.strip()

    content = msg.get("content")
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") == "image_url":
                u = (part.get("image_url") or {}).get("url") or ""
                if u.startswith("data:image/"):
                    return base64.b64decode(u.split(",", 1)[1]), None
                if u.startswith("http"):
                    return None, u
            b64 = part.get("b64_json") or part.get("data")
            if isinstance(b64, str) and len(b64) > 100:
                return base64.b64decode(b64), None
        content = "\n".join(str(p.get("text") or "") for p in content if isinstance(p, dict))

    if isinstance(content, str):
        m_data = re.search(r"data:image/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\r\n]+)", content)
        if m_data:
            return base64.b64decode(re.sub(r"\s+", "", m_data.group(1))), None
        m_md = re.search(r"!\[[^\]]*\]\((https?://[^\s)]+)\)", content)
        if m_md:
            return None, m_md.group(1)
        m_url = re.search(r"(https?://[^\s\"'<>]+\.(?:png|jpg|jpeg|webp)(?:\?[^\s\"'<>]*)?)", content, re.I)
        if m_url:
            return None, m_url.group(1)
    return None, None


async def generate_image(
    *,
    protocol: str,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    ref_images: list[bytes] | None = None,
    size: str | None = None,
    timeout_s: float = 120.0,
) -> tuple[bytes, str]:
    """调用配置好的生图模型 API，返回 (png_bytes, mime)。"""
    proto = protocol if protocol in IMAGE_PROTOCOLS else "openai-images"
    raw_base = (base_url or "").strip().rstrip("/")
    if not raw_base or not model.strip():
        raise ValueError("生图模型未配置完整（需要 Base URL 与模型名）")

    norm_refs = [_prepare_png_bytes(b) for b in (ref_images or []) if b]
    headers: dict[str, str] = {"User-Agent": BROWSER_UA}
    if api_key.strip():
        headers["Authorization"] = f"Bearer {api_key.strip()}"

    async with httpx.AsyncClient(timeout=timeout_s) as client:
        if proto == "openai-images":
            v1 = _normalize_openai_v1(raw_base)
            req_size = (size or "").strip()
            if norm_refs:
                edit_url = f"{v1}/images/edits"
                files = [("image", (f"ref_{i}.png", b, "image/png")) for i, b in enumerate(norm_refs)]
                data_form: dict[str, str] = {
                    "model": model.strip(),
                    "prompt": prompt,
                    "response_format": "b64_json",
                }
                if req_size:
                    data_form["size"] = req_size
                res = await client.post(edit_url, headers=headers, data=data_form, files=files)
                # 部分中转站多图需用 image[] 或不认 response_format
                if res.status_code == 400 and ("response_format" in res.text or "image[]" in res.text or len(norm_refs) > 1):
                    data_form.pop("response_format", None)
                    files_arr = [("image[]", (f"ref_{i}.png", b, "image/png")) for i, b in enumerate(norm_refs)]
                    res2 = await client.post(edit_url, headers=headers, data=data_form, files=files_arr)
                    if res2.status_code < res.status_code:
                        res = res2
                    elif res.status_code == 400:
                        res = await client.post(edit_url, headers=headers, data=data_form, files=files)
            else:
                gen_url = f"{v1}/images/generations"
                payload: dict[str, Any] = {
                    "model": model.strip(),
                    "prompt": prompt,
                    "n": 1,
                    "response_format": "b64_json",
                }
                if req_size:
                    payload["size"] = req_size
                res = await client.post(gen_url, headers={**headers, "Content-Type": "application/json"}, json=payload)
                if res.status_code == 400 and "response_format" in res.text:
                    payload.pop("response_format", None)
                    res = await client.post(gen_url, headers={**headers, "Content-Type": "application/json"}, json=payload)

            if not res.is_success:
                raise RuntimeError(f"生图 API HTTP {res.status_code}: {res.text[:300]}")
            body = res.json()
            item = (body.get("data") or [{}])[0]
            if item.get("b64_json"):
                raw_out = base64.b64decode(item["b64_json"])
                return _prepare_png_bytes(raw_out, max_side=2048), "image/png"
            if item.get("url"):
                raw_out, _ = await _fetch_url_bytes(client, item["url"])
                return _prepare_png_bytes(raw_out, max_side=2048), "image/png"
            raise RuntimeError(f"生图 API 未返回图像数据：{str(body)[:240]}")

        if proto == "openai-chat-image":
            v1 = _normalize_openai_v1(raw_base)
            content_parts: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
            for b in norm_refs:
                b64 = base64.b64encode(b).decode("ascii")
                content_parts.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}})
            payload = {
                "model": model.strip(),
                "messages": [{"role": "user", "content": content_parts}],
                "stream": False,
            }
            res = await client.post(
                f"{v1}/chat/completions",
                headers={**headers, "Content-Type": "application/json"},
                json=payload,
            )
            if not res.is_success:
                raise RuntimeError(f"Chat 生图 API HTTP {res.status_code}: {res.text[:300]}")
            body = res.json()
            raw_bytes, img_url = _extract_image_from_chat_data(body)
            if raw_bytes:
                return _prepare_png_bytes(raw_bytes, max_side=2048), "image/png"
            if img_url:
                raw_out, _ = await _fetch_url_bytes(client, img_url)
                return _prepare_png_bytes(raw_out, max_side=2048), "image/png"
            raise RuntimeError(f"模型未返回图片内容：{str(body)[:240]}")

        # gemini-native
        root = _normalize_gemini_root(raw_base)
        clean_model = model.strip().removeprefix("models/")
        g_url = f"{root}/v1beta/models/{clean_model}:generateContent"
        g_parts: list[dict[str, Any]] = [{"text": prompt}]
        for b in norm_refs:
            g_parts.append({"inline_data": {"mime_type": "image/png", "data": base64.b64encode(b).decode("ascii")}})
        g_headers = {"User-Agent": BROWSER_UA, "Content-Type": "application/json"}
        if api_key.strip():
            g_headers["x-goog-api-key"] = api_key.strip()
        g_payload = {
            "contents": [{"parts": g_parts}],
            "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
        }
        res = await client.post(g_url, headers=g_headers, json=g_payload)
        if not res.is_success:
            raise RuntimeError(f"Gemini 生图 HTTP {res.status_code}: {res.text[:300]}")
        body = res.json()
        for cand in body.get("candidates") or []:
            for part in (cand.get("content") or {}).get("parts") or []:
                inline = part.get("inlineData") or part.get("inline_data")
                if isinstance(inline, dict) and inline.get("data"):
                    raw_out = base64.b64decode(inline["data"])
                    return _prepare_png_bytes(raw_out, max_side=2048), "image/png"
        raise RuntimeError(f"Gemini 生图响应中未包含图片：{str(body)[:240]}")
