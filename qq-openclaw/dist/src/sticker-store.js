/**
 * QQ 图片表情包资产库（借鉴 SnowLuma 生态的「偷图采集 + 语义索引 + 积极度控制 + 按需挑图发送」）：
 * - 存储目录：<stateDir>/stickers/ 与 index.json
 * - 支持两种来源：
 *   1. 对话入站「偷图」：结合同轮多模态视觉分析自动提取情绪与含义标签并去重保存
 *   2. 运营/用户直放图包：扫描目录下 .png/.jpg/.jpeg/.gif/.webp 文件按文件名自动建索引
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const STICKER_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

const MOOD_KEYWORDS = {
  excited: ["开心", "兴奋", "哈哈", "欢呼", "喜欢", "期待", "比心", "棒", "耶"],
  happy: ["开心", "笑", "比心", "得意", "快乐", "摸摸", "贴贴", "喜欢"],
  low: ["抱抱", "委屈", "摸头", "叹气", "安慰", "呜呜", "哭", "难过", "心疼"],
  tired: ["困", "躺平", "摸鱼", "累", "睡觉", "发呆", "哈欠", "喝茶"],
  calm: ["微笑", "点头", "好奇", "喝茶", "发呆", "思考", "ok", "嗯嗯"],
};

function mimeToExt(mime = "", fallbackPath = "") {
  const m = String(mime).toLowerCase();
  if (m.includes("gif")) return ".gif";
  if (m.includes("webp")) return ".webp";
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
  const ext = path.extname(fallbackPath).toLowerCase();
  return STICKER_EXTS.has(ext) ? ext : ".png";
}

function inferMetaFromFilename(fileName) {
  const stem = path.basename(fileName, path.extname(fileName));
  const tokens = stem
    .split(/[_\-\s,，]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    emotion: tokens[0] || "日常",
    desc: tokens.join(" ") || "日常表情包",
    tags: tokens.length ? tokens : ["日常"],
  };
}

export function createStickerStore({
  dir,
  enabled = true,
  autoCollect = true,
  autoFetch = true,
  eagerness = 1,
  maxStickers = 200,
  shellUrl = "http://127.0.0.1:8080",
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log,
} = {}) {
  if (!dir) throw new Error("createStickerStore 需要 dir");
  fs.mkdirSync(dir, { recursive: true });

  const indexFile = path.join(dir, "index.json");
  let items = loadIndex();
  let turnsSinceSticker = 4;
  let lastWebFetchAt = 0;
  let lastWebAttemptAt = 0;
  let webFetchInFlight = null;

  function loadIndex() {
    try {
      if (fs.existsSync(indexFile)) {
        const raw = JSON.parse(fs.readFileSync(indexFile, "utf8"));
        if (Array.isArray(raw?.items)) return raw.items.filter((x) => x?.id && x?.file);
      }
    } catch {}
    return [];
  }

  function saveIndex() {
    try {
      fs.writeFileSync(indexFile, JSON.stringify({ items }, null, 2), "utf8");
    } catch {}
  }

  function pruneIfNeeded() {
    if (items.length <= maxStickers) return;
    items.sort((a, b) => (b.usedCount || 0) * 2 + (b.seenCount || 1) - ((a.usedCount || 0) * 2 + (a.seenCount || 1)));
    const removed = items.splice(maxStickers);
    for (const r of removed) {
      const p = path.join(dir, r.file);
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {}
    }
  }

  function registerBuffer(buf, ext, { emotion, desc, tags, source = "manual", fileNameOverride } = {}) {
    if (!buf?.byteLength || buf.byteLength > 4 * 1024 * 1024) return null;
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const existing = items.find((x) => x.hash === hash);
    if (existing) {
      existing.seenCount = (existing.seenCount || 1) + 1;
      if (desc && (!existing.desc || existing.desc === "日常表情包")) existing.desc = String(desc).slice(0, 60);
      if (emotion && (!existing.emotion || existing.emotion === "日常")) existing.emotion = String(emotion).slice(0, 20);
      if (Array.isArray(tags) && tags.length) {
        existing.tags = Array.from(new Set([...(existing.tags || []), ...tags.map((t) => String(t).trim()).filter(Boolean)])).slice(0, 8);
      }
      saveIndex();
      return { item: existing, created: false };
    }

    const id = `stk-${hash.slice(0, 8)}`;
    const destName = fileNameOverride || `${id}${ext}`;
    const destPath = path.join(dir, destName);
    if (!fs.existsSync(destPath)) {
      fs.writeFileSync(destPath, buf);
    }
    const cleanTags = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : [];
    const entry = {
      id,
      file: destName,
      hash,
      emotion: String(emotion || cleanTags[0] || "日常").slice(0, 20),
      desc: String(desc || cleanTags.join(" ") || "表情包").slice(0, 60),
      tags: cleanTags,
      source,
      seenCount: 1,
      usedCount: 0,
      addedAt: now(),
      lastUsedAt: 0,
    };
    items.push(entry);
    pruneIfNeeded();
    saveIndex();
    return { item: entry, created: true };
  }

  function scanDirectory() {
    let added = 0;
    try {
      const files = fs.readdirSync(dir);
      const indexedFiles = new Set(items.map((x) => x.file));
      for (const f of files) {
        if (f === "index.json") continue;
        const ext = path.extname(f).toLowerCase();
        if (!STICKER_EXTS.has(ext) || indexedFiles.has(f)) continue;
        const full = path.join(dir, f);
        try {
          if (!fs.statSync(full).isFile()) continue;
          const buf = fs.readFileSync(full);
          const meta = inferMetaFromFilename(f);
          const res = registerBuffer(buf, ext, { ...meta, source: "local_pack", fileNameOverride: f });
          if (res?.created) added += 1;
        } catch {}
      }
    } catch {}
    return added;
  }

  // 启动时扫描一次用户放置的表情包图片
  scanDirectory();

  return {
    get enabled() {
      return enabled && eagerness > 0;
    },
    get autoCollect() {
      return enabled && autoCollect;
    },
    get eagerness() {
      return eagerness;
    },
    scanDirectory,

    async collectFromFile(filePath, meta = {}) {
      if (!enabled || !filePath) return null;
      try {
        const buf = await fsp.readFile(filePath);
        const ext = mimeToExt(meta.mime, filePath);
        const res = registerBuffer(buf, ext, { ...meta, source: meta.source || "inbound" });
        if (res?.created) {
          log?.info?.(`[sticker-store] 收藏新表情包 id=${res.item.id} emotion=${res.item.emotion} desc=${res.item.desc}`);
        }
        return res;
      } catch {
        return null;
      }
    },

    canSendThisTurn({ proactive = false, userSentMedia = false } = {}) {
      if (!enabled || eagerness <= 0) return false;
      if (proactive) return eagerness >= 1 && turnsSinceSticker >= 2;
      if (eagerness === 1) return userSentMedia ? turnsSinceSticker >= 2 : turnsSinceSticker >= 4;
      if (eagerness === 2) return userSentMedia ? turnsSinceSticker >= 1 : turnsSinceSticker >= 2;
      return true;
    },

    recordTurn(sentSticker) {
      turnsSinceSticker = sentSticker ? 0 : turnsSinceSticker + 1;
    },

    selectCandidates({ query = "", mood = {}, limit = 8 } = {}) {
      if (!enabled || eagerness <= 0 || !items.length) return [];
      const q = String(query || "").toLowerCase();
      const band = String(mood?.band || "calm").toLowerCase();
      const moodCues = MOOD_KEYWORDS[band] || MOOD_KEYWORDS.calm;

      const scored = [];
      for (const it of items) {
        const fullPath = path.join(dir, it.file);
        if (!fs.existsSync(fullPath)) continue;
        let score = 0;
        const hay = `${it.emotion} ${it.desc} ${(it.tags || []).join(" ")}`.toLowerCase();
        if (q) {
          for (const ch of q.split(/[\s，。！？,.!?]+/).filter(Boolean)) {
            if (hay.includes(ch)) score += 3;
          }
          for (const tag of it.tags || []) {
            if (tag && q.includes(tag.toLowerCase())) score += 4;
          }
        }
        for (const cue of moodCues) {
          if (hay.includes(cue)) score += 2;
        }
        // 降低长期高频重复同一表情的概率
        score += Math.min(2, (it.seenCount || 1) * 0.25) - Math.min(3, (it.usedCount || 0) * 0.2);
        scored.push({ it, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit).map(({ it }) => ({
        id: it.id,
        emotion: it.emotion,
        desc: it.desc,
        tags: it.tags || [],
      }));
    },

    formatPromptBlock(candidates = []) {
      if (!candidates.length) return "";
      return candidates
        .map((c) => `- id=${c.id} | 情绪:${c.emotion} | 含义:${c.desc}`)
        .join("\n");
    },

    resolvePath(id) {
      const cleanId = String(id || "").trim();
      if (!cleanId) return null;
      const found = items.find((x) => x.id === cleanId);
      if (!found) return null;
      const fullPath = path.join(dir, found.file);
      if (!fs.existsSync(fullPath)) return null;
      return { id: found.id, path: fullPath, emotion: found.emotion, desc: found.desc };
    },

    markUsed(id) {
      const found = items.find((x) => x.id === id);
      if (!found) return;
      found.usedCount = (found.usedCount || 0) + 1;
      found.lastUsedAt = now();
      saveIndex();
    },

    stats() {
      return { count: items.length, eagerness, autoCollect, autoFetch };
    },

    /**
     * 联网按心情与上下文关键词自动搜索并扩充表情包库（走壳 /__image/search，安全格式校验+哈希去重）。
     */
    async searchAndCollect({
      mood = {},
      queryHint = "",
      limit = 2,
      cooldownMs = 20 * 60_000,
      force = false,
    } = {}) {
      if (!enabled || !autoFetch || items.length >= maxStickers) {
        return { ok: false, added: 0, reason: "disabled_or_full" };
      }
      if (webFetchInFlight) return webFetchInFlight;
      const t = now();
      if (!force && t - lastWebAttemptAt < 60_000) {
        return { ok: false, added: 0, reason: "attempt_throttled" };
      }
      if (!force && items.length >= 6 && t - lastWebFetchAt < cooldownMs) {
        return { ok: false, added: 0, reason: "cooldown" };
      }
      lastWebAttemptAt = t;

      const cleanHint = String(queryHint || "")
        .replace(/\[QQ表情:([^\]]+)\]/g, " $1 ")
        .replace(/[^\u4e00-\u9fa5A-Za-z0-9\s]/g, " ")
        .trim()
        .slice(0, 12);
      const band = String(mood?.band || "calm").toLowerCase();
      const cues = MOOD_KEYWORDS[band] || MOOD_KEYWORDS.calm;
      const emotion = cleanHint || cues[Math.floor(Math.random() * Math.min(3, cues.length))] || "日常";
      const searchQ = `${emotion} 可爱 表情包`.trim().slice(0, 40);

      webFetchInFlight = (async () => {
        try {
          const base = String(shellUrl || "http://127.0.0.1:8080").replace(/\/+$/, "");
          const res = await fetchImpl(`${base}/__image/search?q=${encodeURIComponent(searchQ)}&n=6`, {
            signal: AbortSignal.timeout?.(4000),
          });
          if (!res.ok) return { ok: false, added: 0, reason: `search_http_${res.status}` };
          const data = await res.json();
          const list = Array.isArray(data?.items) ? data.items : [];
          let added = 0;
          for (const candidate of list) {
            if (added >= limit || items.length >= maxStickers) break;
            const urls = [candidate?.thumb, candidate?.url].filter((u) => typeof u === "string" && /^https?:\/\//i.test(u));
            for (const targetUrl of urls) {
              try {
                const imgRes = await fetchImpl(targetUrl, { signal: AbortSignal.timeout?.(3500) });
                if (!imgRes.ok) continue;
                const ct = String(imgRes.headers.get("content-type") || "").toLowerCase();
                if (!ct.startsWith("image/") || ct.includes("svg")) continue;
                const buf = Buffer.from(await imgRes.arrayBuffer());
                if (buf.byteLength < 1024 || buf.byteLength > 2 * 1024 * 1024) continue;
                const ext = mimeToExt(ct, targetUrl);
                const reg = registerBuffer(buf, ext, {
                  emotion,
                  desc: `${emotion} 表情包`,
                  tags: [emotion, ...cues.slice(0, 3)],
                  source: "web_search",
                });
                if (reg?.created) {
                  added += 1;
                  log?.info?.(`[sticker-store] 联网扩充表情包 id=${reg.item.id} query=${searchQ}`);
                  break;
                }
              } catch {}
            }
          }
          if (added > 0) lastWebFetchAt = now();
          return { ok: added > 0, added, query: searchQ, count: items.length };
        } catch (err) {
          return { ok: false, added: 0, reason: String(err?.message || err) };
        } finally {
          webFetchInFlight = null;
        }
      })();
      return webFetchInFlight;
    },
  };
}
