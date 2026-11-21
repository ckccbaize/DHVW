/**
 * 心情指数 + 世界事件驱动的主动发起引擎，复用 openclaw-snowluma 的 outbound.js 发送管道。
 * 优先复用 60 分钟被动回复窗口；超窗走合规主动额度，若平台拒绝则自动降级为仅总观气泡。
 */
import fs from "node:fs";
import path from "node:path";
import { markdownToText } from "./markdown-text.js";
import { sendMedia, sendText } from "./outbound.js";

const QUIET_START_MIN = 23 * 60;
const QUIET_DEEP_START_MIN = 2 * 60;
const QUIET_END_MIN = 7 * 60 + 30;
const LATE_ACTIVE_GRACE_MS = 90 * 60_000;
const WEATHER_CUE = new Set(["rain", "snow", "storm"]);
const EVENT_CUE = new Set(["writing", "travel", "travel:arrive", "return", "browse", "bg_ready"]);

function isQuietHour(ts, lastInboundAt = 0) {
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  // 02:00 ~ 07:30 强制夜间静默；23:00 ~ 02:00 若过去 90 分钟刚有过活跃夜聊，允许继续自然陪伴，否则入睡静默
  if (m >= QUIET_DEEP_START_MIN && m < QUIET_END_MIN) return true;
  if (m >= QUIET_START_MIN || m < QUIET_DEEP_START_MIN) {
    if (lastInboundAt > 0 && ts - lastInboundAt <= LATE_ACTIVE_GRACE_MS) return false;
    return true;
  }
  return false;
}

export function dynamicCooldownMs({ mood = {}, band = "calm", baseCooldownMin = 40 } = {}) {
  const social = Number(mood.social ?? 0.4);
  const valence = Number(mood.valence ?? 0.55);
  const baseMs = Math.max(5, Number(baseCooldownMin) || 40) * 60_000;
  if (band === "tired") return Math.round(baseMs * 1.85);
  if (social >= 0.65 || valence <= 0.33 || band === "excited") return Math.round(baseMs * 0.625);
  return baseMs;
}

const THREAD_MAX_AGE_MS = 2 * 3600_000;
const MOOD_TRIGGER_COOLDOWN_MS = 3 * 3600_000;
const EVENT_KIND_COOLDOWN_MS = 2 * 3600_000;

export function evaluateProactiveTrigger({
  now = Date.now(),
  phase = "morning",
  weather = "clear",
  mood = {},
  band = "calm",
  lastInboundAt = 0,
  lastProactiveAt = 0,
  lastMoodTriggerAt = 0,
  lastTriggerKind = "",
  recentEventKinds = {},
  todayCount = 0,
  dailyCap = 6,
  cooldownMin = 40,
  idleCheckinMin = 35,
  recentEvents = [],
  threads = [],
  lastWeatherShared = "",
  sharedEventIds = [],
  allowThreadResurface = true,
  force = false,
} = {}) {
  if (!force) {
    if (phase === "sleep" || isQuietHour(now, lastInboundAt)) return { shouldTrigger: false, reason: "quiet_hours" };
    if (todayCount >= dailyCap) return { shouldTrigger: false, reason: "daily_cap" };
    if (lastInboundAt > 0 && now - lastInboundAt < 5 * 60_000) return { shouldTrigger: false, reason: "recent_inbound" };
    if (lastProactiveAt > 0 && now - lastProactiveAt < dynamicCooldownMs({ mood, band, baseCooldownMin: cooldownMin })) {
      return { shouldTrigger: false, reason: "cooldown" };
    }
  }

  const shared = new Set(sharedEventIds || []);
  for (let i = recentEvents.length - 1; i >= 0; i--) {
    const ev = recentEvents[i];
    if (!ev?.id || shared.has(ev.id) || !EVENT_CUE.has(ev.kind)) continue;
    if (ev.ts && now - ev.ts > 45 * 60_000) continue;
    const prevKindAt = Number(recentEventKinds?.[ev.kind] || 0);
    if (prevKindAt > 0 && now - prevKindAt < EVENT_KIND_COOLDOWN_MS) continue;
    return { shouldTrigger: true, kind: "world_event", eventId: ev.id, eventKind: ev.kind, reason: `生活事件 ${ev.kind}`, seed: ev.summary || ev.kind };
  }

  if (WEATHER_CUE.has(weather) && lastWeatherShared !== weather) {
    return { shouldTrigger: true, kind: "weather_shift", weather, reason: `天气变化 ${weather}`, seed: `外面现在是${weather}` };
  }

  const moodReady = !(lastMoodTriggerAt > 0 && now - lastMoodTriggerAt < MOOD_TRIGGER_COOLDOWN_MS);
  const social = Number(mood.social ?? 0.4);
  const valence = Number(mood.valence ?? 0.55);
  const energy = Number(mood.energy ?? 0.55);
  if (moodReady && social >= 0.65 && lastTriggerKind !== "mood_lonely") {
    return { shouldTrigger: true, kind: "mood_lonely", reason: `社交欲高 (${social.toFixed(2)})`, seed: "好久没聊天，有点想对方了" };
  }
  if (moodReady && (valence <= 0.33 || band === "low") && lastTriggerKind !== "mood_low") {
    return { shouldTrigger: true, kind: "mood_low", reason: `心情低落 (${valence.toFixed(2)})`, seed: "情绪有点低，想听对方说说话" };
  }
  if (moodReady && (band === "excited" || (valence >= 0.72 && energy >= 0.68)) && lastTriggerKind !== "mood_excited") {
    return { shouldTrigger: true, kind: "mood_excited", reason: `好心情分享 (${valence.toFixed(2)})`, seed: "心情特别好，想跟对方分享" };
  }

  if (allowThreadResurface !== false) {
    const due = (threads || []).find((t) => {
      if (!t || t.closed) return false;
      if (t.expiresAt && t.expiresAt <= now) return false;
      if (t.createdAt && now - t.createdAt > THREAD_MAX_AGE_MS) return false;
      return !t.resurfaceAt || t.resurfaceAt <= now;
    });
    if (due) {
      return { shouldTrigger: true, kind: "thread_resurface", threadId: due.id, reason: "两小时内未尽线头短距重浮", seed: due.text };
    }
  }

  const idleThresholdMs = Math.max(5, Number(idleCheckinMin) || 35) * 60_000;
  if (force || lastInboundAt === 0 || now - lastInboundAt >= idleThresholdMs) {
    return {
      shouldTrigger: true,
      kind: "idle_checkin",
      reason: force ? "手动触发一次自唤醒" : "多角度新鲜冒泡找对方聊聊",
      seed: "换个全新角度开一个有意思的新话题",
    };
  }
  return { shouldTrigger: false, reason: "no_trigger" };
}

