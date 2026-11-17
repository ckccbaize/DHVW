/**
 * DHVW ARM 宿主运行时：替代 OpenClaw 网关宿主，直接驱动 openclaw-snowluma 的
 * image.ts / dispatch.ts / aggregator.ts / gateway.ts，并将会话、心情、世界状态、
 * 黑话学习、PC 向量记忆检索与回流深度融合进 DHVW ARM 侧。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createStickerStore } from "./sticker-store.js";

function isPrivateOrLoopbackHost(hostname) {
  const h = String(hostname || "").trim().toLowerCase();
  if (!h || h === "localhost" || h === "metadata.google.internal") return true;
  if (net.isIP(h)) {
    if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
    const parts = h.split(".").map(Number);
    if (parts.length === 4) {
      const [a, b] = parts;
      if (a === 127 || a === 10 || a === 0) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
    }
  }
  return false;
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {}
  }
  const s = raw.indexOf("{");
  const e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) {
    try {
      return JSON.parse(raw.slice(s, e + 1));
    } catch {}
  }
  return null;
}

const clampDelta = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-0.15, Math.min(0.15, n)) : 0;
};

export function createDhvwRuntime({
  mediaDir = path.join(os.tmpdir(), "dhvw-qq-media"),
  stateDir = path.join(os.tmpdir(), "dhvw-qq-state"),
  shellUrl = "http://127.0.0.1:8080",
  getLlmConfig = () => ({}),
  getWorldState = () => ({}),
  queryMemory = async () => ({ semantic: false, l0: [], hits: [] }),
  requestEdgeMedia = async () => "",
  emitFeedback = () => {},
  searchWeb = null,
  sticker: stickerCfg = {},
  partDelayMs = 450,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  log,
} = {}) {
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const stickerStore = createStickerStore({
    dir: stickerCfg.dir || path.join(stateDir, "stickers"),
    enabled: stickerCfg.enabled !== false,
    autoCollect: stickerCfg.autoCollect !== false,
    autoFetch: stickerCfg.autoFetch !== false,
    eagerness: stickerCfg.eagerness ?? 1,
    maxStickers: stickerCfg.maxStickers ?? 200,
    shellUrl,
    fetchImpl,
    now,
    log,
  });

  const slangFile = path.join(stateDir, "slang.json");
  const historyFile = path.join(stateDir, "history.json");
  const threadsFile = path.join(stateDir, "threads.json");

  let slang = loadJsonSafe(slangFile, []);
  let chatHistory = loadJsonSafe(historyFile, []);
  let threads = loadJsonSafe(threadsFile, []);
  let lastWeatherMentionedAt = 0;
  const pendingTurns = [];

  const WEATHER_MENTION_RE = /雾|蒙蒙|下雨|小雨|大雨|下雪|暴风|多云|阴天|晴天|天刚蒙亮|刚醒/;
  const USER_ASKED_WEATHER_RE = /雾|晴|雨|雪|风|天气|冷不冷|热吗|外面|那边|天亮|早上|早安/;
  const PHASE_LABELS = {
    morning: "早晨",
    noon: "午间",
    afternoon: "下午",
    evening: "傍晚",
    night: "夜里",
    sleep: "休息时段",
  };
  const WEATHER_LABELS = {
    clear: "晴朗",
    fog: "薄雾",
    rain: "小雨",
    snow: "飘雪",
    cloudy: "多云",
    wind: "微风",
  };
  const PLACE_LABELS = {
    home: "小屋里",
    garden: "院子里",
    study: "书桌旁",
    kitchen: "厨房附近",
  };

  function formatClockHHMM(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  function formatWorldNote(world = {}, { userText = "", nowMs = now(), forceWeather = false } = {}) {
    const phase = PHASE_LABELS[world.phase] || world.phase || "日常";
    const place = world.room || PLACE_LABELS[world.place] || world.place || "小屋";
    const act = world.act && world.act !== "idle" ? `，正在${world.act}` : "";
    const recentHasWeather = chatHistory.slice(-4).some((m) => WEATHER_MENTION_RE.test(String(m?.text || "")));
    const userAskedWeather = USER_ASKED_WEATHER_RE.test(String(userText || ""));
    const allowWeather =
      forceWeather ||
      userAskedWeather ||
      (!recentHasWeather && nowMs - lastWeatherMentionedAt > 30 * 60_000);
    const weatherText = allowWeather
      ? `·天气${WEATHER_LABELS[world.weather] || world.weather || "晴朗"}（若不聊天气可完全不提，禁止生硬播报或“刚醒”套话）`
      : "（近期已提过环境，本轮禁止再提雾/雨/雪/天亮或刚醒，直接接对方的话题）";
    return `现实时间 ${formatClockHHMM(nowMs)}；虚拟仓背景：${phase}·在${place}${act}${weatherText}`;
  }

  function loadJsonSafe(file, fallback) {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
    return fallback;
  }
  function saveJsonSafe(file, val) {
    try {
      fs.writeFileSync(file, JSON.stringify(val, null, 2), "utf8");
    } catch {}
  }

  async function callLlm({ messages, json = true, maxTokens = 700, temperature = 0.85 }) {
    const llm = getLlmConfig() || {};
    if (!llm.baseUrl || !llm.model) throw new Error("LLM 未配置 (baseUrl/model)");
    const body = {
      model: llm.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
      ...(json ? { response_format: { type: "json_object" } } : {}),
      ...(llm.reasoningEffort !== false ? { reasoning_effort: llm.reasoningEffort || "none" } : {}),
    };
    const useShellProxy = llm.useShellProxy === true;
    const url = useShellProxy
      ? `${shellUrl.replace(/\/+$/, "")}/__llm/chat/completions`
      : `${String(llm.baseUrl).replace(/\/+$/, "")}/chat/completions`;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(!useShellProxy && llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
          },
          body: JSON.stringify(useShellProxy ? { baseUrl: llm.baseUrl, apiKey: llm.apiKey, body } : body),
          signal: AbortSignal.timeout(45_000),
        });
        const text = await res.text();
        if (!res.ok) {
          if ((res.status === 429 || res.status >= 500) && attempt < 2) {
            await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
            continue;
          }
          throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = JSON.parse(text);
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== "string") throw new Error("LLM 返回缺少 content");
        return content;
      } catch (err) {
        lastErr = err;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          continue;
        }
      }
    }
    const cause = lastErr?.cause?.code || lastErr?.cause?.message || "";
    throw new Error(`LLM fetch failed after 3 tries: ${lastErr?.message || lastErr}${cause ? ` (${cause})` : ""}`);
  }

  const DICT_JUNK_RE = /百度百科|汉典|笔顺|部首|汉语文字|多音字|书证|康熙字典/;
  const TOPIC_SHIFT_RE = /(聊点?别的|换个话题|换个聊|别聊这?个|说点别的|聊聊别的|换个梗|别提了|不想聊这)/;
  const SHORT_BOUNCE_RE = /^(?:你猜|随便|都可以|都行|你定|你说呢|你挑|换一个)[!！?？。~]*$/;

  function cleanSnippetText(raw = "") {
    return String(raw || "")
      .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n) || 32))
      .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function bigramSet(str = "") {
    const s = String(str || "").replace(/\s+/g, "");
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  }

  function isSimilarThread(a, b) {
    const sa = bigramSet(a);
    const sb = bigramSet(b);
    if (!sa.size || !sb.size) return false;
    let inter = 0;
    for (const g of sa) if (sb.has(g)) inter += 1;
    return inter / Math.min(sa.size, sb.size) >= 0.45;
  }

  const CLICHE_PHRASES = [
    "不过说真的",
    "说真的",
    "讲真",
    "说实话",
    "话说回来",
    "记小本本",
    "踩踩点",
    "踩点",
    "行吧",
  ];

  function buildReplyStyleGuard(history) {
    const recentBot = history.filter((m) => m?.role === "assistant" && m.text).slice(-4);
    if (!recentBot.length) return "";
    const texts = recentBot.map((m) => String(m.text).replace(/\[表情包:[^\]]*\]/g, "").trim());
    const banWords = new Set();
    for (const p of CLICHE_PHRASES) {
      if (texts.some((t) => t.includes(p))) banWords.add(p);
    }
    // 扫描近 4 轮重复出现 >=2 次的高频名词/动作词（如 鲸尾 / 沙发 / 咖啡厅 / 铁打）
    const tokenCounts = new Map();
    for (const t of texts) {
      const tokens = new Set(t.match(/[\u4e00-\u9fa5]{2,4}/g) || []);
      for (const tok of tokens) {
        if (/^(这个|那个|这样|那样|现在|时候|自己|其实|但是|不过|感觉|今天|昨天|晚上|早上|没有|是不是|怎么样|知道)$/.test(tok)) continue;
        tokenCounts.set(tok, (tokenCounts.get(tok) || 0) + 1);
      }
    }
    for (const [tok, cnt] of tokenCounts.entries()) {
      if (cnt >= 2) banWords.add(tok);
    }
    const recent3 = texts.slice(-3);
    const trailingQuestions = recent3.filter((t) => /[？?]\s*$/.test(t)).length;
    const multiPartTurns = texts.slice(-2).filter((t) => t.split(/\n+/).length >= 2 || t.length > 42).length;

    const rules = [];
    if (banWords.size) rules.push(`本轮严禁出现最近用腻的词/口头禅：${[...banWords].slice(0, 6).join("、")}`);
    if (trailingQuestions >= 2) rules.push("最近几轮一直在反问，本轮【禁止以问句收尾】，直接用陈述/接梗/吐槽收住");
    if (multiPartTurns >= 2) rules.push("最近两轮话太多太像模板，本轮请只发【1 条】简短口语（parts 仅填 1 句，<=25 字），不要拆多段");
    return rules.length ? `【防机械对话约束】${rules.join("；")}` : "";
  }

  async function researchSlang(term) {
    const clean = String(term || "").trim().slice(0, 24);
    if (!clean) return;
    if (slang.some((s) => (typeof s === "string" ? s === clean : s?.term === clean))) return;
    try {
      let results = [];
      if (typeof searchWeb === "function") {
        results = await searchWeb(`${clean} 是什么梗 什么意思`);
      } else {
        const res = await fetchImpl(`${shellUrl.replace(/\/+$/, "")}/__search?q=${encodeURIComponent(`${clean} 是什么梗`)}&n=3`);
        if (res.ok) {
          const data = await res.json();
          results = Array.isArray(data?.results) ? data.results : [];
        }
      }
      const useful = results
        .map((r) => cleanSnippetText(`${r.title || ""} ${r.snippet || ""}`))
        .filter((s) => s && !DICT_JUNK_RE.test(s));
      const snippet = useful.slice(0, 2).join(" | ").slice(0, 90);
      if (!snippet) return;
      slang.push({ term: clean, meaning: snippet, learnedAt: now() });
      if (slang.length > 20) slang = slang.slice(-20);
      saveJsonSafe(slangFile, slang);
      emitFeedback({
        facts: [{ text: `学到网络用语「${clean}」的意思：${snippet.slice(0, 70)}`, tier: "L2", conf: 0.78 }],
      });
    } catch {}
  }

  function formatMemoryBlock(mem) {
    const lines = [];
    if (Array.isArray(mem?.l0) && mem.l0.length) {
      lines.push("【核心偏好/设定】");
      for (const f of mem.l0) lines.push(`- ${f.text}`);
    }
    if (Array.isArray(mem?.hits) && mem.hits.length) {
      lines.push(mem.semantic ? "【PC向量语义回忆】" : "【本地回忆】");
      for (const h of mem.hits) lines.push(`- [${h.tier || "L2"}] ${h.text}`);
    }
    return lines.length ? lines.join("\n") : "暂无相关记忆";
  }

  function formatSlangBlock() {
    const cleanItems = slang
      .filter((s) => {
        const txt = typeof s === "string" ? s : `${s?.term || ""} ${s?.meaning || ""}`;
        return txt.trim() && !DICT_JUNK_RE.test(txt);
      })
      .slice(-3)
      .map((s) => (typeof s === "string" ? s.slice(0, 24) : `${s.term}(${String(s.meaning || "").slice(0, 36)})`));
    return cleanItems.length ? `${cleanItems.join("；")}（仅作背景了解，禁止每轮硬套）` : "暂无";
  }

  async function buildMultimodalTurnMessages(promptText, ctx) {
    const mediaList = Array.isArray(ctx.media) ? ctx.media.filter((m) => m?.path) : [];
    if (!mediaList.length) return [{ role: "user", content: promptText }];
    const content = [{ type: "text", text: promptText }];
    for (const m of mediaList.slice(0, 3)) {
      try {
        const buf = await fsp.readFile(m.path);
        const mime = m.contentType || "image/jpeg";
        content.push({
          type: "image_url",
          image_url: { url: `data:${mime};base64,${buf.toString("base64")}` },
        });
      } catch {}
    }
    return [{ role: "user", content }];
  }

  async function runDigestExtraction(transcriptBody) {
    const prompt = [
      "从以下 QQ 对话片段提炼值得长期记住的事实（偏好、约定、近况、关系细节），过滤寒暄。",
      `已有习惯：${formatSlangBlock()}`,
      transcriptBody,
      '严格输出 JSON：{"skip":false,"facts":[{"text":"简短规范陈述句","tier":"L0|L1|L2","conf":0.85}],"thread":"可选未完线头"}；若无值得提取的内容请输出 {"skip":true,"facts":[]}',
    ].join("\n\n");
    const raw = await callLlm({ messages: [{ role: "user", content: prompt }], json: true, maxTokens: 500, temperature: 0.2 });
    const parsed = extractJsonObject(raw);
    if (!parsed || parsed.skip) return "SKIP";
    const facts = Array.isArray(parsed.facts) ? parsed.facts.filter((f) => f?.text) : [];
    if (typeof parsed.thread === "string" && parsed.thread.trim()) {
      runtime.addThread(parsed.thread.trim());
    }
    if (facts.length) {
      log?.info?.(`[dhvw-runtime] digest extracted facts=${facts.length}: ${facts.map((f) => f.text).join(" | ")}`);
      emitFeedback({ facts });
    }
    return "SKIP"; // digest 总结默认沉淀进记忆，不打扰单聊用户
  }

  const runtime = {
    mediaDir,
    stateDir,
    stickerStore,
    formatWorldNote,
    getThreads: () => threads.slice(),
    closeThread: (id) => {
      const t = threads.find((x) => x.id === id);
      if (t) {
        t.closed = true;
        saveJsonSafe(threadsFile, threads);
      }
    },
    addThread: (text) => {
      const clean = String(text || "").trim().slice(0, 80);
      if (!clean) return;
      const existing = threads.find((t) => t && !t.closed && isSimilarThread(t.text, clean));
      if (existing) {
        existing.text = clean;
        existing.resurfaceAt = now() + 3 * 3600_000;
      } else {
        threads.push({ id: `th-${now().toString(36)}`, text: clean, resurfaceAt: now() + 3 * 3600_000, closed: false });
        if (threads.length > 5) threads = threads.slice(-5);
      }
      saveJsonSafe(threadsFile, threads);
    },
    getHistoryText: (limit = 10) => {
      const slice = chatHistory.slice(-limit);
      return slice.length ? slice.map((m) => `${m.role === "user" ? "对方" : "我"}：${m.text}`).join("\n") : "暂无近期对话";
    },
    appendAssistantTurn: (text) => {
      chatHistory.push({ role: "assistant", text, ts: now() });
      if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
      saveJsonSafe(historyFile, chatHistory);
    },
    formatMemoryBlock,
    callLlm,
    channel: {
      activity: {
        record() {},
      },
      commands: {
        resolveCommandAuthorizedFromAuthorizers: () => false,
      },
      routing: {
        resolveAgentRoute: ({ peer }) => ({
          sessionKey: `dhvw:${peer.kind}:${peer.id}`,
          accountId: "default",
          agentId: "dhvw-character",
        }),
      },
      media: {
        async readRemoteMediaBuffer({ url, maxBytes = 8 * 1024 * 1024, requestInit = {}, ssrfPolicy }) {
          const u = new URL(url);
          if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("不支持的媒体协议");
          if (!ssrfPolicy?.allowPrivateNetwork && isPrivateOrLoopbackHost(u.hostname)) {
            throw new Error(`SSRF blocked host: ${u.hostname}`);
          }
          const res = await fetchImpl(url, requestInit);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const arr = Buffer.from(await res.arrayBuffer());
          if (arr.byteLength > maxBytes) throw new Error(`媒体超过上限 (${arr.byteLength} > ${maxBytes})`);
          return {
            buffer: arr,
            contentType: res.headers.get("content-type") || undefined,
            fileName: path.basename(u.pathname) || undefined,
          };
        },
        async saveMediaBuffer(buffer, mime, _scope, _maxBytes, fileName) {
          const ext = mime?.split("/")?.[1]?.split("+")?.[0] || "bin";
          const safeName = `${now()}-${crypto.randomBytes(4).toString("hex")}-${(fileName || `media.${ext}`).replace(/[^A-Za-z0-9._-]/g, "_")}`;
          const dest = path.join(mediaDir, safeName);
          await fsp.writeFile(dest, buffer);
          return { path: dest, contentType: mime };
        },
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }) => body,
        finalizeInboundContext: (ctx) => ctx,
        resolveEffectiveMessagesConfig: () => ({ responsePrefix: "" }),
        async dispatchReplyWithBufferedBlockDispatcher({ ctx, dispatcherOptions }) {
          const { deliver, onError } = dispatcherOptions;
          const world = getWorldState() || {};
          if (world.display === "present" || world.present === true) {
            log?.info?.("[dhvw-runtime] 设备正处于显现模式，QQ 端暂缓抢话");
            return;
          }
          const isSummarisation = !ctx.CommandSource && !ctx.RawBody;
          const bodyText = String(ctx.BodyForAgent || ctx.Body || "");
          const isExplicitSummary = isSummarisation && bodyText.startsWith("以下是这个会话");
          try {
            if (isSummarisation && !isExplicitSummary) {
              const out = await runDigestExtraction(bodyText);
              await deliver({ text: out });
              return;
            }
            if (isExplicitSummary) {
              const summaryText = await callLlm({
                messages: [{ role: "user", content: bodyText }],
                json: false,
                maxTokens: 700,
                temperature: 0.4,
              });
              if (summaryText?.trim()) await deliver({ text: summaryText.trim() });
              return;
            }
            const userText = String(ctx.RawBody || ctx.Body || "").trim();
            const recentUsers = chatHistory.filter((m) => m?.role === "user").slice(-2);
            const isTopicShift =
              TOPIC_SHIFT_RE.test(userText) ||
              (SHORT_BOUNCE_RE.test(userText) && recentUsers.some((m) => TOPIC_SHIFT_RE.test(String(m?.text || ""))));
            if (isTopicShift) {
              for (const t of threads) {
                if (t && !t.closed) t.resurfaceAt = Math.max(t.resurfaceAt || 0, now() + 4 * 3600_000);
              }
              saveJsonSafe(threadsFile, threads);
            }
            const recentHistoryText = isTopicShift ? "（对方要求翻篇开启新话题，禁止延续旧话题）" : runtime.getHistoryText(8);
            const worldNote = formatWorldNote(world, { userText, nowMs: now() });
            chatHistory.push({ role: "user", text: userText, ts: now() });
            pendingTurns.push({ role: "user", text: userText, ts: now() });
            if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);

            const tMemStart = now();
            const QUICK_SEARCH_RE = /(?:查一下|搜一下|帮我查|什么梗|是什么意思|热搜|新闻|最新|查查)/;
            const quickSearchPromise = QUICK_SEARCH_RE.test(userText)
              ? Promise.race([
                  (async () => {
                    try {
                      let hits = [];
                      if (typeof searchWeb === "function") {
                        hits = await searchWeb(userText.slice(0, 50));
                      } else {
                        const r = await fetchImpl(`${shellUrl.replace(/\/+$/, "")}/__search?q=${encodeURIComponent(userText.slice(0, 50))}&n=3`);
                        if (r.ok) {
                          const d = await r.json();
                          hits = Array.isArray(d?.results) ? d.results : [];
                        }
                      }
                      return (hits || [])
                        .slice(0, 3)
                        .map((h) => `- ${h?.title || ""}${h?.snippet ? `：${String(h.snippet).slice(0, 80)}` : ""}`)
                        .filter((s) => s.length > 2)
                        .join("\n");
                    } catch {
                      return "";
                    }
                  })(),
                  new Promise((r) => setTimeout(() => r(""), 2200)),
                ])
              : Promise.resolve("");

            const [mem, quickSearchText] = await Promise.all([
              queryMemory(userText, 6, { band: world.band, dims: world.mood }),
              quickSearchPromise,
            ]);
            log?.info?.(
              `[dhvw-runtime] memory query semantic=${Boolean(mem?.semantic)} hits=${mem?.hits?.length || 0} l0=${mem?.l0?.length || 0} cost=${now() - tMemStart}ms`
            );
            const inboundMedia = Array.isArray(ctx.media) ? ctx.media.filter((m) => m?.path) : [];
            const canSticker = stickerStore.canSendThisTurn({ userSentMedia: inboundMedia.length > 0 });
            if (stickerStore.enabled) {
              if (stickerStore.stats().count < 6) {
                await Promise.race([
                  stickerStore.searchAndCollect({ mood: { band: world.band, dims: world.mood }, queryHint: userText, limit: 2 }),
                  new Promise((r) => setTimeout(r, 2200)),
                ]);
              } else {
                void stickerStore.searchAndCollect({ mood: { band: world.band, dims: world.mood }, queryHint: userText, limit: 1 });
              }
            }
            const stickerCandidates = canSticker
              ? stickerStore.selectCandidates({ query: userText, mood: { band: world.band, dims: world.mood }, limit: 4 })
              : [];
            const stickerHintBlock = stickerCandidates.length
              ? `可用表情包库（极克制使用：大多数纯聊天回合请把 sticker_id 留空，仅在非常搞笑/撒娇/斗图时才偶尔填下列 id 之一）：\n${stickerStore.formatPromptBlock(stickerCandidates)}`
              : "";
            const searchHintBlock = quickSearchText ? `联网搜索参考：\n${quickSearchText}` : "";
            const styleGuardBlock = buildReplyStyleGuard(chatHistory.slice(0, -1));
            const collectHint = inboundMedia.length && stickerStore.autoCollect
              ? "若对方发来的图片是适合日常斗图的表情包，请在 collect_sticker 中填 save:true 及 emotion/desc/tags 进行收藏。"
              : "";

            const topicShiftHint = isTopicShift
              ? "【重要·话题切换指令】对方要求聊点别的（或让你自己起一个新话题）。本轮严禁再提刚才聊过的任何旧词、外号、承诺或约定（例如早茶/咖啡厅/旧称呼），立刻彻底翻篇，主动抛出一个全新且具体的轻松日常话题（比如音乐、美食、趣事、脑洞问题或记忆里的其他爱好），不要反问“你想聊啥”。"
              : "";

            const prompt = [
              "你住在用户的移动虚拟仓里，正在用 QQ 单聊和对方发消息。",
              worldNote,
              `当前心情：${world.band || "calm"} (${JSON.stringify(world.mood || {})})`,
              `长期记忆与偏好：\n${formatMemoryBlock(mem)}`,
              ...(!isTopicShift ? [`熟人习惯与黑话：${formatSlangBlock()}`] : []),
              ...(topicShiftHint ? [topicShiftHint] : []),
              ...(styleGuardBlock ? [styleGuardBlock] : []),
              ...(searchHintBlock ? [searchHintBlock] : []),
              ...(stickerHintBlock ? [stickerHintBlock] : []),
              `最近对话：\n${recentHistoryText}`,
              `对方刚发来：\n${String(ctx.BodyForAgent || ctx.Body || "").replace(/^(?:\[[^\]]+\]\s*)?(?:主人|对方)\s*[:：]\s*/u, "")}`,
              "",
              "请像真人在 QQ 随手打字一样自然接话，严格输出 JSON（不要解释、不要 markdown 代码块）：",
              '{"reply_mode":"reply|short|skip","parts":["自然的一句话(必要时才补第2句)"],"sticker_id":"可选(多数留空)","sticker_only":false,"collect_sticker":{"save":false,"emotion":"","desc":"","tags":[]},"tone":"warm|playful|sleepy|needy|curious","bubble":"总观气泡(<=18字)","mood_delta":{"valence":0.05,"social":-0.06},"slang_note":"仅记录对方常说的独特黑话/新词，普通词留空","unknown_term":"可选想查意思的新词黑话","memory_fact":"可选一句话记住的新事实","thread":"可选后续可再聊的新线头","action":"可选轻动作如rest/read","send_edge_bg":false}',
              `要求：1. 像真人一样变着节奏聊天：多数情况只写 1 句（偶尔才分 2 句），严禁凑成“先复述对方原话感叹→再硬塞鲸尾/屋子动作→最后‘不过说真的’反问”的三段式模板；2. 禁止复读对方刚发的整句话，也不要每轮硬塞人设特征词或说教关心；3. 不要每句话都反问结尾，可用陈述、调侃或吐槽直接收住；4. 严禁连续超过 2 轮咬着同一个梗/约定不放；5. 表情包要克制、宁缺毋滥，只有情绪特别契合或斗图时才发，不想发把 sticker_id 留空；6. 若对方发了 [QQ表情:xxx] 或简称如 /睡请自然互动，若仅道别/敷衍可设 reply_mode=skip。${collectHint}`,
            ].join("\n");

            const messages = await buildMultimodalTurnMessages(prompt, ctx);
            const rawReply = await callLlm({ messages, json: true, maxTokens: 700, temperature: 0.85 });
            const parsed = extractJsonObject(rawReply);

            // 入站「偷图」：结合同轮视觉理解结果将值得收藏的表情图去重落盘
            if (inboundMedia.length && stickerStore.autoCollect && parsed?.collect_sticker?.save === true) {
              const firstImg = inboundMedia[0];
              await stickerStore.collectFromFile(firstImg.path, {
                emotion: parsed.collect_sticker.emotion,
                desc: parsed.collect_sticker.desc,
                tags: parsed.collect_sticker.tags,
                mime: firstImg.contentType,
                source: "inbound",
              });
            }

            const replyMode = String(parsed?.reply_mode || "reply").toLowerCase();
            const isSkip = replyMode === "skip";
            const rawParts = isSkip || parsed?.sticker_only === true
              ? []
              : Array.isArray(parsed?.parts)
                ? parsed.parts.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 3)
                : parsed
                  ? []
                  : [rawReply.trim()].filter(Boolean);

            let edgeMedia = "";
            if (!isSkip && parsed?.send_edge_bg === true) {
              edgeMedia = (await requestEdgeMedia().catch(() => "")) || "";
            }
            const chosenSticker = !isSkip && !edgeMedia && canSticker && parsed?.sticker_id
              ? stickerStore.resolvePath(parsed.sticker_id)
              : null;
            const trailingMedia = edgeMedia || chosenSticker?.path || "";

            if (!isSkip && (rawParts.length || trailingMedia)) {
              for (let i = 0; i < rawParts.length; i++) {
                if (i > 0 && partDelayMs > 0) await new Promise((r) => setTimeout(r, partDelayMs));
                await deliver({ text: rawParts[i] });
              }
              if (trailingMedia) {
                if (rawParts.length && partDelayMs > 0) await new Promise((r) => setTimeout(r, partDelayMs));
                await deliver({ text: "", mediaUrl: trailingMedia });
              }
              if (chosenSticker) stickerStore.markUsed(chosenSticker.id);
              stickerStore.recordTurn(!!chosenSticker);
              const joined = [
                ...rawParts,
                ...(chosenSticker ? [`[表情包:${chosenSticker.desc}]`] : []),
              ].join("\n").trim();
              if (joined) {
                chatHistory.push({ role: "assistant", text: joined, ts: now() });
                pendingTurns.push({ role: "assistant", text: joined, ts: now() });
                if (WEATHER_MENTION_RE.test(joined)) lastWeatherMentionedAt = now();
                if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);
              }
            } else {
              stickerStore.recordTurn(false);
            }
            saveJsonSafe(historyFile, chatHistory);

            const moodDelta = {};
            if (parsed?.mood_delta && typeof parsed.mood_delta === "object") {
              for (const k of ["energy", "valence", "social", "focus"]) {
                const d = clampDelta(parsed.mood_delta[k]);
                if (d !== 0) moodDelta[k] = d;
              }
            } else if (!isSkip) {
              moodDelta.valence = 0.04;
              moodDelta.social = -0.06;
            }

            const facts = [];
            if (typeof parsed?.memory_fact === "string" && parsed.memory_fact.trim()) {
              facts.push({ text: parsed.memory_fact.trim().slice(0, 120), tier: "L2", conf: 0.82 });
            }
            if (facts.length) {
              log?.info?.(`[dhvw-runtime] turn facts=${facts.length}: ${facts.map((f) => f.text).join(" | ")}`);
            }
            if (typeof parsed?.slang_note === "string" && parsed.slang_note.trim()) {
              const note = parsed.slang_note.trim().slice(0, 40);
              if (!DICT_JUNK_RE.test(note) && !slang.some((s) => (typeof s === "string" ? s === note : s?.term === note))) {
                slang.push(note);
                if (slang.length > 20) slang = slang.slice(-20);
                saveJsonSafe(slangFile, slang);
              }
            }
            if (typeof parsed?.thread === "string" && parsed.thread.trim()) {
              runtime.addThread(parsed.thread.trim());
            }
            if (typeof parsed?.unknown_term === "string" && parsed.unknown_term.trim()) {
              void researchSlang(parsed.unknown_term);
            }

            emitFeedback({
              moodDelta,
              bubble: String(parsed?.bubble || (isSkip ? "看到你发的消息啦" : "在 QQ 上聊了几句")).slice(0, 20),
              action: typeof parsed?.action === "string" ? parsed.action.trim() : "",
              facts,
              event: {
                kind: "qq:chat",
                payload: {
                  mode: replyMode,
                  inText: userText.slice(0, 100),
                  outText: rawParts.join(" ").slice(0, 140),
                  stickerId: chosenSticker?.id,
                  semanticMemory: !!mem?.semantic,
                },
              },
            });

            if (pendingTurns.length >= 6) {
              const batchText = pendingTurns.splice(0, pendingTurns.length).map((t) => `${t.role === "user" ? "对方" : "我"}: ${t.text}`).join("\n");
              void runDigestExtraction(batchText).catch(() => {});
            }
          } catch (err) {
            await onError?.(err);
          }
        },
      },
    },
  };

  return runtime;
}
