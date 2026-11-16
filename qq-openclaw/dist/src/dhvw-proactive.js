/**
 * 心情指数 + 世界事件驱动的主动发起引擎，复用 openclaw-snowluma 的 outbound.js 发送管道。
 * 优先复用 60 分钟被动回复窗口；超窗走合规主动额度，若平台拒绝则自动降级为仅总观气泡。
 */
import { markdownToText } from "./markdown-text.js";
import { sendMedia, sendText } from "./outbound.js";

const QUIET_START_MIN = 23 * 60;
const QUIET_END_MIN = 7 * 60 + 30;
const WEATHER_CUE = new Set(["rain", "snow", "storm"]);
const EVENT_CUE = new Set(["writing", "travel", "return", "browse", "bg_ready"]);

function isQuietHour(ts) {
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= QUIET_START_MIN || m < QUIET_END_MIN;
}

export function dynamicCooldownMs({ mood = {}, band = "calm" } = {}) {
  const social = Number(mood.social ?? 0.4);
  const valence = Number(mood.valence ?? 0.55);
  if (band === "tired") return 150 * 60_000;
  if (social >= 0.65 || valence <= 0.33 || band === "excited") return 45 * 60_000;
  return 90 * 60_000;
}

export function evaluateProactiveTrigger({
  now = Date.now(),
  phase = "morning",
  weather = "clear",
  mood = {},
  band = "calm",
  lastInboundAt = 0,
  lastProactiveAt = 0,
  todayCount = 0,
  dailyCap = 6,
  recentEvents = [],
  threads = [],
  lastWeatherShared = "",
  sharedEventIds = [],
} = {}) {
  if (phase === "sleep" || isQuietHour(now)) return { shouldTrigger: false, reason: "quiet_hours" };
  if (todayCount >= dailyCap) return { shouldTrigger: false, reason: "daily_cap" };
  if (lastInboundAt > 0 && now - lastInboundAt < 5 * 60_000) return { shouldTrigger: false, reason: "recent_inbound" };
  if (lastProactiveAt > 0 && now - lastProactiveAt < dynamicCooldownMs({ mood, band })) {
    return { shouldTrigger: false, reason: "cooldown" };
  }

  const shared = new Set(sharedEventIds || []);
  for (let i = recentEvents.length - 1; i >= 0; i--) {
    const ev = recentEvents[i];
    if (!ev?.id || shared.has(ev.id) || !EVENT_CUE.has(ev.kind)) continue;
    if (ev.ts && now - ev.ts > 45 * 60_000) continue;
    return { shouldTrigger: true, kind: "world_event", eventId: ev.id, reason: `生活事件 ${ev.kind}`, seed: ev.summary || ev.kind };
  }

  if (WEATHER_CUE.has(weather) && lastWeatherShared !== weather) {
    return { shouldTrigger: true, kind: "weather_shift", weather, reason: `天气变化 ${weather}`, seed: `外面现在是${weather}` };
  }

  const social = Number(mood.social ?? 0.4);
  const valence = Number(mood.valence ?? 0.55);
  const energy = Number(mood.energy ?? 0.55);
  if (social >= 0.65) {
    return { shouldTrigger: true, kind: "mood_lonely", reason: `社交欲高 (${social.toFixed(2)})`, seed: "好久没聊天，有点想对方了" };
  }
  if (valence <= 0.33 || band === "low") {
    return { shouldTrigger: true, kind: "mood_low", reason: `心情低落 (${valence.toFixed(2)})`, seed: "情绪有点低，想听对方说说话" };
  }
  if (band === "excited" || (valence >= 0.72 && energy >= 0.68)) {
    return { shouldTrigger: true, kind: "mood_excited", reason: `好心情分享 (${valence.toFixed(2)})`, seed: "心情特别好，想跟对方分享" };
  }

  const due = (threads || []).find((t) => t && !t.closed && (!t.resurfaceAt || t.resurfaceAt <= now));
  if (due) {
    return { shouldTrigger: true, kind: "thread_resurface", threadId: due.id, reason: "聊过的话题线头重浮", seed: due.text };
  }
  return { shouldTrigger: false, reason: "no_trigger" };
}