const WEB_TIDBIT_QUERIES = [
  "有意思的冷知识 反常识",
  "奇怪的食物冷知识",
  "生活中的奇葩误区 科普",
  "奇妙宇宙天文冷知识",
  "冷门心理效应 日常",
  "人类迷惑行为 趣闻",
  "今日沙雕奇闻 趣事",
  "冷门历史奇闻 八卦",
];

function describeClockSlice(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  const hhmm = `${String(h).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (h >= 7 && h < 10) return `${hhmm}（早起犯困/开启一天）`;
  if (h >= 10 && h < 14) return `${hhmm}（临近或刚过午饭点）`;
  if (h >= 14 && h < 18) return `${hhmm}（下午犯困摸鱼高峰）`;
  if (h >= 18 && h < 22) return `${hhmm}（晚上放松或纠结夜宵）`;
  return `${hhmm}（深夜夜猫子时间）`;
}

const PROACTIVE_ANGLES = [
  {
    id: "routine_slice",
    label: "现实作息切片",
    buildInstruction: (ts) =>
      `切入角度【当下作息切片】（此刻现实约 ${describeClockSlice(ts)}）：抓一个这个钟点真实会发生的小状态吐槽或犯懒（早起、犯困、纠结喝啥吃啥、该收心还是继续摸鱼），不要干巴巴问候“在干嘛”。`,
  },
  {
    id: "hot_debate",
    label: "偏心站队二选一",
    buildInstruction: () =>
      "切入角度【脑洞二选一偏心站队】：抛一个全新生活/品味小对决或荒诞二选一（与近期聊过的内容无关），先亮明你自己毫不掩饰的偏心立场并吐槽另一派，逼对方赶紧选边站。",
  },
  {
    id: "web_tidbit",
    label: "冷知识奇趣分享",
    needsSearch: true,
    buildInstruction: (_ts, tidbitText) =>
      tidbitText
        ? `切入角度【刚搜到的奇趣冷知识/趣闻】：“${tidbitText}”——像刚刷到好东西急着跟熟人炫耀/吐槽一样，挑最反常识的一点抖包袱甩给对方（禁写科普长文）。`
        : "切入角度【突袭冷吐槽】：丢一个反常识生活小冷知识或小困惑，带点“我刚反应过来这也太离谱”的语气。",
  },
  {
    id: "self_theater",
    label: "角色日常小剧场",
    buildInstruction: () =>
      "切入角度【此刻自己身上发生的小状况】：演一嘴自己刚刚干的一件小乌龙、突发奇想的折腾，或者跟自己外形/脾气有关的小傲娇吐槽（可顺手配生活照，禁止翻旧道具）。",
  },
  {
    id: "playful_tease",
    label: "熟人突袭盲猜",
    buildInstruction: () =>
      "切入角度【突袭盲猜/轻度挑衅】：不寒暄也不找旧事，直接拿捏对方此刻状态打个赌或拆台（例如猜他手机电量快红了、正在憋笑摸鱼、坐姿肯定又歪了），语气灵动带勾子。",
  },
  {
    id: "taste_roast",
    label: "文娱美食新坑",
    buildInstruction: () =>
      "切入角度【随机品味安利或嫌弃】：在歌曲/影视梗/奇葩零食饮料/童年回忆中随选一个近期没聊过的新方向，直接辣评嫌弃或安利，绝不提之前聊烂的书或吃食。",
  },
  {
    id: "brainhole_whatif",
    label: "奇葩脑洞假设",
    buildInstruction: () =>
      "切入角度【突如其来的奇怪脑洞】：丢一个完全跳脱的假设题（比如如果重力突然减半一小时、如果房间里的东西能打分吐槽），用自己鲜活的语气先把离谱前提抛出来。",
  },
];

export function createProactiveRunner({
  getClient,
  getAccount,
  getTargets = null,
  runtime,
  getWorldState = () => ({}),
  queryMemory = async () => ({ semantic: false, l0: [], hits: [] }),
  requestEdgeMedia = async () => "",
  emitFeedback = () => {},
  now = () => Date.now(),
  rng = () => Math.random(),
  log,
} = {}) {
  const stateFile = runtime?.stateDir ? path.join(runtime.stateDir, "proactive-state.json") : "";
  const persisted = (() => {
    try {
      if (stateFile && fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {}
    return {};
  })();

  let lastProactiveAt = Number(persisted.lastProactiveAt) || 0;
  let lastProactivePhotoAt = Number(persisted.lastProactivePhotoAt) || 0;
  let lastMoodTriggerAt = Number(persisted.lastMoodTriggerAt) || 0;
  let lastSearchAngleAt = Number(persisted.lastSearchAngleAt) || 0;
  let lastInboundAt = Number(persisted.lastInboundAt) || 0;
  let lastFailedAttemptAt = Number(persisted.lastFailedAttemptAt) || 0;
  let dayKey = String(persisted.dayKey || "");
  let todayCount = Number(persisted.todayCount) || 0;
  let lastWeatherShared = String(persisted.lastWeatherShared || "");
  let lastSendError = String(persisted.lastSendError || "");
  let lastSendErrorAt = Number(persisted.lastSendErrorAt) || 0;
  let wakeupBlockedDayKey = String(persisted.wakeupBlockedDayKey || "");
  const sharedEventIds = Array.isArray(persisted.sharedEventIds) ? persisted.sharedEventIds.slice(-30) : [];
  const recentEventKinds = persisted.recentEventKinds && typeof persisted.recentEventKinds === "object" ? { ...persisted.recentEventKinds } : {};
  let recentAngles = Array.isArray(persisted.recentAngles) ? persisted.recentAngles.slice(-6) : [];
  let recentSearchQueries = Array.isArray(persisted.recentSearchQueries) ? persisted.recentSearchQueries.slice(-8) : [];
  const recentEvents = [];
  let busy = false;
  let lastDecision = persisted.lastDecision || null;
  let lastLoggedReason = "";

  function saveState() {
    if (!stateFile) return;
    try {
      fs.writeFileSync(
        stateFile,
        JSON.stringify(
          {
            lastProactiveAt,
            lastProactivePhotoAt,
            lastMoodTriggerAt,
            lastSearchAngleAt,
            lastInboundAt,
            lastFailedAttemptAt,
            dayKey,
            todayCount,
            lastWeatherShared,
            lastSendError,
            lastSendErrorAt,
            wakeupBlockedDayKey,
            sharedEventIds: sharedEventIds.slice(-30),
            recentEventKinds,
            recentAngles: recentAngles.slice(-6),
            recentSearchQueries: recentSearchQueries.slice(-8),
            lastDecision,
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch {}
  }

  function pickNextAngle(ts, { canSearch = false } = {}) {
    const recentBlock = new Set(recentAngles.slice(-4));
    const searchCooldownOk = canSearch && !recentAngles.slice(-2).includes("web_tidbit") && ts - lastSearchAngleAt >= 90 * 60_000;
    const eligible = PROACTIVE_ANGLES.filter((a) => {
      if (a.needsSearch && !searchCooldownOk) return false;
      return !recentBlock.has(a.id);
    });
    const pool = eligible.length ? eligible : PROACTIVE_ANGLES.filter((a) => (!a.needsSearch || searchCooldownOk) && a.id !== recentAngles[recentAngles.length - 1]);
    const finalPool = pool.length ? pool : PROACTIVE_ANGLES.filter((a) => !a.needsSearch);
    const idx = Math.floor(rng() * finalPool.length) % finalPool.length;
    return finalPool[idx];
  }

  async function pickFreshWebTidbit(forbiddenTopics = []) {
    if (typeof runtime.searchWeb !== "function") return { query: "", snippet: "" };
    const recentQSet = new Set(recentSearchQueries.slice(-6));
    const forbidSet = new Set(forbiddenTopics);
    const candidates = WEB_TIDBIT_QUERIES.filter((q) => {
      if (recentQSet.has(q)) return false;
      for (const bad of forbidSet) {
        if (bad && q.includes(bad)) return false;
      }
      return true;
    });
    const pool = candidates.length ? candidates : WEB_TIDBIT_QUERIES;
    const query = pool[Math.floor(rng() * pool.length) % pool.length];
    try {
      const hits = await Promise.race([runtime.searchWeb(query, 3), new Promise((r) => setTimeout(() => r([]), 2200))]);
      const useful = (Array.isArray(hits) ? hits : [])
        .map((h) => `${h?.title || ""}：${String(h?.snippet || "").slice(0, 90)}`.replace(/^：|：$/g, "").trim())
        .filter((txt) => txt.length >= 12 && !forbiddenTopics.some((bad) => bad && txt.includes(bad)));
      if (!useful.length) return { query, snippet: "" };
      return { query, snippet: useful[0].slice(0, 140) };
    } catch {
      return { query, snippet: "" };
    }
  }

  function resolveTargets() {
    if (typeof getTargets === "function") {
      return (getTargets() || [])
        .filter((t) => t?.client && t?.account?.ownerOpenId)
        .map((t) => ({
          channel: String(t.channel || t.client?.capabilities?.channelName || "qq"),
          client: t.client,
          account: t.account,
          unlimited: Boolean(t.client?.capabilities?.unlimitedProactive),
        }));
    }
    const client = getClient?.();
    const account = getAccount?.();
    if (!client || !account?.ownerOpenId) return [];
    return [
      {
        channel: String(client?.capabilities?.channelName || "qq"),
        client,
        account,
        unlimited: Boolean(client?.capabilities?.unlimitedProactive),
      },
    ];
  }

  return {
    recordInbound() {
      lastInboundAt = now();
      wakeupBlockedDayKey = "";
      saveState();
    },
    recordWorldEvent(ev) {
      if (!ev?.kind) return;
      recentEvents.push({ id: ev.id || `${ev.kind}-${now().toString(36)}`, kind: ev.kind, summary: ev.summary || "", ts: ev.ts || now() });
      if (recentEvents.length > 20) recentEvents.shift();
    },
    getStatus() {
      const targets = resolveTargets();
      const dkNow = new Date(now()).toISOString().slice(0, 10);
      const feishuTarget = targets.find((t) => t.channel === "feishu" || t.unlimited);
      const qqTarget = targets.find((t) => t.channel === "qq" && !t.unlimited);
      const qqSnap = qqTarget ? qqTarget.client?.ledger?.snapshot?.(qqTarget.account.ownerOpenId) : null;
      const parts = [];
      if (feishuTarget) parts.push("飞书长连接无限主动可用");
      if (qqTarget) {
        parts.push(
          qqSnap?.active
            ? `QQ 60分钟被动窗口可用(剩${qqSnap.remainingSeq}次)`
            : wakeupBlockedDayKey === dkNow
              ? "QQ今日超窗召回已达40034122上限"
              : "QQ超窗互动召回待命(每个区间限1条)",
        );
      }
      const quotaStatus =
        parts.length > 0
          ? parts.join("；")
          : wakeupBlockedDayKey === dkNow
            ? "今日超窗召回已达QQ平台40034122上限，等对方发任意消息即恢复被动免额窗口"
            : "超窗互动召回待命(每个区间限1条)";
      return {
        lastProactiveAt,
        lastInboundAt,
        lastFailedAttemptAt,
        dayKey,
        todayCount,
        lastSendError,
        lastSendErrorAt,
        wakeupBlockedDayKey,
        quotaStatus,
        lastDecision,
      };
    },
    async tick({ force = false } = {}) {
      if (busy) return { ok: false, reason: "busy" };
      const targets = resolveTargets();
      if (!targets.length) return { ok: false, reason: "no_owner_client" };
      const world = getWorldState() || {};
      if (!force && (world.display === "present" || world.present === true)) {
        return { ok: false, reason: "present" };
      }

      const ts = now();
      const dk = new Date(ts).toISOString().slice(0, 10);
      const usableTargets = targets.filter((t) => {
        if (force || t.unlimited) return true;
        const passiveActiveNow = Boolean(t.client.ledger?.snapshot?.(t.account.ownerOpenId)?.active);
        return passiveActiveNow || wakeupBlockedDayKey !== dk;
      });
      if (!usableTargets.length) {
        return { ok: false, reason: "wakeup_quota_exhausted" };
      }
      if (!force && lastFailedAttemptAt > 0 && ts - lastFailedAttemptAt < 5 * 60_000) {
        return { ok: false, reason: "failed_backoff" };
      }
      if (dayKey !== dk) {
        dayKey = dk;
        todayCount = 0;
        lastWeatherShared = "";
      }

      const primary = usableTargets.find((t) => t.unlimited) || usableTargets[0];
      const hasUnlimited = usableTargets.some((t) => t.unlimited);
      const configuredDaily = Number(primary.account.proactiveDailyMax);
      const dailyCap = hasUnlimited
        ? Math.max(24, Number.isFinite(configuredDaily) && configuredDaily > 0 ? configuredDaily : 24)
        : (Number.isFinite(configuredDaily) && configuredDaily > 0 ? configuredDaily : 6);

      const allowThreadNow = !force && lastDecision?.kind !== "thread_resurface" && rng() < 0.22;
      const decision = evaluateProactiveTrigger({
        now: ts,
        phase: world.phase,
        weather: world.weather,
        mood: world.mood,
        band: world.band,
        lastInboundAt,
        lastProactiveAt,
        lastMoodTriggerAt,
        lastTriggerKind: lastDecision?.kind || "",
        recentEventKinds,
        todayCount,
        dailyCap,
        cooldownMin: primary.account.proactiveCooldownMin ?? 40,
        recentEvents,
        threads: runtime.getThreads(),
        lastWeatherShared,
        sharedEventIds,
        allowThreadResurface: allowThreadNow,
        force,
      });
      if (!decision.shouldTrigger) {
        lastDecision = { ok: false, reason: decision.reason, ts };
        if (decision.reason !== lastLoggedReason) {
          lastLoggedReason = decision.reason;
          log?.info?.(`[dhvw-proactive] 暂不触发: ${decision.reason}`);
        }
        return { ok: false, reason: decision.reason };
      }
      lastLoggedReason = "";

      busy = true;
      try {
        const isFreshAngle = decision.kind !== "thread_resurface";
        const forbiddenTopics =
          isFreshAngle && typeof runtime.getForbiddenProactiveTopics === "function"
            ? runtime.getForbiddenProactiveTopics(8)
            : [];

        let chosenAngle = null;
        let tidbitQuery = "";
        let tidbitText = "";
        if (isFreshAngle) {
          chosenAngle = pickNextAngle(ts, {
            canSearch: decision.kind === "idle_checkin" && typeof runtime.searchWeb === "function",
          });
          if (chosenAngle?.id === "web_tidbit") {
            const res = await pickFreshWebTidbit(forbiddenTopics);
            tidbitQuery = res.query;
            tidbitText = res.snippet;
            if (!tidbitText) {
              chosenAngle = pickNextAngle(ts, { canSearch: false });
            }
          }
        }

        const memQuery = isFreshAngle
          ? `${chosenAngle?.label || ""} ${decision.kind === "idle_checkin" ? "兴趣 日常 喜好" : decision.seed}`.trim()
          : decision.seed;
        const rawMem = await queryMemory(memQuery, 5, { band: world.band, dims: world.mood });
        const mem = isFreshAngle && forbiddenTopics.length && Array.isArray(rawMem?.hits)
          ? {
              ...rawMem,
              hits: rawMem.hits.filter((h) => !forbiddenTopics.some((bad) => bad && String(h?.text || "").includes(bad))),
            }
          : rawMem;
        const charCues = typeof runtime.syncCharacterCues === "function" ? runtime.syncCharacterCues(mem?.l0 || []) : [];
        if (runtime.stickerStore?.enabled && (runtime.stickerStore.stats?.().count < 12 || charCues.length > 0)) {
          await Promise.race([
            runtime.stickerStore.searchAndCollect({
              mood: { band: world.band, dims: world.mood },
              queryHint: chosenAngle?.label || decision.seed,
              characterCues: charCues,
              limit: 2,
            }),
            new Promise((r) => setTimeout(r, 2000)),
          ]);
        }
        const primarySnap = primary.unlimited
          ? { active: true, remainingSeq: 99 }
          : (primary.client.ledger?.snapshot?.(primary.account.ownerOpenId) || { active: false, remainingSeq: 0 });
        const hasPassive = Boolean(primarySnap.active && primarySnap.remainingSeq >= 1);
        const allowMultiBubble = hasUnlimited || (hasPassive && primarySnap.remainingSeq >= 2);
        const styleGuardBlock = typeof runtime.getStyleGuard === "function" ? runtime.getStyleGuard() : "";

        const canProactiveLifePhoto =
          allowMultiBubble &&
          typeof runtime.canGenerateLifePhoto === "function" &&
          runtime.canGenerateLifePhoto() &&
          typeof runtime.generateLifePhoto === "function" &&
          (force || ts - lastProactivePhotoAt >= 2 * 3600_000);

        const stickerCandidates = runtime.stickerStore?.canSendThisTurn({ proactive: true })
          ? runtime.stickerStore.selectCandidates({
              query: chosenAngle?.label || decision.seed,
              mood: { band: world.band, dims: world.mood },
              limit: 6,
            })
          : [];
        const stickerHint = allowMultiBubble && stickerCandidates.length
          ? `${(runtime.stickerStore?.eagerness ?? 1) >= 2 ? "可用表情包库（热度较高，无生活照时可积极挑 1 个贴合情绪的 id）" : "可用表情包库（多数时候留空即可，极偶尔可填 id）"}：\n${runtime.stickerStore.formatPromptBlock(stickerCandidates)}`
          : "";
        const lifePhotoHint = canProactiveLifePhoto
          ? [
              "【主动分享生活照（可用）】若你觉得此时很适合顺手拍一张此刻在做的日常/风景发给对方（尤其适合小剧场/当下作息/出游/心情起伏时），可设置 life_photo.should_generate=true 并详细描述场景：",
              '"life_photo":{"should_generate":true,"scene_desc":"具体生活场景(结合当下时段/地点/动态)","camera_framing":"随拍/自拍景别视角","character_pose":"生动动作与表情","lighting_mood":"光线与氛围"}',
            ].join("\n")
          : "";
        const worldNote = typeof runtime.formatWorldNote === "function"
          ? runtime.formatWorldNote(world, { forceWeather: decision.kind === "weather_shift" })
          : `当前状态：${world.phase || "日常"}，${world.place || "小屋"}`;
        const angleBlock = chosenAngle ? chosenAngle.buildInstruction(ts, tidbitText) : "";
        const forbidBlock =
          isFreshAngle && forbiddenTopics.length
            ? `【强制开启全新话题，严禁翻旧账】本轮绝对禁止提及或联想以下最近聊过的旧词：${forbiddenTopics.join("、")}。完全翻篇，严格从上方切入角度重新起头！`
            : "";
        const historyBlock = isFreshAngle
          ? `最近 2 句仅作熟人语气参考（严禁延续里面的事件、物品或旧话题）：\n${runtime.getHistoryText(2)}`
          : `最近对话：\n${runtime.getHistoryText(6)}`;
        const bubbleRule = canProactiveLifePhoto
          ? 'STRICT JSON：{"speak":true,"parts":["随照片或单独发的话1","可选极短补充第2句"],"sticker_id":"可选id","life_photo":{"should_generate":false,"scene_desc":"","camera_framing":"","character_pose":"","lighting_mood":""},"bubble":"总观气泡(<=18字)","send_edge_bg":false}'
          : allowMultiBubble
            ? 'STRICT JSON：{"speak":true,"parts":["短句1","可选极短补充第2句"],"sticker_id":"可选id","bubble":"总观气泡(<=18字)","send_edge_bg":false}'
            : 'STRICT JSON：{"speak":true,"parts":["仅1句自然的话(10~28字，不要分两句也不要换行)"],"sticker_id":"","bubble":"总观气泡(<=18字)","send_edge_bg":false}';
        const prompt = [
          "你住在虚拟仓里，想起对方了，打算随手在聊天窗里给他发一句话。",
          `触发背景：${decision.kind} - ${decision.reason}${decision.kind === "thread_resurface" ? ` (${decision.seed})` : ""}`,
          ...(angleBlock ? [angleBlock] : []),
          ...(forbidBlock ? [forbidBlock] : []),
          worldNote,
          `当前心情：${world.band || "calm"}`,
          ...(charCues.length ? [`当前角色形象特征词：${charCues.join("、")}`] : []),
          `记忆：\n${runtime.formatMemoryBlock(mem)}`,
          ...(styleGuardBlock ? [styleGuardBlock] : []),
          ...(runtime.fewShotStyleBlock ? [runtime.fewShotStyleBlock] : []),
          ...(stickerHint ? [stickerHint] : []),
          ...(lifePhotoHint ? [lifePhotoHint] : []),
          historyBlock,
          bubbleRule,
          "要求：1. 像真人朋友忽然冒泡，禁止用“对了，之前说…”、“突然想起来，你之前说…”这类翻旧账套话；2. 每次换全新角度与场景切入，绝不重复最近用过的开头、句式或旧物品梗；3. 活泼俏皮有态度，自然带一两个语气词（嘛/呀/吧/咧/哼/切），禁止说教关心与中立模板。",
        ].join("\n\n");

        const raw = await runtime.callLlm({ messages: [{ role: "user", content: prompt }], json: true, maxTokens: 560, temperature: 0.9 });
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          const m = /\{[\s\S]*\}/.exec(raw);
          if (m) parsed = JSON.parse(m[0]);
        }
        if (!parsed || parsed.speak === false) return { ok: false, reason: "model_silent" };
        const parts = (Array.isArray(parsed.parts) ? parsed.parts : []).map((s) => markdownToText(String(s || ""))).filter(Boolean).slice(0, 2);

        let sharedLifeImg = "";
        if (canProactiveLifePhoto && parsed?.life_photo?.should_generate === true) {
          try {
            const lp = parsed.life_photo;
            sharedLifeImg = await runtime.generateLifePhoto({
              sceneDesc: lp.scene_desc || `${world.phase || "日常"} ${world.place || "小屋"} 生活随拍`,
              cameraFraming: lp.camera_framing || "自然半身近景日常抓拍",
              characterPose: lp.character_pose || "轻松自然地朝镜头看过来",
              lightingMood: lp.lighting_mood || "温馨自然光线",
            });
          } catch (lpErr) {
            log?.warn?.(`[dhvw-proactive] 主动生活照生成失败，降级纯文字发送: ${String(lpErr?.message || lpErr)}`);
          }
        }

        const chosenSticker = allowMultiBubble && !sharedLifeImg && parsed.send_edge_bg !== true && parsed.sticker_id
          ? runtime.stickerStore?.resolvePath(parsed.sticker_id)
          : null;
        if (!parts.length && !chosenSticker && !sharedLifeImg) return { ok: false, reason: "empty_parts" };

        let sharedEdgeImg = "";
        if (!sharedLifeImg && parsed.send_edge_bg === true) {
          sharedEdgeImg = await requestEdgeMedia().catch(() => "");
        }

        let sentOk = false;
        let sentTextCount = 0;
        let sentMedia = false;
        let sentSticker = false;
        let sendError = "";
        let lastPartsUsed = parts;

        for (const t of usableTargets) {
          const openId = t.account.ownerOpenId;
          const to = `snowluma:private:${openId}`;
          const snap = t.unlimited
            ? { active: true, remainingSeq: 99 }
            : (t.client.ledger?.snapshot?.(openId) || { active: false, remainingSeq: 0 });
          const targetHasPassive = t.unlimited || Boolean(snap.active && snap.remainingSeq >= 1);
          const sendParts =
            parts.length > 1 && !t.unlimited && (!targetHasPassive || snap.remainingSeq < parts.length)
              ? [parts.join("\n")]
              : parts;
          const canSendAttachment = t.unlimited || (targetHasPassive && snap.remainingSeq >= sendParts.length + 1);
          lastPartsUsed = sendParts;

          let targetSent = false;
          let targetTexts = 0;
          try {
            const delayMs = t.account.partDelayMs ?? 400;
            for (let i = 0; i < sendParts.length; i++) {
              if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
              await sendText({
                client: t.client,
                to,
                text: sendParts[i],
                proactive: true,
                isWakeup: !t.unlimited,
              });
              targetSent = true;
              targetTexts += 1;
            }
            if (sharedLifeImg && (canSendAttachment || !sendParts.length)) {
              if (sendParts.length && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
              await sendMedia({ client: t.client, to, mediaPath: sharedLifeImg, proactive: true, isWakeup: !t.unlimited });
              targetSent = true;
              sentMedia = true;
            } else if (sharedEdgeImg && (canSendAttachment || !sendParts.length)) {
              await sendMedia({ client: t.client, to, mediaPath: sharedEdgeImg, proactive: true, isWakeup: !t.unlimited });
              targetSent = true;
              sentMedia = true;
            } else if (chosenSticker && (canSendAttachment || !sendParts.length)) {
              if (sendParts.length && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
              await sendMedia({ client: t.client, to, mediaPath: chosenSticker.path, proactive: true, isWakeup: !t.unlimited });
              targetSent = true;
              sentMedia = true;
              sentSticker = true;
            }
          } catch (err) {
            const targetErr = String(err?.message || err);
            sendError = sendError ? `${sendError}; ${t.channel}:${targetErr}` : targetErr;
            log?.warn?.(`[dhvw-proactive] ${t.channel} 主动发送受限: ${targetErr}`);
            if (!t.unlimited && /40034122|召回消息已达区间上限/.test(targetErr)) {
              wakeupBlockedDayKey = dk;
            }
          }
          if (targetSent) {
            sentOk = true;
            sentTextCount = Math.max(sentTextCount, targetTexts);
          }
        }

        if (sentSticker && chosenSticker) {
          runtime.stickerStore.markUsed(chosenSticker.id);
        }
        runtime.stickerStore?.recordTurn?.(sentSticker);
        if (sharedLifeImg && sentMedia) {
          lastProactivePhotoAt = ts;
        }

        if (sentOk) {
          lastProactiveAt = ts;
          todayCount += 1;
          lastFailedAttemptAt = 0;
          lastSendError = "";
          if (decision.kind === "weather_shift") lastWeatherShared = decision.weather;
          if (decision.kind.startsWith("mood_")) lastMoodTriggerAt = ts;
          if (decision.eventKind) recentEventKinds[decision.eventKind] = ts;
          if (decision.eventId) sharedEventIds.push(decision.eventId);
          if (decision.threadId) runtime.closeThread(decision.threadId);
          if (chosenAngle?.id) {
            recentAngles.push(chosenAngle.id);
            if (recentAngles.length > 6) recentAngles = recentAngles.slice(-6);
            if (chosenAngle.id === "web_tidbit" && tidbitText) {
              lastSearchAngleAt = ts;
              if (tidbitQuery) {
                recentSearchQueries.push(tidbitQuery);
                if (recentSearchQueries.length > 8) recentSearchQueries = recentSearchQueries.slice(-8);
              }
            }
          }
          const histText = [
            ...lastPartsUsed.slice(0, sentTextCount),
            ...(sharedLifeImg && sentMedia ? ["[主动发送了日常近况生活照]"] : []),
            ...(sentSticker && chosenSticker ? [`[表情包:${chosenSticker.desc}]`] : []),
          ]
            .join(" ")
            .trim();
          if (histText) runtime.appendAssistantTurn(histText);
        } else {
          lastFailedAttemptAt = ts;
          lastSendError = sendError || "send_failed";
          lastSendErrorAt = ts;
        }

        lastDecision = { ok: sentOk, kind: decision.kind, angle: chosenAngle?.id || "", sentOk, passive: hasPassive, sendError, ts };
        saveState();
        log?.info?.(`[dhvw-proactive] 自唤醒结束 kind=${decision.kind} angle=${chosenAngle?.id || "-"} passive=${hasPassive} sentOk=${sentOk} parts=${sentTextCount} lifePhoto=${Boolean(sharedLifeImg)}`);

        emitFeedback({
          bubble: String(parsed.bubble || lastPartsUsed[0] || (sharedLifeImg ? "[给你看我在干嘛]" : "[发了表情包]")).slice(0, 20),
          event: { kind: "qq:proactive", payload: { trigger: decision.kind, angle: chosenAngle?.id || "", sentOk, passive: hasPassive, sendError, parts: lastPartsUsed, stickerId: chosenSticker?.id, lifePhoto: Boolean(sharedLifeImg) } },
        });
        return { ok: true, trigger: decision.kind, angle: chosenAngle?.id || "", sentOk, passive: hasPassive, sendError, parts: lastPartsUsed, stickerId: chosenSticker?.id, lifePhoto: Boolean(sharedLifeImg) };
      } catch (err) {
        const msg = String(err?.message || err);
        log?.error?.(`[dhvw-proactive] 本轮跳过（不退出进程）: ${msg}`);
        lastDecision = { ok: false, reason: "error", error: msg, ts };
        return { ok: false, reason: "error", error: msg };
      } finally {
        busy = false;
      }
    },
  };
}
