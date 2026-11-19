// 背景子 Agent（W15）：搜索免费网络图片 → 下载 → 裁成 960×540 → 压到 ≤200KB。
// 搜索/下载都走壳的 /__image/*（无 API key；Bing → Openverse → Wikimedia）。

export function coverRect(sw, sh, dw, dh) {
  const scale = Math.max(dw / sw, dh / sh);
  const cw = dw / scale;
  const ch = dh / scale;
  return { sx: (sw - cw) / 2, sy: (sh - ch) / 2, sw: cw, sh: ch };
}

/** 采样像素判断是否近似单色。 */
export function isMonochrome(samples) {
  if (!samples || samples.length < 8) return true;
  const buckets = new Set();
  let min = 255;
  let max = 0;
  for (const [r, g, b] of samples) {
    buckets.add(`${r >> 4},${g >> 4},${b >> 4}`);
    const lum = (r + g + b) / 3;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
  }
  return buckets.size < 6 || max - min < 12;
}

export function createBgAgent({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  searchUrl = "/__image/search",
  fetchUrl = "/__image/fetch",
  width = 960,
  height = 540,
  maxBytes = 200 * 1024,
} = {}) {
  async function search(query, { n = 8, provider } = {}) {
    const q = String(query ?? "").trim();
    if (!q) return { ok: false, reason: "empty_query", items: [] };
    const params = new URLSearchParams({ q, n: String(n) });
    if (provider) params.set("provider", provider);
    const res = await fetchImpl(`${searchUrl}?${params}`);
    if (!res.ok) return { ok: false, reason: `search_http_${res.status}`, items: [] };
    const data = await res.json();
    return { ok: true, source: data.source || "unknown", items: data.items || [] };
  }

  async function prepare(url) {
    const res = await fetchImpl(`${fetchUrl}?url=${encodeURIComponent(url)}`);
    if (!res.ok) return { ok: false, reason: `fetch_http_${res.status}`, source: url };
    const blob = await res.blob();
    let bmp;
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      return { ok: false, reason: "decode_failed", source: url };
    }
    const { sx, sy, sw, sh } = coverRect(bmp.width, bmp.height, width, height);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, width, height);
    bmp.close?.();

    const pixels = ctx.getImageData(0, 0, width, height).data;
    const samples = [];
    for (let y = 0; y < height; y += 30) {
      for (let x = 0; x < width; x += 30) {
        const i = (y * width + x) * 4;
        samples.push([pixels[i], pixels[i + 1], pixels[i + 2]]);
      }
    }
    if (isMonochrome(samples)) return { ok: false, reason: "monochrome", source: url };

    let out = null;
    for (const quality of [0.85, 0.75, 0.65, 0.55, 0.45]) {
      out = await canvas.convertToBlob({ type: "image/jpeg", quality });
      if (out.size <= maxBytes) break;
    }
    if (!out || out.size > maxBytes) return { ok: false, reason: "too_large", source: url, bytes: out?.size };
    return {
      ok: true,
      bytes: await out.arrayBuffer(),
      type: out.type,
      size: out.size,
      width,
      height,
      source: url,
      ts: now(),
    };
  }

  async function generate(query, { n = 8, provider } = {}) {
    const found = await search(query, { n, provider });
    if (!found.ok) return found;
    const tried = [];
    for (const item of found.items) {
      for (const url of [item.url, item.thumb].filter(Boolean)) {
        const r = await prepare(url);
        tried.push({ url, ok: r.ok, reason: r.reason });
        if (r.ok) return { ...r, query, sourceName: found.source, tried };
      }
    }
    return { ok: false, reason: "no_usable_image", query, tried };
  }

  return { search, prepare, generate };
}
