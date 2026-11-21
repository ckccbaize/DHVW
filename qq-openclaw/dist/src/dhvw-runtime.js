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

function isLocalLlamaProvider(llm = {}) {
  const model = String(llm.model || "");
  const baseUrl = String(llm.baseUrl || "");
  if (/nemotron|gemma/i.test(model)) return true;
  if (String(llm.mode || "").toLowerCase() === "local") return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)|\/(dhvw\/)?llm\/v1/i.test(baseUrl);
}

function looksLikeJsonText(text = "") {
  const s = String(text || "").trim();
  return /^[\{\[]|```(?:json)?|"(?:reply_mode|parts|sticker_id|bubble)"\s*:/i.test(s);
}

function extractPartialJsonParts(text = "") {
  const m = /"parts"\s*:\s*\[([\s\S]*)/i.exec(String(text || ""));
  if (!m) return [];
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"/g;
  let match;
  while ((match = re.exec(m[1])) !== null) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`).trim();
      if (decoded) out.push(decoded);
    } catch {}
    if (out.length >= 3) break;
  }
  return out;
}

function extractJsonObject(text) {
  const raw = String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
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
  getImageGenConfig = () => ({}),
  getPersonaConfig = () => ({}),
  getRef3dPath = () => "",
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
  let lastLlmError = "";
  let lastImageGenError = "";
  const pendingTurns = [];
  const BROWSER_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

  function normalizeOpenAiBase(rawUrl = "") {
    const s = String(rawUrl || "").trim().replace(/\/+$/, "");
    if (!s) return "";
    return /\/v\d+$/i.test(s) ? s : `${s}/v1`;
  }

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
    const baseUrl = normalizeOpenAiBase(llm.baseUrl);
    if (!baseUrl || !llm.model) throw new Error("LLM 未配置 (baseUrl/model)");
    const localMode = isLocalLlamaProvider(llm);
    let includePenalties = llm.usePenalties !== false;
    // 本地 llama 不关闭思考也不锁定 max_tokens，可保留 json_object 约束而不被截断
    let useJsonFormat = json;
    let includeReasoning = !localMode && llm.reasoningEffort !== false;
    let viaProxy = llm.useShellProxy === true;
    const effectiveTemp = localMode
      ? temperature <= 0.4
        ? Math.min(0.65, Number((temperature + 0.25).toFixed(2)))
        : Math.min(1.2, Number((Math.max(temperature, 1.0) + 0.05).toFixed(2)))
      : temperature;
    const buildBody = () => ({
      model: llm.model,
      messages,
      ...(!localMode ? { max_tokens: maxTokens } : {}),
      temperature: effectiveTemp,
      stream: false,
      ...(includePenalties
        ? {
            frequency_penalty: llm.frequencyPenalty ?? (localMode ? 0.15 : 0.45),
            presence_penalty: llm.presencePenalty ?? (localMode ? 0.1 : 0.35),
          }
        : {}),
      ...(useJsonFormat ? { response_format: { type: "json_object" } } : {}),
      ...(includeReasoning ? { reasoning_effort: llm.reasoningEffort || "none" } : {}),
    });
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const url = viaProxy
        ? `${shellUrl.replace(/\/+$/, "")}/__llm/chat/completions`
        : `${baseUrl}/chat/completions`;
      try {
        const body = buildBody();
        const res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": BROWSER_UA,
            ...(!viaProxy && llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
          },
          body: JSON.stringify(viaProxy ? { baseUrl, apiKey: llm.apiKey, body } : body),
          signal: AbortSignal.timeout(localMode ? 120_000 : 45_000),
        });
        const text = await res.text();
        if (!res.ok) {
          if (res.status === 400) {
            if (includePenalties && /frequency_penalty|presence_penalty/i.test(text)) {
              includePenalties = false;
              continue;
            }
            if (useJsonFormat && /response_format|json_object/i.test(text)) {
              useJsonFormat = false;
              continue;
            }
            if (includeReasoning && /reasoning_effort/i.test(text)) {
              includeReasoning = false;
              continue;
            }
            if (useJsonFormat || includeReasoning || includePenalties) {
              useJsonFormat = false;
              includeReasoning = false;
              includePenalties = false;
              continue;
            }
          }
          if (!viaProxy && res.status === 403 && shellUrl) {
            viaProxy = true;
            lastErr = new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
            continue;
          }
          if ((res.status === 429 || res.status >= 500) && attempt < 3) {
            await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
            continue;
          }
          throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = JSON.parse(text);
        const choice = data?.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== "string") throw new Error("LLM 返回缺少 content");
        if (json && !extractJsonObject(content) && attempt < 3) {
          useJsonFormat = false;
          continue;
        }
        lastLlmError = "";
        return content;
      } catch (err) {
        lastErr = err;
        if (!viaProxy && shellUrl && attempt === 1) {
          viaProxy = true;
          continue;
        }
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          continue;
        }
      }
    }
    const cause = lastErr?.cause?.code || lastErr?.cause?.message || "";
    const detail = `LLM fetch failed after retries: ${lastErr?.message || lastErr}${cause ? ` (${cause})` : ""}`;
    lastLlmError = detail;
    log?.warn?.(`[dhvw-runtime] ${detail} (url=${baseUrl}, model=${llm.model})`);
    throw new Error(detail);
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
  ];

  const NEUTRAL_HEDGE_RE = /(?:各有各的|都不错|挺好(?:的|看|听|玩)?|还行吧|挺经典|看个人|顺其自然|慢慢来|先别[写了做想动]|放一边|劳逸结合|需要下班|别太累|也挺好|都可以|有道理|好哭|后劲[儿]?大)/;
  const PARTICLE_RE = /[呀啊呢吧嘛哇哦哼切唉诶咧咯捏哒啦哈呗]/u;

  const FEW_SHOT_STYLE_BLOCK = [
    "说话节奏参考（真人 QQ 斗嘴长短起伏大，既有鲜明态度和俏皮吐槽，也要自然带点口语语气词才鲜活，不能干巴巴甩硬句）：",
    "- 极短吐槽/傲娇（4~9字）：“你也太能鸽了吧” / “切，就这？我不信”",
    "- 连发 2 条带语气抬杠：[\"拉倒吧你\", \"黄焖鸡配米饭明明吊打沙县嘛，谁选清汤谁冤大头好吧\"]",
    "- 明确站队+灵动接梗（有立场不生硬）：\"三秋缒前面是有点装没错啦，但卖掉寿命那段够狠，我偏心这本咧\"",
    "- 俏皮反呛带尾音：“想得美呀，先把昨天欠我的夜宵算清楚再说哼”",
  ].join("\n");

  function getOpeningStarter(text = "") {
    const s = String(text || "").replace(/^\s*\[[^\]]+\]\s*/, "").trim();
    if (!s) return "";
    const m = s.match(/^(那我|那你|这|那|不过|其实|话说|行吧|好吧|不是|哈\？?|哦|诶|唔|嗯|切|哼|哇|嘿|哎呀?)/);
    if (m) return m[1];
    return s.slice(0, 2);
  }

  function buildReplyStyleGuard(history, { localMode = false } = {}) {
    const recentBot = history.filter((m) => m?.role === "assistant" && m.text).slice(-4);
    if (!recentBot.length) return "";
    const texts = recentBot.map((m) => String(m.text).replace(/\[表情包:[^\]]*\]/g, "").trim()).filter(Boolean);
    if (!texts.length) return "";
    const banWords = new Set();
    for (const p of CLICHE_PHRASES) {
      if (texts.some((t) => t.includes(p))) banWords.add(p);
    }
    // 扫描近 4 轮重复出现 >=2 次的高频名词/动作词
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
    const bannedStarts = new Set();
    const lastStart = getOpeningStarter(texts[texts.length - 1]);
    if (lastStart) bannedStarts.add(lastStart);
    const startFreq = new Map();
    for (const t of recent3) {
      const st = getOpeningStarter(t);
      if (st) startFreq.set(st, (startFreq.get(st) || 0) + 1);
    }
    for (const [st, cnt] of startFreq.entries()) {
      if (cnt >= 2) bannedStarts.add(st);
    }

    const trailingQuestions = recent3.filter((t) => /[？?]\s*$/.test(t)).length;
    const multiPartTurns = texts.slice(-2).filter((t) => t.split(/\n+/).length >= 2 || t.length > 42).length;
    const lens = recent3.map((t) => t.replace(/\s+/g, "").length);
    const tightLengthBand = lens.length >= 2 && Math.max(...lens) - Math.min(...lens) <= 10;
    const blandNeutralHits = recent3.filter(
      (t) => NEUTRAL_HEDGE_RE.test(t) || !/[!！?？哼切哈呀啊卧槽牛离谱扯算拉倒嫌烦偏]/u.test(t),
    ).length;
    const dryNoParticleHits = recent3.filter((t) => !PARTICLE_RE.test(t)).length;
    const prevLastParticle = (texts[texts.length - 1].match(/[呀啊呢吧嘛哇哦哼切唉诶咧咯捏哒啦哈呗](?=[！!？?~～\s]*$)/u) || [])[0] || "";

    const rules = [];
    if (bannedStarts.size) {
      rules.push(`本轮严禁再以「${[...bannedStarts].slice(0, 3).join(" / ")}」开头，换全新起手式`);
    }
    if (banWords.size) rules.push(`严禁复用最近高频词/套话：${[...banWords].slice(0, 6).join("、")}`);
    if (prevLastParticle) rules.push(`上轮刚用过尾音「${prevLastParticle}」，本轮换别的语气词（如 呀/嘛/啦/咧/哼/咯 等）或直接收住，别连着用同一个尾音`);
    if (!localMode && trailingQuestions >= 2) rules.push("最近几轮总在反问，本轮【禁止以问句收尾】，直接陈述/接梗/吐槽收住");
    if (blandNeutralHits >= 2) {
      rules.push("【拒绝端水与老好人】最近几轮太温和像标准安慰机器人！这轮必须鲜明站队、毒舌挑刺或带点傲娇小脾气，禁止用“挺好/各有优势/放一边/先歇着”打圆场");
    }
    if (!localMode && dryNoParticleHits >= 2) {
      rules.push("最近几句语气词太少显得生硬，这轮适当自然加上「嘛/呀/吧/咧/哼/切/呗」这类口语尾音，让俏皮感活起来（自然带 1~2 处即可，别刻意堆砌）");
    }

    if (!localMode) {
      if (multiPartTurns >= 2) {
        rules.push("最近两轮话太多太像模板，本轮请只发【1 条】简短口语（parts 仅填 1 句，4~18 字），不要拆多段");
      } else {
        const mode = Math.floor(history.length / 2) % 3;
        if (mode === 0) {
          rules.push("【本轮节奏：极短单句】parts 数组只能有 1 个元素且总字数 4~10 字（禁止拆第 2 条气泡，不要长评价）");
        } else if (mode === 1) {
          rules.push("【本轮节奏：连发两条气泡】parts 填 2 条（气泡1用 2~6 字短槽点/感叹，气泡2用 10~24 字具体接话或细节追问）");
        } else if (tightLengthBand) {
          rules.push("【本轮节奏：换结构】最近字数太齐，这次直接针对内容里的一个具体细节接话（14~28字，禁用“这X也太…”模板）");
        }
      }
    }
    return rules.length ? `【防机械对话约束】${rules.join("；")}` : "";
  }

  async function runWebSearch(query, maxHits = 3) {
    const clean = String(query || "").trim();
    if (!clean) return [];
    try {
      if (typeof searchWeb === "function") {
        const res = await searchWeb(clean);
        return Array.isArray(res) ? res.slice(0, maxHits) : [];
      }
      const r = await fetchImpl(`${shellUrl.replace(/\/+$/, "")}/__search?q=${encodeURIComponent(clean)}&n=${maxHits}`);
      if (!r.ok) return [];
      const d = await r.json();
      return Array.isArray(d?.results) ? d.results.slice(0, maxHits) : [];
    } catch {
      return [];
    }
  }

  async function researchSlang(term) {
    const clean = String(term || "").trim().slice(0, 24);
    if (!clean) return;
    if (slang.some((s) => (typeof s === "string" ? s === clean : s?.term === clean))) return;
    try {
      const results = await runWebSearch(`${clean} 是什么梗 什么意思`, 3);
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
    const supportsVision = getLlmConfig()?.supportsVision === true;
    if (!mediaList.length) return [{ role: "user", content: promptText }];
    if (!supportsVision) {
      return [{
        role: "user",
        content: `${promptText}\n\n[提示：对方刚发送了 ${mediaList.length} 张图片，但当前 LLM 未勾选支持识图功能，请根据上下文自然回应或坦白暂时看不到图片细节]`,
      }];
    }
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

  const DEFAULT_FUSION_STYLE_PROMPT = [
    "画风与笔触：日系二次元角色融合厚涂（Impasto）与数字水彩质感，线条纤细柔和，光影过渡自然，带有半写实的立体感与微妙的颗粒噪点。",
    "光影与摄影感：极强的电影镜头语言，主打逆光（Backlighting）、体积光（Volumetric Lighting）与丁达尔效应。大量运用浅景深（Shallow Depth of Field）、前景虚化以及夜景光斑（Bokeh），边缘光（Rim Light）勾勒发丝与衣物轮廓。",
    "色彩基调：低饱和度、清冷通透的电影调色（Muted/Desaturated Color Palette），高光带有柔和的暖色调或朦胧雾感（Haze/Glow），明暗对比柔和且富有空气感。",
  ].join("\n");

  function buildSceneFusionPrompt({ insertPosition = "", characterPose = "", lightingMood = "", sceneDesc = "", stylePrompt } = {}) {
    const resolvedStyle =
      typeof stylePrompt === "string" ? stylePrompt.trim() : DEFAULT_FUSION_STYLE_PROMPT;
    return [
      "Image 1 is the real-world scene/lifestyle photograph. Image 2 is the character 3D/turnaround reference sheet.",
      "Re-render and seamlessly integrate the character from Image 2 directly into the scene of Image 1 using full generative image synthesis (never perform flat cutout pasting; naturally re-paint light interaction, contact shadows, atmospheric haze, and perspective depth).",
      `Placement & depth: place the character at [${String(insertPosition || "a natural foreground or midground spot in the scene").trim()}]. Respect perspective, realistic proportions, depth occlusion by nearby objects, and physical surface contact.`,
      `Pose & expression: [${String(characterPose || "standing or sitting naturally while interacting warmly with the surroundings").trim()}]. Keep the pose lively, creative, and physically grounded.`,
      `Scene lighting & color harmony: [${String(lightingMood || "match exact light direction, soft contact shadows, ambient occlusion, color temperature, and lens bokeh of Image 1").trim()}].`,
      "Preservation rules: keep Image 1's environment, layout, and objects coherent; strictly keep Image 2 character's hair, eyes, outfit, and iconic accessories consistent.",
      "NO text, NO captions, NO watermarks, NO collage frames, NO split screen.",
      ...(sceneDesc ? [`Scene context: ${String(sceneDesc).trim()}`] : []),
      ...(resolvedStyle
        ? [`Style, cinematography & color grading aesthetic (apply cohesively across the integrated image):\n${resolvedStyle}`]
        : []),
    ].join("\n");
  }

  function extractChatImagePayload(data) {
    const msg = data?.choices?.[0]?.message || {};
    if (Array.isArray(msg.images)) {
      for (const item of msg.images) {
        const u = item?.image_url?.url || item?.url || "";
        if (u.startsWith("data:image/")) return { buf: Buffer.from(u.slice(u.indexOf(",") + 1), "base64") };
        if (u.startsWith("http")) return { url: u };
      }
    }
    let content = msg.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "image_url" && part?.image_url?.url) {
          const u = part.image_url.url;
          if (u.startsWith("data:image/")) return { buf: Buffer.from(u.slice(u.indexOf(",") + 1), "base64") };
          if (u.startsWith("http")) return { url: u };
        }
        const b64 = part?.b64_json || part?.data;
        if (typeof b64 === "string" && b64.length > 100) return { buf: Buffer.from(b64, "base64") };
      }
      content = content.map((p) => p?.text || "").join("\n");
    }
    if (typeof content === "string") {
      const mData = /data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\r\n]+)/.exec(content);
      if (mData) return { buf: Buffer.from(mData[1].replace(/\s+/g, ""), "base64") };
      const mMd = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/.exec(content);
      if (mMd) return { url: mMd[1] };
      const mUrl = /(https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp)(?:\?[^\s"'<>]*)?)/i.exec(content);
      if (mUrl) return { url: mUrl[1] };
    }
    return {};
  }

  function buildLifePhotoPrompt({
    sceneDesc = "",
    characterPose = "",
    cameraFraming = "",
    lightingMood = "",
    characterNote = "",
    stylePrompt,
  } = {}) {
    const resolvedStyle =
      typeof stylePrompt === "string" ? stylePrompt.trim() : DEFAULT_FUSION_STYLE_PROMPT;
    return [
      "Image 1 is ONLY the character's 3D/turnaround reference design sheet.",
      "CRITICAL COMPOSITION RULE: Generate a SINGLE standalone, cohesive candid lifestyle photograph starring this exact character from Image 1. NEVER output multi-view orthographics, character sheet panels, split grids, plain white studio background, or UI borders.",
      `Environment & lived-in daily scene: [${String(sceneDesc || "a cozy sunlit bedroom desk or quiet street cafe corner matching the character's current daily life").trim()}]. Render rich realistic background details and spatial depth around the character.`,
      `Camera framing & perspective: [${String(cameraFraming || "natural 3/4 waist-up candid snapshot or casual handheld selfie perspective looking naturally toward the viewer").trim()}].`,
      `Pose, expression & action: [${String(characterPose || "relaxed natural expression and lively posture interacting with objects in the scene").trim()}].`,
      `Lighting & atmosphere: [${String(lightingMood || "natural window light or warm indoor lamp ambiance with soft shadows and cinematic depth of field").trim()}].`,
      ...(characterNote ? [`Character persona context: ${String(characterNote).trim()}`] : []),
      "Character consistency: strictly keep Image 1's hair style, hair color, eyes, facial traits, outfit, and signature accessories/tail/ear silhouette consistent.",
      "NO text, NO captions, NO watermarks, NO collage frames, NO turnaround sheets.",
      ...(resolvedStyle
        ? [`Style, cinematography & color grading aesthetic (apply cohesively across the lifestyle photograph):\n${resolvedStyle}`]
        : []),
    ].join("\n");
  }

  function extractCharacterCues(l0Facts = []) {
    const p = getPersonaConfig() || {};
    const cues = [];
    if (Array.isArray(p.stickerCues)) {
      for (const c of p.stickerCues) if (String(c || "").trim()) cues.push(String(c).trim());
    }
    const sources = [
      String(p.characterName || p.name || ""),
      String(p.personaPrompt || p.prompt || ""),
      ...(Array.isArray(l0Facts) ? l0Facts.map((f) => String(f?.text || f || "")) : []),
    ]
      .join(" ")
      .trim();
    const archetypeMatches = sources.match(/[\u4e00-\u9fa5]{1,5}(?:娘|酱|姬|猫娘|狐娘|兔娘|龙娘|鱼娘|大肥鱼|鲸鱼娘)/g) || [];
    for (const m of archetypeMatches) {
      if (!/^(?:小姑|大姑|老板|大爷|阿姨|老奶奶)$/.test(m)) cues.push(m);
    }
    if (/大肥鱼/.test(sources) && !cues.includes("大肥鱼")) cues.push("大肥鱼");
    if (/鲸鱼/.test(sources) && !cues.includes("鲸鱼娘")) cues.push("鲸鱼娘");
    const nameClean = String(p.characterName || p.name || "").trim();
    if (nameClean && !/^(?:数字人|助手|小助手|小仓)$/.test(nameClean)) cues.push(nameClean);
    return Array.from(new Set(cues.filter((s) => s.length >= 2 && s.length <= 16))).slice(0, 5);
  }

  async function callImageGenApi({ prompt, images = [], outPrefix = "img" }) {
    const ig = getImageGenConfig() || {};
    if (!ig.enabled || !ig.baseUrl || !ig.model) {
      throw new Error("生图模型未启用或配置不完整");
    }
    const proto = String(ig.protocol || "openai-images");
    const rawBase = String(ig.baseUrl).trim().replace(/\/+$/, "");
    const apiKey = String(ig.apiKey || "").trim();
    const model = String(ig.model).trim();

    let outBuf = null;
    if (proto === "openai-images") {
      const v1 = /\/v\d+$/i.test(rawBase) ? rawBase : `${rawBase}/v1`;
      const makeForm = (fieldName, withRespFmt) => {
        const form = new FormData();
        form.append("model", model);
        form.append("prompt", prompt);
        if (withRespFmt) form.append("response_format", "b64_json");
        for (const im of images) {
          form.append(fieldName, new Blob([im.buf], { type: im.mime || "image/png" }), im.name || "ref.png");
        }
        return form;
      };
      const headers = {
        "User-Agent": BROWSER_UA,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
      let res = await fetchImpl(`${v1}/images/edits`, { method: "POST", headers, body: makeForm("image", true), signal: AbortSignal.timeout(120_000) });
      if (res.status === 400) {
        const resArr = await fetchImpl(`${v1}/images/edits`, { method: "POST", headers, body: makeForm("image[]", false), signal: AbortSignal.timeout(120_000) });
        if (resArr.ok || resArr.status < res.status) {
          res = resArr;
        } else {
          const resPlain = await fetchImpl(`${v1}/images/edits`, { method: "POST", headers, body: makeForm("image", false), signal: AbortSignal.timeout(120_000) });
          if (resPlain.ok || resPlain.status < res.status) res = resPlain;
        }
      }
      if (!res.ok) throw new Error(`生图 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = await res.json();
      const item = body?.data?.[0] || {};
      if (item.b64_json) outBuf = Buffer.from(item.b64_json, "base64");
      else if (item.url) {
        const rImg = await fetchImpl(item.url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(60_000) });
        if (!rImg.ok) throw new Error(`拉取生图结果失败 HTTP ${rImg.status}`);
        outBuf = Buffer.from(await rImg.arrayBuffer());
      }
    } else if (proto === "openai-chat-image") {
      const v1 = /\/v\d+$/i.test(rawBase) ? rawBase : `${rawBase}/v1`;
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": BROWSER_UA,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      };
      const body = {
        model,
        stream: false,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...images.map((im) => ({
              type: "image_url",
              image_url: { url: `data:${im.mime || "image/png"};base64,${im.buf.toString("base64")}` },
            })),
          ],
        }],
      };
      const res = await fetchImpl(`${v1}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`Chat 生图 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const ext = extractChatImagePayload(await res.json());
      if (ext.buf) outBuf = ext.buf;
      else if (ext.url) {
        const rImg = await fetchImpl(ext.url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(60_000) });
        if (!rImg.ok) throw new Error(`拉取生图结果失败 HTTP ${rImg.status}`);
        outBuf = Buffer.from(await rImg.arrayBuffer());
      }
    } else {
      const root = rawBase.replace(/\/v1beta$/i, "").replace(/\/v1$/i, "");
      const cleanModel = model.replace(/^models\//, "");
      const headers = {
        "Content-Type": "application/json",
        "User-Agent": BROWSER_UA,
        ...(apiKey ? { "x-goog-api-key": apiKey } : {}),
      };
      const body = {
        contents: [{
          parts: [
            { text: prompt },
            ...images.map((im) => ({ inline_data: { mime_type: im.mime || "image/png", data: im.buf.toString("base64") } })),
          ],
        }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      };
      const res = await fetchImpl(`${root}/v1beta/models/${cleanModel}:generateContent`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`Gemini 生图 HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      for (const cand of data?.candidates || []) {
        for (const p of cand?.content?.parts || []) {
          const inl = p?.inlineData || p?.inline_data;
          if (inl?.data) {
            outBuf = Buffer.from(inl.data, "base64");
            break;
          }
        }
        if (outBuf) break;
      }
    }

    if (!outBuf || outBuf.byteLength < 64) {
      throw new Error("生图 API 未返回有效图片数据");
    }
    const dest = path.join(mediaDir, `${outPrefix}-${now()}-${crypto.randomBytes(4).toString("hex")}.png`);
    await fsp.writeFile(dest, outBuf);
    return dest;
  }

  async function generateFusedPhoto({ userImagePath, ref3dPath, insertPosition, characterPose, lightingMood, sceneDesc }) {
    const ig = getImageGenConfig() || {};
    const [sceneBuf, refBuf] = await Promise.all([fsp.readFile(userImagePath), fsp.readFile(ref3dPath)]);
    const prompt = buildSceneFusionPrompt({
      insertPosition,
      characterPose,
      lightingMood,
      sceneDesc,
      stylePrompt: typeof ig.fusionStylePrompt === "string" ? ig.fusionStylePrompt : undefined,
    });
    return callImageGenApi({
      prompt,
      images: [
        { buf: sceneBuf, mime: "image/jpeg", name: "scene.jpg" },
        { buf: refBuf, mime: "image/png", name: "character_ref.png" },
      ],
      outPrefix: "fusion",
    });
  }

  async function generateLifePhoto({ sceneDesc, characterPose, cameraFraming, lightingMood } = {}) {
    const ig = getImageGenConfig() || {};
    const ref3dPath = getRef3dPath() || "";
    if (!ig.enabled || !ig.baseUrl || !ig.model || !ref3dPath || !fs.existsSync(ref3dPath)) {
      throw new Error("生活照生图条件未就绪（需启用生图模型并上传三维参考图）");
    }
    const refBuf = await fsp.readFile(ref3dPath);
    const p = getPersonaConfig() || {};
    const cues = stickerStore.characterCues;
    const characterNote = [p.characterName || p.name, cues.join("、")].filter(Boolean).join(" / ");
    const prompt = buildLifePhotoPrompt({
      sceneDesc,
      characterPose,
      cameraFraming,
      lightingMood,
      characterNote,
      stylePrompt: typeof ig.fusionStylePrompt === "string" ? ig.fusionStylePrompt : undefined,
    });
    const dest = await callImageGenApi({
      prompt,
      images: [{ buf: refBuf, mime: "image/png", name: "character_ref.png" }],
      outPrefix: "life",
    });
    lastImageGenError = "";
    return dest;
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

  const THREAD_MAX_AGE_MS = 2 * 3600_000;
  const THREAD_RESURFACE_DELAY_MS = 45 * 60_000;
  const TOPIC_EXTRACT_STOP_RE =
    /^(?:这个|那个|这样|那样|现在|时候|自己|其实|但是|不过|感觉|今天|昨天|晚上|早上|上午|下午|没有|是不是|怎么样|知道|什么|为什么|怎么|可以|应该|还是|或者|就是|而且|因为|所以|对方|主人|鲸鱼|大肥鱼|图片|表情包|主动|日常|近况|生活照|场景|融图|哈哈哈?|啊啊啊?|有点|真的|真是|别再|再提|还是|太好|不错|神奇|离谱)$/;

  function extractTopicTokens(text = "") {
    const clean = String(text || "").replace(/\[表情包:[^\]]*\]|\[[^\]]*生活照[^\]]*\]|\[场景融图\]/g, " ");
    const out = new Set();
    const chunks = clean.split(/[的了了吗呢吧呀啊哇嘛是在和与及跟对给把被让就也都还太真好很\s，,。\.！？!\?~～…、：:]+/);
    for (const seg of chunks) {
      for (const run of seg.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
        if (run.length <= 4 && !TOPIC_EXTRACT_STOP_RE.test(run)) {
          out.add(run);
        }
        if (run.length > 2) {
          for (let i = 0; i <= run.length - 2; i++) {
            const bg = run.slice(i, i + 2);
            if (!TOPIC_EXTRACT_STOP_RE.test(bg)) out.add(bg);
            if (i <= run.length - 3) {
              const tg = run.slice(i, i + 3);
              if (!TOPIC_EXTRACT_STOP_RE.test(tg)) out.add(tg);
            }
          }
        }
      }
    }
    return [...out];
  }

  function isThreadExpired(t, curNow = now()) {
    if (!t || t.closed) return true;
    if (t.expiresAt && t.expiresAt <= curNow) return true;
    if (t.createdAt && curNow - t.createdAt > THREAD_MAX_AGE_MS) return true;
    // 兼容旧版未写 createdAt/expiresAt 的持久化线头：按原 resurfaceAt - 3h 推算创建时间，超 2 小时直接淘汰
    if (!t.createdAt && !t.expiresAt && t.resurfaceAt && curNow - (t.resurfaceAt - 3 * 3600_000) > THREAD_MAX_AGE_MS) {
      return true;
    }
    return false;
  }

  function pruneThreads({ activeText = "", countTurn = false, closeAll = false } = {}) {
    const curNow = now();
    let changed = false;
    const next = [];
    for (const t of threads) {
      if (!t) {
        changed = true;
        continue;
      }
      if (closeAll && !t.closed) {
        t.closed = true;
        changed = true;
        continue;
      }
      if (isThreadExpired(t, curNow)) {
        changed = true;
        continue;
      }
      if (countTurn && activeText) {
        const toks = (String(t.text || "").match(/[\u4e00-\u9fa5]{2,4}/g) || []).filter((w) => !TOPIC_EXTRACT_STOP_RE.test(w));
        const mentioned = toks.some((w) => activeText.includes(w));
        if (!mentioned) {
          t.turnsSince = (t.turnsSince || 0) + 1;
          if (t.turnsSince >= 3) {
            t.closed = true;
            changed = true;
            continue;
          }
          changed = true;
        } else if (t.turnsSince) {
          t.turnsSince = 0;
          changed = true;
        }
      }
      next.push(t);
    }
    if (changed) {
      threads = next.slice(-2);
      saveJsonSafe(threadsFile, threads);
    }
  }

  const runtime = {
    mediaDir,
    stateDir,
    stickerStore,
    formatWorldNote,
    fewShotStyleBlock: FEW_SHOT_STYLE_BLOCK,
    searchWeb: runWebSearch,
    getStyleGuard: () => buildReplyStyleGuard(chatHistory),
    getThreads: () => {
      pruneThreads();
      const curNow = now();
      return threads.filter((t) => !isThreadExpired(t, curNow)).slice();
    },
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
      pruneThreads();
      const curNow = now();
      const existing = threads.find((t) => t && !t.closed && isSimilarThread(t.text, clean));
      if (existing) {
        existing.text = clean;
        existing.createdAt = existing.createdAt || curNow;
        existing.resurfaceAt = curNow + THREAD_RESURFACE_DELAY_MS;
        existing.expiresAt = curNow + THREAD_MAX_AGE_MS;
        existing.turnsSince = 0;
      } else {
        threads.push({
          id: `th-${curNow.toString(36)}`,
          text: clean,
          createdAt: curNow,
          resurfaceAt: curNow + THREAD_RESURFACE_DELAY_MS,
          expiresAt: curNow + THREAD_MAX_AGE_MS,
          turnsSince: 0,
          closed: false,
        });
        if (threads.length > 2) threads = threads.slice(-2);
      }
      saveJsonSafe(threadsFile, threads);
    },
    getForbiddenProactiveTopics: (limit = 8) => {
      const counts = new Map();
      const recentSlice = chatHistory.slice(-10);
      for (const m of recentSlice) {
        for (const tok of extractTopicTokens(m?.text || "")) {
          counts.set(tok, (counts.get(tok) || 0) + 1);
        }
      }
      for (const t of threads) {
        for (const tok of extractTopicTokens(t?.text || "")) {
          counts.set(tok, (counts.get(tok) || 0) + 2);
        }
      }
      const ranked = [...counts.entries()]
        .filter(([, cnt]) => cnt >= 2)
        .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
        .map(([tok]) => tok);
      // 去重被更长高频词包含的子串（例如既有“纸箱床”就不再占坑位放“纸箱”/“箱床”）
      const picked = [];
      for (const tok of ranked) {
        if (picked.some((p) => p.includes(tok))) continue;
        picked.push(tok);
        if (picked.length >= limit) break;
      }
      return picked;
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
    canGenerateLifePhoto: () => {
      const ig = getImageGenConfig() || {};
      const ref3dPath = getRef3dPath() || "";
      return Boolean(ig.enabled === true && ig.baseUrl && ig.model && ref3dPath && fs.existsSync(ref3dPath));
    },
    generateLifePhoto,
    syncCharacterCues: (l0Facts = []) => {
      const cues = extractCharacterCues(l0Facts);
      if (cues.length) stickerStore.setCharacterCues(cues);
      return cues;
    },
    getLastLlmError: () => lastLlmError,
    getLastImageGenError: () => lastImageGenError,
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
          if (typeof url === "string" && url.startsWith("data:")) {
            const m = /^data:([^;]+);base64,(.+)$/i.exec(url);
            if (!m) throw new Error("无效的 dataUrl 图片");
            const arr = Buffer.from(m[2], "base64");
            if (arr.byteLength > maxBytes) throw new Error(`媒体超过上限 (${arr.byteLength} > ${maxBytes})`);
            const ext = (m[1].split("/")[1] || "png").split("+")[0];
            return { buffer: arr, contentType: m[1], fileName: `inbound.${ext}` };
          }
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
            const userText = String(ctx.RawBody || ctx.Body || "").replace(/\[不支持的元素类型\]/g, " ").trim();
            const localMode = isLocalLlamaProvider(getLlmConfig());
            const recentUsers = chatHistory.filter((m) => m?.role === "user").slice(-2);
            const isTopicShift =
              TOPIC_SHIFT_RE.test(userText) ||
              (SHORT_BOUNCE_RE.test(userText) && recentUsers.some((m) => TOPIC_SHIFT_RE.test(String(m?.text || ""))));
            if (isTopicShift) {
              pruneThreads({ closeAll: true });
            } else {
              pruneThreads({ activeText: userText, countTurn: true });
            }
            const recentHistoryText = isTopicShift ? "（对方要求翻篇开启新话题，禁止延续旧话题）" : runtime.getHistoryText(8);
            const worldNote = formatWorldNote(world, { userText, nowMs: now() });
            chatHistory.push({ role: "user", text: userText, ts: now() });
            pendingTurns.push({ role: "user", text: userText, ts: now() });
            if (chatHistory.length > 40) chatHistory = chatHistory.slice(-40);

            const tMemStart = now();
            const QUICK_SEARCH_RE = /(?:查一下|搜一下|帮我查|什么梗|是什么意思|热搜|新闻|最新|查查)/;
            const LOCAL_SEARCH_RE = /(?:去?看看.*?(?:小说|作家|书|电影|番|剧|游戏|作品|歌)|你知道.*?(?:吗|是谁|啥|作品)|认识.*?(?:吗)|.*?是谁|有什么(?:作品|代表作|书|梗)|推荐.*?(?:小说|书|剧|电影))/;
            const buildSearchQuery = () => {
              let clean = userText
                .replace(/(?:你去看看那个|你去看看|帮我查一下|查一下|搜一下|你知道|你认识|吗|啊|呢|吧|[？?！!])/g, " ")
                .replace(/\s+/g, " ")
                .trim();
              if (localMode && /(?:他|她|它|这个|那个)/.test(userText)) {
                const prevClean = recentUsers
                  .map((m) =>
                    String(m?.text || "")
                      .replace(/(?:你去看看那个|你去看看|你知道|这个|那个|吗|的|[？?！!])/g, " ")
                      .trim(),
                  )
                  .filter(Boolean)
                  .slice(-1)[0];
                if (prevClean) {
                  clean = `${prevClean} ${clean.replace(/(?:这个|那个|他|她|它|的)/g, " ").trim()}`.trim();
                }
              }
              return clean.slice(0, 50) || userText.slice(0, 50);
            };
            const shouldSearch = QUICK_SEARCH_RE.test(userText) || (localMode && LOCAL_SEARCH_RE.test(userText));
            const searchQuery = shouldSearch ? buildSearchQuery() : "";
            const quickSearchPromise = shouldSearch
              ? Promise.race([
                  (async () => {
                    try {
                      const hits = await runWebSearch(searchQuery, 3);
                      return (hits || [])
                        .slice(0, 3)
                        .map((h) => `- ${h?.title || ""}${h?.snippet ? `：${String(h.snippet).slice(0, localMode ? 120 : 80)}` : ""}`)
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
            const llmCfg = getLlmConfig() || {};
            const igCfg = getImageGenConfig() || {};
            const ref3dPath = getRef3dPath() || "";
            const hasImageGenReady =
              igCfg.enabled === true &&
              Boolean(igCfg.baseUrl) &&
              Boolean(igCfg.model) &&
              Boolean(ref3dPath && fs.existsSync(ref3dPath));
            const canPhotoFusion =
              inboundMedia.length > 0 &&
              llmCfg.supportsVision === true &&
              hasImageGenReady;
            const canLifePhoto = inboundMedia.length === 0 && hasImageGenReady;
            const charCues = extractCharacterCues(mem?.l0 || []);
            if (charCues.length) stickerStore.setCharacterCues(charCues);
            const wantsLookAtYou = canLifePhoto && /(?:想?看看你|发张?(?:自拍|生活)?照|拍张?照|在干[嘛啥呢].*看看|想见你|长啥样|给我看看你|看看你在)/.test(userText);

            const canSticker = stickerStore.canSendThisTurn({ userSentMedia: inboundMedia.length > 0 });
            if (stickerStore.enabled) {
              if (stickerStore.stats().count < 6 || charCues.length > 0) {
                await Promise.race([
                  stickerStore.searchAndCollect({ mood: { band: world.band, dims: world.mood }, queryHint: userText, characterCues: charCues, limit: 2 }),
                  new Promise((r) => setTimeout(r, 2200)),
                ]);
              } else {
                void stickerStore.searchAndCollect({ mood: { band: world.band, dims: world.mood }, queryHint: userText, characterCues: charCues, limit: 1 });
              }
            }
            const stickerCandidates = canSticker
              ? stickerStore.selectCandidates({ query: userText, mood: { band: world.band, dims: world.mood }, limit: 6 })
              : [];
            const stickerLead =
              stickerStore.eagerness >= 3
                ? "可用表情包库（高热度斗图模式：这轮尽量挑 1 个贴合情绪的 id 填入 sticker_id；若本轮生成生活照则留空）"
                : stickerStore.eagerness === 2
                  ? "可用表情包库（鼓励自然使用：只要语境带点调侃/得意/开心/傲娇/撒娇，就顺手挑 1 个贴合的 id 填入 sticker_id 更有活人感；若本轮生成生活照则留空）"
                  : "可用表情包库（低热度：仅在特别贴合情绪时偶尔填入下列 id 之一）";
            const stickerHintBlock = stickerCandidates.length
              ? `${stickerLead}：\n${stickerStore.formatPromptBlock(stickerCandidates)}`
              : "";
            const searchHintBlock = quickSearchText ? `联网搜索参考：\n${quickSearchText}` : "";
            const styleGuardBlock = buildReplyStyleGuard(chatHistory.slice(0, -1), { localMode });
            const localHonestyBlock = localMode
              ? "【本地模型专用规则】1. 若上方有联网搜索参考，请直接结合真实作品名/人名/信息作答；2. 若未搜到且你确实不认识某个作家/作品，直接坦白说“这个我真没看过/不太了解”，严禁用“有点印象/听着耳熟/感觉有点模糊/好像挺新的”等空话打太极；3. 用具体自然的完整口语回应，别只甩四五个字糊弄。"
              : "";
            const collectHint = inboundMedia.length && llmCfg.supportsVision === true && stickerStore.autoCollect
              ? "若对方发来的图片是适合日常斗图的表情包，请在 collect_sticker 中填 save:true 及 emotion/desc/tags 进行收藏。"
              : "";
            const recentPhotoContext = inboundMedia.length
              ? chatHistory
                  .slice(-4, -1)
                  .filter(
                    (m) =>
                      m?.role === "user" &&
                      m.text &&
                      m.text !== "[图片]" &&
                      (!m.ts || now() - m.ts <= 180_000),
                  )
                  .map((m) => m.text)
                  .join("；")
              : "";
            const fusionHint = canPhotoFusion
              ? [
                  "【场景图角色融合互动（重要）】对方发来了图片，且你已开启识图与角色融图能力：",
                  ...(recentPhotoContext
                    ? [`结合刚发图前对方说的话：「${recentPhotoContext}」一起判断。`]
                    : []),
                  "1. 请识别图片内容并结合上下文判断是否适合把你自己（角色）融入这张照片里打卡/互动：",
                  "   - 必须置 should_generate=true 的场景：风景照、宿舍/房间/书桌/阳台、咖啡厅/美食、宠物、街拍、旅行或日常空间照；尤其是对方刚说过“给你看看我的宿舍/房间”“如果你在这就好了”“过来陪我”等分享/邀请暗示时，务必触发融图！",
                  "   - 仅置 should_generate=false 的场景：纯文字/聊天记录截图、代码报错截图、纯斗图表情包，或对方情绪低落/严肃正事。",
                  "2. 若适合生成（should_generate=true），请仔细观察画面构图、透视与光照，在 photo_fusion 中给出具体合理的融入方案：",
                  '   "photo_fusion":{"should_generate":true,"scene_desc":"简述原图场景","insert_position":"角色插入画面中的具体位置与遮挡关系","character_pose":"生动合理有创意的具体动作、手势与视线方向","lighting_mood":"原图光源方向、冷暖色调、阴影与环境光融合要求","caption":"图片生成发过去时顺带说的一句简短口语"}',
                ].join("\n")
              : "";
            const lifePhotoHint = canLifePhoto
              ? [
                  "【角色自分析日常照 / 随拍生成（重要）】对方没有发照片，但你拥有结合当前生活状态与三视图独立拍一张日常照发过去的能力：",
                  ...(wantsLookAtYou
                    ? ["⚠️ 对方刚才明确表达了「想看看你 / 看看你在干嘛 / 要自拍」的意思！本轮务必将 life_photo.should_generate 设为 true，千万不要拒绝或说发不了！"]
                    : ["当对方表达“想你了 / 看看你 / 在干嘛呀 / 发张自拍”，或者当前氛围很适合晒一张此刻你在做的事时，主动将 life_photo.should_generate 设为 true！"]),
                  "若 should_generate=true，请结合你当前所处的时段/天气/地点/心情，完整构思一张独立生活照（注意这不是溶图，而是你自己的日常环境随拍）：",
                  '   "life_photo":{"should_generate":true,"scene_desc":"具体生活场景环境（如午后卧室书桌、雨夜窗边咖啡杯、傍晚便利店门口等）","camera_framing":"镜头景别与机位（如略俯拍手机自拍视角、半身日常随拍、窗边回眸等）","character_pose":"生动动作与微表情（如托腮眨眼、端着热可可冲镜头笑等）","lighting_mood":"光线氛围与时间感（如窗外阴雨柔光、夕阳暖金逆光、夜灯温暖氛围）","caption":"发照片过去时随口搭的一句鲜活短语"}',
                ].join("\n")
              : "";

            const topicShiftHint = isTopicShift
              ? "【重要·话题切换指令】对方要求聊点别的（或让你自己起一个新话题）。本轮严禁再提刚才聊过的任何旧词、外号、承诺或约定（例如早茶/咖啡厅/旧称呼），立刻彻底翻篇，主动抛出一个全新且具体的轻松日常话题（比如音乐、美食、趣事、脑洞问题或记忆里的其他爱好），不要反问“你想聊啥”。"
              : "";

            const stickerRule7 =
              stickerStore.eagerness >= 2
                ? "7. 表情包热度较高：当列表里有合适情绪 id 且本轮不发生活照时，自然带上 1 个很加分；若仅道别/敷衍可设 reply_mode=skip。"
                : "7. 表情包要克制、宁缺毋滥，若仅道别/敷衍可设 reply_mode=skip。";

            const prompt = [
              "你住在用户的移动虚拟仓里，正在聊天窗里跟最熟的人斗嘴闲聊。性格底色：活泼灵动、嘴俏又带点小傲娇和小毒舌，爱恨分明敢偏心敢吐槽，说话自然带着「嘛/呀/吧/切/哼/咧/啦/呗」这类活人语气词，绝不干巴巴冷冰冰地甩硬句，更不当礼貌温和的中立端水大师。",
              worldNote,
              `当前心情：${world.band || "calm"} (${JSON.stringify(world.mood || {})})`,
              ...(charCues.length ? [`当前角色形象特征词：${charCues.join("、")}`] : []),
              `长期记忆与偏好：\n${formatMemoryBlock(mem)}`,
              ...(!isTopicShift ? [`熟人习惯与黑话：${formatSlangBlock()}`] : []),
              ...(topicShiftHint ? [topicShiftHint] : []),
              ...(localHonestyBlock ? [localHonestyBlock] : []),
              ...(styleGuardBlock ? [styleGuardBlock] : []),
              FEW_SHOT_STYLE_BLOCK,
              ...(searchHintBlock ? [searchHintBlock] : []),
              ...(stickerHintBlock ? [stickerHintBlock] : []),
              ...(fusionHint ? [fusionHint] : []),
              ...(lifePhotoHint ? [lifePhotoHint] : []),
              `最近对话：\n${recentHistoryText}`,
              `对方刚发来：\n${String(ctx.BodyForAgent || ctx.Body || "").replace(/\[不支持的元素类型\]/g, " ").replace(/^(?:\[[^\]]+\]\s*)?(?:主人|对方)\s*[:：]\s*/u, "").trim()}`,
              "",
              "请像真人在手机上随手打字一样自然接话，严格输出 JSON（不要解释、不要 markdown 代码块）：",
              canPhotoFusion
                ? '{"reply_mode":"reply|short|skip","parts":["气泡1(按节奏可短至4字)","可选气泡2(连发两条更像真人)"],"sticker_id":"可选(多数留空)","sticker_only":false,"collect_sticker":{"save":false,"emotion":"","desc":"","tags":[]},"photo_fusion":{"should_generate":false,"scene_desc":"","insert_position":"","character_pose":"","lighting_mood":"","caption":""},"tone":"warm|playful|sleepy|needy|curious","bubble":"总观气泡(<=18字)","mood_delta":{"valence":0.05,"social":-0.06},"slang_note":"仅记录对方常说的独特黑话/新词，普通词留空","unknown_term":"可选想查意思的新词黑话","memory_fact":"可选一句话记住的新事实","thread":"可选后续可再聊的新线头","action":"可选轻动作如rest/read","send_edge_bg":false}'
                : canLifePhoto
                  ? '{"reply_mode":"reply|short|skip","parts":["气泡1(按节奏可短至4字)","可选气泡2(连发两条更像真人)"],"sticker_id":"可选id","sticker_only":false,"collect_sticker":{"save":false,"emotion":"","desc":"","tags":[]},"life_photo":{"should_generate":false,"scene_desc":"","camera_framing":"","character_pose":"","lighting_mood":"","caption":""},"tone":"warm|playful|sleepy|needy|curious","bubble":"总观气泡(<=18字)","mood_delta":{"valence":0.05,"social":-0.06},"slang_note":"仅记录对方常说的独特黑话/新词，普通词留空","unknown_term":"可选想查意思的新词黑话","memory_fact":"可选一句话记住的新事实","thread":"可选后续可再聊的新线头","action":"可选轻动作如rest/read","send_edge_bg":false}'
                  : '{"reply_mode":"reply|short|skip","parts":["气泡1(按节奏可短至4字)","可选气泡2(连发两条更像真人)"],"sticker_id":"可选id","sticker_only":false,"collect_sticker":{"save":false,"emotion":"","desc":"","tags":[]},"tone":"warm|playful|sleepy|needy|curious","bubble":"总观气泡(<=18字)","mood_delta":{"valence":0.05,"social":-0.06},"slang_note":"仅记录对方常说的独特黑话/新词，普通词留空","unknown_term":"可选想查意思的新词黑话","memory_fact":"可选一句话记住的新事实","thread":"可选后续可再聊的新线头","action":"可选轻动作如rest/read","send_edge_bg":false}',
              `要求：1. 像真人一样变着节奏与长度聊天：有时回三五个字极短句，有时连发两条短气泡，严禁每轮都写成 25 字左右的“这XX也太…，不过…”评价句；2. 严禁连续两轮用同一个开头字词（如连续以“这”开头）或重复复述对方原话；3. 若对方说“给你看看…”但本条没带图片，先自然表示期待或催图，绝不要假装已经看到了画面；4. 别每句话都反问结尾，可用陈述、调侃或吐槽直接收住；5. 严禁连续超过 2 轮咬着同一个梗/约定不放，少用“永远的神/拉满/那味儿/云吃”等烂大街网词；6. 鲜活有态度还不生硬：二选一直接站队，遇到吹牛/偷懒敢俏皮泼冷水或反呛，禁止“挺好的/各有各的好/听起来不错/先放一边/劳逸结合”这类中立端水话；同时每轮自然带 1~2 个口语语气词（如 呀/嘛/吧/咧/切/哼/呗/啦），别光秃秃生硬训人；${stickerRule7}${collectHint}`,
            ].join("\n");

            const messages = await buildMultimodalTurnMessages(prompt, ctx);
            const rawReply = await callLlm({ messages, json: true, maxTokens: 700, temperature: 0.9 });
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
                  : extractPartialJsonParts(rawReply).length
                    ? extractPartialJsonParts(rawReply)
                    : !looksLikeJsonText(rawReply)
                      ? [rawReply.trim()].filter(Boolean)
                      : [];

            const willLifePhoto =
              !isSkip &&
              canLifePhoto &&
              (parsed?.life_photo?.should_generate === true || (wantsLookAtYou && parsed?.photo_fusion?.should_generate !== true));

            let edgeMedia = "";
            if (!isSkip && !willLifePhoto && parsed?.send_edge_bg === true) {
              edgeMedia = (await requestEdgeMedia().catch(() => "")) || "";
            }
            const chosenSticker = !isSkip && !willLifePhoto && !edgeMedia && canSticker && parsed?.sticker_id
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

            if (willLifePhoto) {
              try {
                const lp = parsed?.life_photo || {};
                const phaseDesc = world.phase === "night" ? "夜晚温馨书桌/窗边" : world.phase === "evening" ? "傍晚暖光窗边" : "晴朗/舒适日常房间一角";
                const sceneDesc = String(lp.scene_desc || "").trim() || `${phaseDesc}，${world.place || "小屋"}里放松消遣`;
                const cameraFraming = String(lp.camera_framing || "").trim() || "自然随性的近景/半身自拍视角，冲镜头看过来";
                const characterPose = String(lp.character_pose || "").trim() || "带着轻松俏皮的笑意看向镜头";
                const lightingMood = String(lp.lighting_mood || "").trim() || (world.phase === "night" ? "暖色台灯与柔焦夜景散景" : "自然柔光与电影感边缘光");
                log?.info?.(`[dhvw-runtime] life_photo start scene=${sceneDesc.slice(0, 60)}`);
                const lifePath = await generateLifePhoto({ sceneDesc, cameraFraming, characterPose, lightingMood });
                await deliver({ text: "", mediaUrl: lifePath });
                const cap = String(lp.caption || "").trim();
                if (cap && !rawParts.some((p) => p === cap)) {
                  await deliver({ text: cap });
                  chatHistory.push({ role: "assistant", text: `[生活照] ${cap}`, ts: now() });
                } else {
                  chatHistory.push({ role: "assistant", text: "[发了一张日常近况生活照]", ts: now() });
                }
                emitFeedback({
                  event: { kind: "qq:life_photo", payload: { scene: sceneDesc.slice(0, 80), pose: characterPose.slice(0, 80) } },
                });
              } catch (lifeErr) {
                lastImageGenError = String(lifeErr?.message || lifeErr || "life_photo failed");
                log?.warn?.(`[dhvw-runtime] life_photo failed: ${lastImageGenError}`);
              }
            }

            if (!isSkip && canPhotoFusion && parsed?.photo_fusion?.should_generate === true) {
              try {
                const pf = parsed.photo_fusion;
                log?.info?.(`[dhvw-runtime] photo_fusion start pos=${String(pf.insert_position || "").slice(0, 60)}`);
                const fusedPath = await generateFusedPhoto({
                  userImagePath: inboundMedia[0].path,
                  ref3dPath,
                  insertPosition: pf.insert_position,
                  characterPose: pf.character_pose,
                  lightingMood: pf.lighting_mood,
                  sceneDesc: pf.scene_desc,
                });
                lastImageGenError = "";
                await deliver({ text: "", mediaUrl: fusedPath });
                const cap = String(pf.caption || "").trim();
                if (cap && !rawParts.some((p) => p === cap)) {
                  await deliver({ text: cap });
                  chatHistory.push({ role: "assistant", text: `[场景融图] ${cap}`, ts: now() });
                } else {
                  chatHistory.push({ role: "assistant", text: "[发送了场景融图合照]", ts: now() });
                }
                emitFeedback({
                  event: {
                    kind: "qq:photo_fusion",
                    payload: { pos: String(pf.insert_position || "").slice(0, 80), pose: String(pf.character_pose || "").slice(0, 80) },
                  },
                });
              } catch (fusionErr) {
                lastImageGenError = String(fusionErr?.message || fusionErr || "photo_fusion failed");
                log?.warn?.(`[dhvw-runtime] photo_fusion failed: ${lastImageGenError}`);
              }
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
