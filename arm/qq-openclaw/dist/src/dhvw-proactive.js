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
  cooldownMin = 40,
  idleCheckinMin = 35,
  recentEvents = [],
  threads = [],
  lastWeatherShared = "",
  sharedEventIds = [],
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

  const idleThresholdMs = Math.max(5, Number(idleCheckinMin) || 35) * 60_000;
  if (force || lastInboundAt === 0 || now - lastInboundAt >= idleThresholdMs) {
    return {
      shouldTrigger: true,
      kind: "idle_checkin",
      reason: force ? "手动触发一次自唤醒" : "有一阵子没聊了，自然冒泡找对方聊聊",
      seed: "换个轻松的新鲜话题打个招呼、分享当下小日常或随口问句近况",
    };
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
  const stateFile = runtime?.stateDir ? path.join(runtime.stateDir, "proactive-state.json") : "";
  const persisted = (() => {
    try {
      if (stateFile && fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {}
    return {};
  })();

  let lastProactiveAt = Number(persisted.lastProactiveAt) || 0;
  let lastInboundAt = Number(persisted.lastInboundAt) || 0;
  let lastFailedAttemptAt = Number(persisted.lastFailedAttemptAt) || 0;
  let dayKey = String(persisted.dayKey || "");
  let todayCount = Number(persisted.todayCount) || 0;
  let lastWeatherShared = String(persisted.lastWeatherShared || "");
  let lastSendError = String(persisted.lastSendError || "");
  let lastSendErrorAt = Number(persisted.lastSendErrorAt) || 0;
  let wakeupBlockedDayKey = String(persisted.wakeupBlockedDayKey || "");
  const sharedEventIds = Array.isArray(persisted.sharedEventIds) ? persisted.sharedEventIds.slice(-30) : [];
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
            lastInboundAt,
            lastFailedAttemptAt,
            dayKey,
            todayCount,
            lastWeatherShared,
            lastSendError,
            lastSendErrorAt,
            wakeupBlockedDayKey,
            sharedEventIds: sharedEventIds.slice(-30),
            lastDecision,
          },
          null,
          2,
        ),
        "utf8",
      );
    } catch {}
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
      const client = getClient?.();
      const openId = getAccount?.()?.ownerOpenId;
      const snap = openId ? client?.ledger?.snapshot?.(openId) : null;
      const dkNow = new Date(now()).toISOString().slice(0, 10);
      const quotaStatus = snap?.active
        ? `60分钟被动窗口可用(剩${snap.remainingSeq}次)`
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
      const client = getClient?.();
      const account = getAccount?.();
      const openId = account?.ownerOpenId;
      if (!client || !openId) return { ok: false, reason: "no_owner_client" };
      const world = getWorldState() || {};
      if (!force && (world.display === "present" || world.present === true)) {
        return { ok: false, reason: "present" };
      }

      const ts = now();
      const dk = new Date(ts).toISOString().slice(0, 10);
      const passiveActiveNow = Boolean(client.ledger?.snapshot?.(openId)?.active);
      if (!force && !passiveActiveNow && wakeupBlockedDayKey === dk) {
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
        cooldownMin: account.proactiveCooldownMin ?? 40,
        recentEvents,
        threads: runtime.getThreads(),
        lastWeatherShared,
        sharedEventIds,
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
        const mem = await queryMemory(decision.seed, 5, { band: world.band, dims: world.mood });
        if (runtime.stickerStore?.enabled && runtime.stickerStore.stats?.().count < 12) {
          await Promise.race([
            runtime.stickerStore.searchAndCollect({ mood: { band: world.band, dims: world.mood }, queryHint: decision.seed, limit: 2 }),
            new Promise((r) => setTimeout(r, 2000)),
          ]);
        }
        const to = `snowluma:private:${openId}`;
        const ledgerSnap = client.ledger?.snapshot?.(openId) || { active: false, remainingSeq: 0 };
        const hasPassive = Boolean(ledgerSnap.active && ledgerSnap.remainingSeq >= 1);
        const allowMultiBubble = hasPassive && ledgerSnap.remainingSeq >= 2;
        const styleGuardBlock = typeof runtime.getStyleGuard === "function" ? runtime.getStyleGuard() : "";

        const stickerCandidates = runtime.stickerStore?.canSendThisTurn({ proactive: true })
          ? runtime.stickerStore.selectCandidates({ query: decision.seed, mood: { band: world.band, dims: world.mood }, limit: 4 })
          : [];
        const stickerHint = allowMultiBubble && stickerCandidates.length
          ? `可用表情包库（多数时候留空即可，极偶尔可填 id）：\n${runtime.stickerStore.formatPromptBlock(stickerCandidates)}`
          : "";
        const worldNote = typeof runtime.formatWorldNote === "function"
          ? runtime.formatWorldNote(world, { forceWeather: decision.kind === "weather_shift" })
          : `当前状态：${world.phase || "日常"}，${world.place || "小屋"}`;
        const bubbleRule = allowMultiBubble
          ? 'STRICT JSON：{"speak":true,"parts":["短句1","可选极短补充第2句"],"sticker_id":"多数留空","bubble":"总观气泡(<=18字)","send_edge_bg":false}'
          : 'STRICT JSON：{"speak":true,"parts":["仅1句自然的话(10~28字，不要分两句也不要换行)"],"sticker_id":"","bubble":"总观气泡(<=18字)","send_edge_bg":false}';
        const prompt = [
          "你住在虚拟仓里，想起对方了，打算随手在 QQ 上给他发一句话。",
          `触发原因：${decision.kind} - ${decision.reason} (${decision.seed})`,
          worldNote,
          `当前心情：${world.band || "calm"}`,
          `记忆：\n${runtime.formatMemoryBlock(mem)}`,
          ...(styleGuardBlock ? [styleGuardBlock] : []),
          ...(runtime.fewShotStyleBlock ? [runtime.fewShotStyleBlock] : []),
          ...(stickerHint ? [stickerHint] : []),
          `最近对话：\n${runtime.getHistoryText(6)}`,
          bubbleRule,
          "要求：1. 像真人朋友忽然冒泡，禁止用“对了，之前说…”、“突然想起来，你之前说…”这类翻旧账套话；2. 别总揪着前天聊死的老话题（如看书/下饭剧/早茶）重复发问，多分享此刻的小发现、仓里动态或换个新鲜角度；3. 禁止说教关心与固定两段模板，越自然简短越好。",
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
        const chosenSticker = allowMultiBubble && parsed.send_edge_bg !== true && parsed.sticker_id
          ? runtime.stickerStore?.resolvePath(parsed.sticker_id)
          : null;
        if (!parts.length && !chosenSticker) return { ok: false, reason: "empty_parts" };

        // 超出 60 分钟被动窗口（走主动/is_wakeup 配额）或被动余量仅 1 条时，只发 1 条短气泡，不再拼接多段换行
        const sendParts =
          parts.length > 1 && (!hasPassive || ledgerSnap.remainingSeq < parts.length)
            ? [parts.join("\n")]
            : parts;
        const canSendAttachment = hasPassive && ledgerSnap.remainingSeq >= sendParts.length + 1;

        let sentOk = false;
        let sentTextCount = 0;
        let sentMedia = false;
        let sendError = "";
        try {
          const delayMs = account.partDelayMs ?? 400;
          for (let i = 0; i < sendParts.length; i++) {
            if (i > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            await sendText({
              client,
              to,
              text: sendParts[i],
              proactive: true,
              isWakeup: true,
            });
            sentOk = true;
            sentTextCount += 1;
          }
          if (parsed.send_edge_bg === true && (canSendAttachment || !sendParts.length)) {
            const img = await requestEdgeMedia().catch(() => "");
            if (img) {
              await sendMedia({ client, to, mediaPath: img, proactive: true, isWakeup: true });
              sentOk = true;
              sentMedia = true;
            }
          } else if (chosenSticker && (canSendAttachment || !sendParts.length)) {
            if (sendParts.length && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            await sendMedia({ client, to, mediaPath: chosenSticker.path, proactive: true, isWakeup: true });
            runtime.stickerStore.markUsed(chosenSticker.id);
            sentOk = true;
            sentMedia = true;
          }
        } catch (err) {
          sendError = String(err?.message || err);
          log?.warn?.(`[dhvw-proactive] QQ 主动发送受限: ${sendError}`);
        }

        if (sentOk) {
          lastProactiveAt = ts;
          todayCount += 1;
          lastFailedAttemptAt = 0;
          lastSendError = "";
          if (decision.kind === "weather_shift") lastWeatherShared = decision.weather;
          if (decision.eventId) sharedEventIds.push(decision.eventId);
          if (decision.threadId) runtime.closeThread(decision.threadId);
          const histText = [
            ...sendParts.slice(0, sentTextCount),
            ...(sentMedia && chosenSticker ? [`[表情包:${chosenSticker.desc}]`] : []),
          ]
            .join(" ")
            .trim();
          if (histText) runtime.appendAssistantTurn(histText);
        } else {
          lastFailedAttemptAt = ts;
          lastSendError = sendError || "send_failed";
          lastSendErrorAt = ts;
          if (!hasPassive && /40034122|召回消息已达区间上限/.test(lastSendError)) {
            wakeupBlockedDayKey = dk;
          }
        }

        lastDecision = { ok: sentOk, kind: decision.kind, sentOk, passive: hasPassive, sendError, ts };
        saveState();
        log?.info?.(`[dhvw-proactive] 自唤醒结束 kind=${decision.kind} passive=${hasPassive} sentOk=${sentOk} parts=${sentTextCount}`);

        emitFeedback({
          bubble: String(parsed.bubble || sendParts[0] || "[发了表情包]").slice(0, 20),
          event: { kind: "qq:proactive", payload: { trigger: decision.kind, sentOk, passive: hasPassive, sendError, parts: sendParts, stickerId: chosenSticker?.id } },
        });
        return { ok: true, trigger: decision.kind, sentOk, passive: hasPassive, sendError, parts: sendParts, stickerId: chosenSticker?.id };
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