export function createProactiveRunner({
  getClient,
  getAccount,
  runtime,
  getWorldState = () => ({}),
  queryMemory = async () => ({ semantic: false, l0: [], hits: [] }),
  requestEdgeMedia = async () => "",
  emitFeedback = () => {},
  now = () => Date.now(),
  log,
} = {}) {
  let lastProactiveAt = 0;
  let lastInboundAt = 0;
  let dayKey = "";
  let todayCount = 0;
  let lastWeatherShared = "";
  const sharedEventIds = [];
  const recentEvents = [];
  let busy = false;

  return {
    recordInbound() {
      lastInboundAt = now();
    },
    recordWorldEvent(ev) {
      if (!ev?.kind) return;
      recentEvents.push({ id: ev.id || `${ev.kind}-${now().toString(36)}`, kind: ev.kind, summary: ev.summary || "", ts: ev.ts || now() });
      if (recentEvents.length > 20) recentEvents.shift();
    },
    async tick() {
      if (busy) return { ok: false, reason: "busy" };
      const client = getClient?.();
      const account = getAccount?.();
      const openId = account?.ownerOpenId;
      if (!client || !openId) return { ok: false, reason: "no_owner_client" };
      const world = getWorldState() || {};
      if (world.display === "present" || world.present === true) return { ok: false, reason: "present" };

      const ts = now();
      const dk = new Date(ts).toISOString().slice(0, 10);
      if (dayKey !== dk) {
        dayKey = dk;
        todayCount = 0;
        lastWeatherShared = "";
      }

      const decision = evaluateProactiveTrigger({
        now: ts,
        phase: world.phase,
        weather: world.weather,
        mood: world.mood,
        band: world.band,
        lastInboundAt,
        lastProactiveAt,
        todayCount,
        dailyCap: account.proactiveDailyMax ?? 6,
        recentEvents,
        threads: runtime.getThreads(),
        lastWeatherShared,
        sharedEventIds,
      });
      if (!decision.shouldTrigger) return { ok: false, reason: decision.reason };

      busy = true;
      try {
        const mem = await queryMemory(decision.seed, 5, { band: world.band, dims: world.mood });
        if (runtime.stickerStore?.enabled && runtime.stickerStore.stats?.().count < 12) {
          await Promise.race([
            runtime.stickerStore.searchAndCollect({ mood: { band: world.band, dims: world.mood }, queryHint: decision.seed, limit: 2 }),
            new Promise((r) => setTimeout(r, 2000)),
          ]);
        }
        const stickerCandidates = runtime.stickerStore?.canSendThisTurn({ proactive: true })
          ? runtime.stickerStore.selectCandidates({ query: decision.seed, mood: { band: world.band, dims: world.mood }, limit: 6 })
          : [];
        const stickerHint = stickerCandidates.length
          ? `可用表情包库（情绪合适可在 sticker_id 填入下列 id 之一）：\n${runtime.stickerStore.formatPromptBlock(stickerCandidates)}`
          : "";
        const worldNote = typeof runtime.formatWorldNote === "function"
          ? runtime.formatWorldNote(world, { forceWeather: decision.kind === "weather_shift" })
          : `当前状态：${world.phase || "日常"}，${world.place || "小屋"}`;
        const prompt = [
          "你住在虚拟仓里，突然想在 QQ 上主动给对方发句消息。",
          `触发原因：${decision.kind} - ${decision.reason} (${decision.seed})`,
          worldNote,
          `当前心情：${world.band || "calm"}`,
          `记忆：\n${runtime.formatMemoryBlock(mem)}`,
          ...(stickerHint ? [stickerHint] : []),
          `最近对话：\n${runtime.getHistoryText(8)}`,
          '严格输出 JSON：{"speak":true,"parts":["主动第一句","可选补充短句"],"sticker_id":"可选表情包id","bubble":"总观气泡(<=18字)","send_edge_bg":false,"thread":"可选新线头"}',
          "要求：自然口语短句，除触发原因本身是 weather_shift 外，不要硬扯天气或重复“刚醒”套话。",
        ].join("\n\n");

        const raw = await runtime.callLlm({ messages: [{ role: "user", content: prompt }], json: true, maxTokens: 500, temperature: 0.85 });
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          const m = /\{[\s\S]*\}/.exec(raw);
          if (m) parsed = JSON.parse(m[0]);
        }
        if (!parsed || parsed.speak === false) return { ok: false, reason: "model_silent" };
        const parts = (Array.isArray(parsed.parts) ? parsed.parts : []).map((s) => markdownToText(String(s || ""))).filter(Boolean).slice(0, 2);
        const chosenSticker = parsed.send_edge_bg !== true && parsed.sticker_id
          ? runtime.stickerStore?.resolvePath(parsed.sticker_id)
          : null;
        if (!parts.length && !chosenSticker) return { ok: false, reason: "empty_parts" };

        const to = `snowluma:private:${openId}`;
        let sentOk = false;
        try {
          const delayMs = account.partDelayMs ?? 400;
          for (let i = 0; i < parts.length; i++) {
            if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            await sendText({
              client,
              to,
              text: parts[i],
              proactive: true,
              isWakeup: false,
            });
          }
          if (parsed.send_edge_bg === true) {
            const img = await requestEdgeMedia().catch(() => "");
            if (img) await sendMedia({ client, to, mediaPath: img, proactive: true, isWakeup: false });
          } else if (chosenSticker) {
            if (parts.length && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            await sendMedia({ client, to, mediaPath: chosenSticker.path, proactive: true, isWakeup: false });
            runtime.stickerStore.markUsed(chosenSticker.id);
          }
          sentOk = true;
        } catch (err) {
          log?.info?.(`[dhvw-proactive] QQ 发送受限，降级为仅总观气泡: ${err.message}`);
        }

        lastProactiveAt = ts;
        todayCount += 1;
        if (decision.kind === "weather_shift") lastWeatherShared = decision.weather;
        if (decision.eventId) sharedEventIds.push(decision.eventId);
        if (decision.threadId) runtime.closeThread(decision.threadId);
        if (typeof parsed.thread === "string" && parsed.thread.trim()) runtime.addThread(parsed.thread.trim());
        if (sentOk) {
          const histText = [...parts, ...(chosenSticker ? [`[表情包:${chosenSticker.desc}]`] : [])].join(" ").trim();
          if (histText) runtime.appendAssistantTurn(histText);
        }

        emitFeedback({
          bubble: String(parsed.bubble || parts[0] || "[发了表情包]").slice(0, 20),
          event: { kind: "qq:proactive", payload: { trigger: decision.kind, sentOk, parts, stickerId: chosenSticker?.id } },
        });
        return { ok: true, trigger: decision.kind, sentOk, parts, stickerId: chosenSticker?.id };
      } finally {
        busy = false;
      }
    },
  };
}
