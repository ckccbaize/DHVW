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
  getTargets = null,
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
  let lastProactivePhotoAt = Number(persisted.lastProactivePhotoAt) || 0;
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
            lastProactivePhotoAt,
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

      const decision = evaluateProactiveTrigger({
        now: ts,
        phase: world.phase,
        weather: world.weather,
        mood: world.mood,
        band: world.band,
        lastInboundAt,
        lastProactiveAt,
        todayCount,
        dailyCap,
        cooldownMin: primary.account.proactiveCooldownMin ?? 40,
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
        const charCues = typeof runtime.syncCharacterCues === "function" ? runtime.syncCharacterCues(mem?.l0 || []) : [];
        if (runtime.stickerStore?.enabled && (runtime.stickerStore.stats?.().count < 12 || charCues.length > 0)) {
          await Promise.race([
            runtime.stickerStore.searchAndCollect({ mood: { band: world.band, dims: world.mood }, queryHint: decision.seed, characterCues: charCues, limit: 2 }),
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
          ? runtime.stickerStore.selectCandidates({ query: decision.seed, mood: { band: world.band, dims: world.mood }, limit: 6 })
          : [];
        const stickerHint = allowMultiBubble && stickerCandidates.length
          ? `${(runtime.stickerStore?.eagerness ?? 1) >= 2 ? "可用表情包库（热度较高，无生活照时可积极挑 1 个贴合情绪的 id）" : "可用表情包库（多数时候留空即可，极偶尔可填 id）"}：\n${runtime.stickerStore.formatPromptBlock(stickerCandidates)}`
          : "";
        const lifePhotoHint = canProactiveLifePhoto
          ? [
              "【主动分享生活照（可用）】若你觉得此时很适合顺手拍一张此刻在做的日常/风景发给对方（尤其遇到出行/雨雪/兴奋/心情低落/闲聊冒泡），可设置 life_photo.should_generate=true 并详细描述场景：",
              '"life_photo":{"should_generate":true,"scene_desc":"具体生活场景(结合当下时段/天气/地点/动态)","camera_framing":"随拍/自拍景别视角","character_pose":"生动动作与表情","lighting_mood":"光线与氛围"}',
            ].join("\n")
          : "";
        const worldNote = typeof runtime.formatWorldNote === "function"
          ? runtime.formatWorldNote(world, { forceWeather: decision.kind === "weather_shift" })
          : `当前状态：${world.phase || "日常"}，${world.place || "小屋"}`;
        const bubbleRule = canProactiveLifePhoto
          ? 'STRICT JSON：{"speak":true,"parts":["随照片或单独发的话1","可选极短补充第2句"],"sticker_id":"可选id","life_photo":{"should_generate":false,"scene_desc":"","camera_framing":"","character_pose":"","lighting_mood":""},"bubble":"总观气泡(<=18字)","send_edge_bg":false}'
          : allowMultiBubble
            ? 'STRICT JSON：{"speak":true,"parts":["短句1","可选极短补充第2句"],"sticker_id":"可选id","bubble":"总观气泡(<=18字)","send_edge_bg":false}'
            : 'STRICT JSON：{"speak":true,"parts":["仅1句自然的话(10~28字，不要分两句也不要换行)"],"sticker_id":"","bubble":"总观气泡(<=18字)","send_edge_bg":false}';
        const prompt = [
          "你住在虚拟仓里，想起对方了，打算随手在聊天窗里给他发一句话。",
          `触发原因：${decision.kind} - ${decision.reason} (${decision.seed})`,
          worldNote,
          `当前心情：${world.band || "calm"}`,
          ...(charCues.length ? [`当前角色形象特征词：${charCues.join("、")}`] : []),
          `记忆：\n${runtime.formatMemoryBlock(mem)}`,
          ...(styleGuardBlock ? [styleGuardBlock] : []),
          ...(runtime.fewShotStyleBlock ? [runtime.fewShotStyleBlock] : []),
          ...(stickerHint ? [stickerHint] : []),
          ...(lifePhotoHint ? [lifePhotoHint] : []),
          `最近对话：\n${runtime.getHistoryText(6)}`,
          bubbleRule,
          "要求：1. 像真人朋友忽然冒泡，禁止用“对了，之前说…”、“突然想起来，你之前说…”这类翻旧账套话；2. 别总揪着前天聊死的老话题（如看书/下饭剧/早茶）重复发问，多分享此刻的小发现、仓里动态或换个新鲜角度；3. 活泼俏皮有态度，自然带一两个语气词（嘛/呀/吧/咧/哼/切），禁止说教关心与固定模板。",
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
          if (decision.eventId) sharedEventIds.push(decision.eventId);
          if (decision.threadId) runtime.closeThread(decision.threadId);
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

        lastDecision = { ok: sentOk, kind: decision.kind, sentOk, passive: hasPassive, sendError, ts };
        saveState();
        log?.info?.(`[dhvw-proactive] 自唤醒结束 kind=${decision.kind} passive=${hasPassive} sentOk=${sentOk} parts=${sentTextCount} lifePhoto=${Boolean(sharedLifeImg)}`);

        emitFeedback({
          bubble: String(parsed.bubble || lastPartsUsed[0] || (sharedLifeImg ? "[给你看我在干嘛]" : "[发了表情包]")).slice(0, 20),
          event: { kind: "qq:proactive", payload: { trigger: decision.kind, sentOk, passive: hasPassive, sendError, parts: lastPartsUsed, stickerId: chosenSticker?.id, lifePhoto: Boolean(sharedLifeImg) } },
        });
        return { ok: true, trigger: decision.kind, sentOk, passive: hasPassive, sendError, parts: lastPartsUsed, stickerId: chosenSticker?.id, lifePhoto: Boolean(sharedLifeImg) };
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
