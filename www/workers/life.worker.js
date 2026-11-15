// life.worker：端侧 tick 引擎（M11-T11 / PROJECT-PLAN §10.7）。
// 作息 / 漫游 / 天气 / 模板短句 / 事件流。零网络、零 token。
// 用 setInterval 驱动（不用 rAF）：息屏后 rAF 会停，tick 不能停（§10.7.5）。

import { createClock, phaseOf, weekdayInfo } from "../js/core/clock.js";
import { pickLine as pickLineCore, tickInterval } from "../js/core/life/lines.js";
import { weatherAt } from "../js/core/weather.js";
import { describeMood, moodTone } from "../js/core/mood/describe.js";
import { applyMoodEvent, circadianMoodStep, moodDeltaForAct } from "../js/core/machine/life.js";
import { pickDuration } from "../js/core/life/acts.js";
import { ACT_PROPS, chooseHotspot } from "../js/core/life/plan.js";
import { applyEffects, createInteractionRegistry, resolveInteraction } from "../js/core/interactions.js";

const cfg = {
  timeScale: 1, // 1× = 现实时间；30× = 1 现实秒 = 1 游戏分钟
  tickMs: 1000,
  roamMin: 30, // 两次自主行为之间至少隔多少游戏分钟
  thoughtMin: 240, // 两次独白之间至少隔多少游戏分钟
};

let scene = null; // { grid:{w,h,data}, rooms, props, doors, start, hotspots }
let clock = createClock({ day: 1, minute: 8 * 60 });
let weather = "clear";
let phase = "morning";
let currentRoom = null;
let timer = null;
let suspended = false;
let activity = "active"; // active | idle | asleep
let lastIntentMinute = -1e9;
let pending = null; // {x,y,act,room,durationMin}
let busyUntil = -1e9;
let recentSpots = [];
let recentActs = [];
let llmCfg = null;
let lastLlmMinute = -1e9;
let llmBusy = false;
let plan = null;
let mood = { energy: 0.55, valence: 0.55, social: 0.4, focus: 0.5 };
let memoryText = "";
let sleepAt = 22 * 60;
let wakeAt = 8 * 60;
let appliedBehaviors = new Set();
let appliedSudden = false;
let nextPlan = null; // 剧情机在睡前生成的是“明天”的计划，必须等跨天才生效
let interactionRegistry = null;
let activeInteraction = null;
let lastArrival = { key: "", minute: -1e9 };
let badSpots = new Set();
let sleepRetryAt = -1e9;
let interactionFlags = {};
let interactionCooldowns = {};
let away = null; // { place, until, overnight } 外部场景停留

function hashDay(n) {
  let x = (n * 2654435761) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  return x >>> 0;
}

function scheduleFor(day) {
  // 第一天默认 22:00 睡、08:00 起；之后由剧情机决定
  if (plan && plan.day === day && Number.isFinite(plan.sleepAt) && Number.isFinite(plan.wakeAt)) {
    sleepAt = plan.sleepAt;
    wakeAt = plan.wakeAt;
    return;
  }
  sleepAt = 22 * 60;
  wakeAt = 8 * 60;
}

function phaseAt(minute) {
  if (minute >= sleepAt || minute < wakeAt) return "sleep";
  if (minute < wakeAt + 60) return "wake";
  const p = phaseOf(minute);
  return p === "sleep" ? "wake" : p;
}
const DAY_MIN = 24 * 60;
/** 所有截止时间统一用“绝对游戏分钟”，避免 22:00 开始、跨过午夜的交互把 busyUntil 卡死。 */
function nowAbs() {
  return clock.day * DAY_MIN + clock.minute;
}
function migrateDeadline(v) {
  if (!Number.isFinite(v)) return v;
  const now = nowAbs();
  // 旧快照存的是当天分钟数；明显早于当前绝对时间的值视为过期。
  return v < now - DAY_MIN ? now - 1 : v;
}
/** 睡眠交互跨午夜时 endsAt 仍是分钟数；醒来后必须清掉，否则 busyUntil 会锁住一整天。 */
function clearStaleSleep() {
  const now = nowAbs();
  if (phase !== "sleep" && activeInteraction?.act === "sleep") {
    activeInteraction = null;
    busyUntil = Math.min(busyUntil, now);
  }
  if (phase !== "sleep" && busyUntil > now + 480) {
    busyUntil = now;
  }
}

let saidToday = new Map(); // text -> day
let recentLines = [];
let stats = { ticks: 0, intents: 0, says: 0, sinceResume: { rooms: 0, says: 0, sleeps: 0 } };
let lastTs = 0;
let lastWeeklyDate = "";
let moodStepAccum = 0;
let lastSocialMs = Date.now();
let anchorReal = 0;
let anchorMinute = 0;

// ---------- 短句池（本地素材，不是对话；端侧永不产出台词） ----------
const LINES = {
  sleep: ["把被子拉到肩上。", "翻了个身，又安静下来。", "夜里醒了一次，很快又睡着。"],
  wake: ["窗帘没拉开，光已经进来了。", "坐起来发了会儿呆。", "把拖鞋踢正，慢慢站起来。"],
  morning: [
    "把窗开了一条缝。",
    "水烧开了，屋子里有点雾。",
    "今天的光比昨天软一些。",
    "把昨晚的杯子收进水槽。",
    "在窗边站了一会儿，看楼下的人。",
  ],
  noon: ["热了点东西吃。", "把碗筷摞好。", "坐在桌边慢慢吃完。", "把剩下的收进冰箱。"],
  afternoon: [
    "翻了两页书，又合上。",
    "把地毯拍了两下。",
    "猫又跳到窗台上了。",
    "写着写着，笔停了。",
    "把椅子挪到有光的地方。",
  ],
  evening: ["开了盏小灯。", "把窗帘拉了一半。", "锅里的水开始响。", "靠着沙发坐了一会儿。"],
  night: ["把灯关到只剩一盏。", "刷了会儿手机。", "把明天要穿的衣服放好。"],
  weather: {
    rain: ["雨点敲在窗上。", "外面湿了，屋里更安静。", "把晾着的衣服收了进来。"],
    snow: ["雪落得很慢。", "窗台积了薄薄一层。", "把手贴在玻璃上，凉。"],
    clear: ["天很干净。", "阳光斜着进来，落在桌角。"],
    cloudy: ["云压得低，屋里暗了一点。", "把灯提前打开了。"],
  },
};

const PHASE_ROOM = {
  sleep: "bedroom",
  wake: "bedroom",
  morning: "living",
  noon: "hall",
  afternoon: "balcony",
  evening: "hall",
  night: "bedroom",
};

const PHASE_ACT = {
  sleep: "sleep",
  wake: "dress",
  morning: "read",
  noon: "eat",
  afternoon: "work",
  evening: "cook",
  night: "rest",
};

function nowMs() {
  return Date.now();
}

function emit(msg) {
  if (msg.type === "say" && phase === "sleep") return;
  self.postMessage(msg);
}

function event(kind, payload = {}) {
  if (kind === "say" && phase === "sleep") return;
  emit({
    type: "event",
    ev: {
      uuid: crypto.randomUUID(),
      src: "device",
      t_local: nowMs(),
      kind,
      payload: { day: clock.day, minute: Math.round(clock.minute), ...payload },
    },
  });
}

function pickLine() {
  const pool = [...(LINES[phase] || LINES.afternoon)];
  const w = LINES.weather[weather];
  if (w && Math.random() < 0.45) pool.push(...w);
  for (let i = 0; i < 6; i++) {
    const text = pool[Math.floor(Math.random() * pool.length)];
    if (saidToday.get(text) !== clock.day) {
      saidToday.set(text, clock.day);
      return text;
    }
  }
  return null;
}

function hotspotsIn(room) {
  return (scene.hotspots || []).filter((h) => !room || h.room === room);
}

function actProps(act) {
  return scene?.interactions?.acts?.[act]?.trigger?.props || DEBUG_ACT_PROP[act] || [];
}

function actDuration(act) {
  const d = scene?.interactions?.acts?.[act]?.perform?.duration_min;
  return Number.isFinite(d) ? Math.max(1, d) : pickDuration(act);
}

function pickSpotForAct(act, room) {
  return chooseHotspot(scene.hotspots || [], act, {
    room,
    props: actProps(act),
    blocked: badSpots,
  });
}

function pickTarget() {
  const planPlace = plan && plan.day === clock.day ? plan.place : null;
  const roomsWithSpots = [...new Set((scene.hotspots || []).map((h) => h.room).filter(Boolean))];
  let room = planPlace || PHASE_ROOM[phase] || "living";
  if (!hotspotsIn(room).length && roomsWithSpots.length) {
    room = roomsWithSpots[Math.floor(Math.random() * roomsWithSpots.length)];
  }
  // 不要整天黏在同一房间：计划地点也不该把角色钉死
  if (room === currentRoom && roomsWithSpots.length > 1 && Math.random() < 0.45) {
    const others = roomsWithSpots.filter((r) => r !== room);
    room = others[Math.floor(Math.random() * others.length)];
  }
  const inRoom = hotspotsIn(room);
  // 35% 概率去别的房间，避免一直在同一角落
  const roam = inRoom.length > 0 && Math.random() < 0.35;
  const allBase = roam ? scene.hotspots || [] : inRoom.length ? inRoom : scene.hotspots || [];
  const base = allBase.filter((h) => !badSpots.has(`${h.x},${h.y}:${h.act}`) && (h.act === "sleep" || nowAbs() >= (interactionCooldowns[h.act] || 0)));
  if (!base.length) return null;
  // 优先当前时段动作，其次同房间任意热点
  const preferred = roam ? [] : base.filter((h) => h.act === PHASE_ACT[phase]);
  let list = preferred.length ? preferred : base;
  // 避开最近去过的热点，减少原地重复
  const fresh = list.filter((h) => !recentSpots.includes(`${h.x},${h.y}`));
  if (fresh.length) list = fresh;
  let h = list[Math.floor(Math.random() * list.length)];
  let act = h.act;
  // 剧情安排的动作优先（必须找到对应热点）
  if (plan && plan.day === clock.day && plan.act) {
    const props = actProps(plan.act);
    const chosen = chooseHotspot(scene.hotspots || [], plan.act, {
      room: plan.place,
      props,
      blocked: badSpots,
    });
    if (chosen) {
      const p = chosen.hot;
      return { x: p.x, y: p.y, act: chosen.act, room: p.room || room, durationMin: actDuration(chosen.act) };
    }
  }
  // 晚上偶尔写作：必须找到可写热点，且当天没写过
  if ((phase === "evening" || phase === "night") && !recentActs.includes("write") && Math.random() < 0.06) {
    const spot = pickSpotForAct("write");
    if (spot) {
      h = spot.hot;
      act = spot.act;
    }
  }
  // 心情偏置：只改到有对应热点的位置
  const bias = (next, chance) => {
    if (Math.random() >= chance) return;
    const spot = pickSpotForAct(next);
    if (spot) {
      h = spot.hot;
      act = spot.act;
    }
  };
  if (mood.energy < 0.35) bias("rest", 0.4);
  if (mood.valence < 0.38) bias("read", 0.3);
  if (mood.social > 0.6) bias("sit", 0.25);
  const bed = act === "sleep" ? (scene.props || []).find((p) => p.id === "bed") : null;
  return { x: h.x, y: h.y, act, room: h.room || room, durationMin: actDuration(act), bed: bed ? { x: bed.x, y: bed.y, w: bed.w || 1, h: bed.h || 1, facing: bed.facing || "S" } : null };
}

function interactionState() {
  return {
    minute: clock.minute,
    place: currentRoom,
    weather,
    mood,
    flags: interactionFlags,
    cooldowns: interactionCooldowns,
  };
}

function pickInteraction() {
  if (!interactionRegistry?.ok) return null;
  const candidates = [];
  for (const [act, def] of Object.entries(interactionRegistry.acts)) {
    if (nowAbs() < (interactionCooldowns[act] || 0)) continue;
    const hot = (scene.hotspots || []).find((h) => h.act === act && !badSpots.has(`${h.x},${h.y}:${h.act}`));
    if (!hot) continue;
    const chosen = resolveInteraction({
      registry: interactionRegistry,
      prop: hot.prop,
      act,
      state: interactionState(),
    });
    if (chosen) candidates.push({ act, hot, score: chosen.score });
  }
  candidates.sort((a, b) => {
    const recentA = recentActs.slice(-2).includes(a.act) ? 0.5 : 1;
    const recentB = recentActs.slice(-2).includes(b.act) ? 0.5 : 1;
    return b.score * recentB - a.score * recentA;
  });
  return candidates[0] || null;
}

function finishInteraction() {
  if (!activeInteraction) return;
  const { act, def } = activeInteraction;
  const out = applyEffects(def.effects || [], interactionState());
  mood = out.state.mood;
  const actDelta = moodDeltaForAct(act);
  if (actDelta) mood = applyMoodEvent(mood, actDelta);
  if (act === "chat") lastSocialMs = Date.now();
  interactionFlags = out.state.flags;
  interactionCooldowns = out.state.cooldowns;
  interactionCooldowns[act] = nowAbs() + Math.max(5, Number(def.cooldown_min) || 20);
  emit({ type: "mood", mood: { ...mood } });
  for (const e of out.events) {
    if (e.kind === "say") emit({ type: "say", text: e.text, ttl: e.ttl });
    if (e.kind === "event") event(e.name, e.payload || {});
  }
  event("interaction_end", { act });
  activeInteraction = null;
  lastIntentMinute = nowAbs();
  busyUntil = nowAbs();
  requestIntent("interaction:end");
}

async function maybeLlmThought() {
  if (!llmCfg?.baseUrl || !llmCfg?.model || llmBusy) return;
  if (phase === "sleep") return;
  if (nowAbs() - lastLlmMinute < cfg.thoughtMin) return;
  lastLlmMinute = nowAbs();
  llmBusy = true;
  const t0 = Date.now();
  const promptText = `她在${currentRoom || "家里"}，${phase}，天气${weather}。她现在${describeMood(mood)}。${moodTone(mood)}。她记得：${memoryText || "暂无"}。${plan && plan.day === clock.day ? `今天的方向：${plan.text}。` : ""}写一句 20 字内的独白，不要台词，不要解释。`;
  try {
    const res = await fetch("/__llm/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        baseUrl: llmCfg.baseUrl,
        apiKey: llmCfg.apiKey,
        body: {
          model: llmCfg.model,
          messages: [
            { role: "user", content: promptText },
          ],
          max_tokens: 120,
          temperature: 0.8,
          ...(llmCfg.reasoningEffort !== false ? { reasoning_effort: llmCfg.reasoningEffort || "none" } : {}),
        },
      }),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${raw.slice(0, 120)}`);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("LLM 返回不是 JSON");
    }
    if (data?.error?.message) throw new Error(`LLM 错误: ${data.error.message}`);
    const choice = data?.choices?.[0];
    const text = choice?.message?.content?.trim();
    if (!text) {
      throw new Error(choice?.finish_reason === "length" ? "空文本(token耗尽)" : "空文本");
    }
    emit({ type: "say", text: text.slice(0, 40), ttl: 3200 });
    event("llm_thought", { text });
    emit({
      type: "llm_call",
      agent: "thought",
      ok: true,
      ms: Date.now() - t0,
      prompt: promptText,
      response: text || "",
    });
  } catch (err) {
    event("llm_failed", { msg: err.message });
    emit({ type: "llm_call", agent: "thought", ok: false, ms: Date.now() - t0, prompt: promptText, response: err.message });
  } finally {
    llmBusy = false;
  }
}

const DEBUG_ACT_PROP = ACT_PROPS;

function canStartIntent() {
  return !away && !pending && !activeInteraction && nowAbs() >= busyUntil;
}

/** 计划/漫游共用入口；忙时返回 false，调用方必须保留计划项等下一 tick 重试。 */
function planIntent(act, place, reason, opts = {}) {
  if (!canStartIntent()) return false;
  if (phase === "sleep" && act !== "sleep") return false;
  const homeRooms = new Set((scene.rooms || []).map((r) => r.id));
  if (place && !homeRooms.has(place)) {
    const durationMin = Math.max(10, Math.min(480, Number(opts.durationMin) || 60));
    const overnight = opts.overnight === true;
    busyUntil = nowAbs() + durationMin;
    away = { place, until: nowAbs() + durationMin, overnight, act };
    lastIntentMinute = nowAbs();
    event("travel", { to: place, durationMin, overnight, reason, act });
    return true;
  }
  busyUntil = nowAbs();
  const room = place || currentRoom;
  const chosen = opts.hotspot
    ? { hot: opts.hotspot, act: opts.hotspot.act || act }
    : chooseHotspot(scene.hotspots || [], act, {
        room,
        props: actProps(act),
        blocked: badSpots,
      });
  if (!chosen) {
    lastIntentMinute = nowAbs();
    event("plan_skipped", { act, place: room, reason: "no_hotspot" });
    return true;
  }
  const h = chosen.hot;
  const targetAct = chosen.act || act;
  const planned = Number(opts.durationMin);
  const durationMin = Number.isFinite(planned) && planned > 0
    ? Math.max(1, Math.min(480, planned))
    : actDuration(targetAct);
  const t = { x: h.x, y: h.y, act: targetAct, room: h.room || place || currentRoom, durationMin };
  pending = t;
  lastIntentMinute = nowAbs();
  stats.intents += 1;
  emit({ type: "intent", x: t.x, y: t.y, act: t.act, room: t.room, durationMin: t.durationMin, reason });
  return true;
}

function hasDuePlan() {
  if (phase === "sleep" || away || !plan || plan.day !== clock.day) return false;
  return (plan.behaviors || []).some((b, i) => (
    !appliedBehaviors.has(i)
    && b.act
    && clock.minute >= b.minute
    && clock.minute - b.minute < 180
  ));
}

function debugIntent(act) {
  if (phase === "sleep" && act !== "sleep") return;
  pending = null;
  busyUntil = nowAbs();
  const chosen = chooseHotspot(scene.hotspots || [], act, {
    props: actProps(act),
    blocked: badSpots,
  });
  if (!chosen) {
    event("plan_skipped", { act, place: currentRoom, reason: "no_hotspot" });
    return;
  }
  const target = chosen.hot;
  const targetAct = chosen.act || act;
  const t = { x: target.x, y: target.y, act: targetAct, room: target.room || currentRoom, durationMin: actDuration(targetAct) };
  pending = t;
  lastIntentMinute = nowAbs();
  stats.intents += 1;
  emit({ type: "intent", x: t.x, y: t.y, act: t.act, room: t.room, durationMin: t.durationMin, reason: "debug" });
}

function requestIntent(reason) {
  if (away) return;
  if (pending || activeInteraction) return;
  if (hasDuePlan()) return;
  if (phase === "sleep" && reason !== "phase:sleep" && reason !== "debug:sleep") return;
  if (nowAbs() < busyUntil) return;
  if (phase === "sleep") {
    // 床是必需目标：即使曾被临时判坏也要继续尝试，否则只能刷新页面才能恢复。
    const bedHot = (scene.hotspots || []).find((h) => h.act === "sleep" && !badSpots.has(`${h.x},${h.y}:${h.act}`))
      || (scene.hotspots || []).find((h) => h.act === "sleep");
    if (!bedHot) return;
    const bed = (scene.props || []).find((p) => p.id === "bed");
    pending = {
      x: bedHot.x,
      y: bedHot.y,
      act: "sleep",
      room: bedHot.room || "bedroom",
      durationMin: actDuration("sleep"),
      bed: bed ? { x: bed.x, y: bed.y, w: bed.w || 1, h: bed.h || 1, facing: bed.facing || "S" } : null,
    };
    lastIntentMinute = nowAbs();
    stats.intents += 1;
    emit({
      type: "intent",
      x: pending.x,
      y: pending.y,
      act: pending.act,
      room: pending.room,
      durationMin: pending.durationMin,
      bed: pending.bed,
      reason,
    });
    return;
  }
  const target = pickTarget();
  if (!target) return;
  pending = target;
  lastIntentMinute = nowAbs();
  stats.intents += 1;
  emit({
    type: "intent",
    x: target.x,
    y: target.y,
    act: target.act,
    room: target.room,
    durationMin: target.durationMin,
    bed: target.bed,
    reason,
  });
}

function resetAnchor() {
  anchorReal = Date.now();
  anchorMinute = clock.minute;
}

function tick() {
  const ts = nowMs();
  const elapsed = lastTs ? Math.min((ts - lastTs) / 1000, 5) : 0;
  lastTs = ts;
  if (suspended) return;

  stats.ticks += 1;

  // 用墙钟锚点推进，tick 频率/FPS 不影响时间流速
  const minutesPerSecond = activity === "active" ? cfg.timeScale / 30 : cfg.timeScale / 60;
  const target = anchorMinute + ((Date.now() - anchorReal) / 1000) * minutesPerSecond;
  const stepMin = Math.max(0, target - clock.minute);
  clock.advance(target - clock.minute);
  anchorMinute = clock.minute;
  anchorReal = Date.now();

  moodStepAccum += stepMin;
  if (moodStepAccum >= 1) {
    const aloneMinutes = Math.max(0, (Date.now() - lastSocialMs) / 60000);
    mood = circadianMoodStep(mood, { phase, weather, minutes: moodStepAccum, aloneMinutes });
    moodStepAccum = 0;
    emit({ type: "mood", mood: { ...mood } });
  }

  activateNextPlan();
  scheduleFor(clock.day);
  const nextPhase = phaseAt(clock.minute);
  if (nextPhase !== phase) {
    const prev = phase;
    phase = nextPhase;
    if (phase === "sleep") {
      pending = null;
      busyUntil = nowAbs();
      badSpots.clear();
      sleepRetryAt = nowAbs();
      delete interactionCooldowns.sleep;
      requestIntent("phase:sleep");
    } else if (prev === "sleep") {
      event("wake", { to: phase, sleepAt, wakeAt });
    }
  }

  // 天气按游戏日：一天一种，换天时重新随机
  const w = weatherAt(clock.day, clock.minute);
  if (w.state !== weather) {
    weather = w.state;
    event("weather", { weather, temp: w.temp, wind: w.wind, block: w.block });
  }

  if (activeInteraction && nowAbs() >= activeInteraction.endsAt) {
    try {
      finishInteraction();
    } catch (err) {
      event("interaction_error", { msg: err.message, stack: String(err.stack || "").slice(0, 300) });
      activeInteraction = null;
    }
  }

  // 睡眠目标一次失败后继续重试，不能等刷新页面才恢复。
  if (phase === "sleep" && !away && !pending && !activeInteraction && nowAbs() >= sleepRetryAt) {
    sleepRetryAt = nowAbs() + 1;
    requestIntent("phase:sleep");
  }

  // 外部场景停留：到点或睡觉前回家
  if (away) {
    const forceHome = phase === "sleep" && !away.overnight;
    if (forceHome || nowAbs() >= away.until) {
      const from = away.place;
      away = null;
      busyUntil = nowAbs();
      event("return", { from, reason: forceHome ? "sleep" : "stay_end" });
      requestIntent(forceHome ? "phase:sleep" : "return");
    }
  }

  // 剧情机固定日程：到点强制切换行为；睡眠期间、外部场景停留期间不执行
  const wk = weekdayInfo();
  const dNow = new Date();
  const todayKey = `${dNow.getFullYear()}-${String(dNow.getMonth() + 1).padStart(2, "0")}-${String(dNow.getDate()).padStart(2, "0")}`;
  if (wk.weekday === 7 && clock.minute >= 20 * 60 && clock.minute < 22 * 60 && lastWeeklyDate !== todayKey) {
    lastWeeklyDate = todayKey;
    emit({ type: "write", kind: "weekly", room: currentRoom, act: "write", day: clock.day, minute: clock.minute, ...wk });
  }
  if (!away && phase !== "sleep" && plan && plan.day === clock.day) {
    for (let i = 0; i < (plan.behaviors || []).length; i++) {
      const b = plan.behaviors[i];
      if (appliedBehaviors.has(i)) continue;
      if (!b.act || clock.minute < b.minute) continue;
      if (clock.minute - b.minute >= 180) {
        appliedBehaviors.add(i);
        event("plan_skipped", { act: b.act, place: b.place, reason: "late", minute: b.minute });
        continue;
      }
      if (!canStartIntent()) break;
      const ok = planIntent(b.act, b.place, `plan:${b.time || b.minute}`, {
        durationMin: b.durationMin,
        overnight: b.overnight,
      });
      if (ok) {
        appliedBehaviors.add(i);
        break;
      }
      break;
    }
    if (plan.sudden && !appliedSudden && clock.minute >= plan.sudden.minute && clock.minute - plan.sudden.minute < 120) {
      appliedSudden = true;
      event("sudden", { text: plan.sudden.text, minute: plan.sudden.minute });
      emit({ type: "say", text: plan.sudden.text, ttl: 4200 });
    }
  }

  // 漫游：活跃档每 10 游戏分钟换一次目标；息屏档不漫游
  if (!away && !activeInteraction && phase !== "sleep" && activity !== "asleep" && nowAbs() - lastIntentMinute >= cfg.roamMin) {
    const chosen = pickInteraction();
    if (chosen) planIntent(chosen.act, chosen.hot.room, `interaction:${chosen.act}`);
    else requestIntent("roam");
  }
  void maybeLlmThought();

  emit({
    type: "tick",
    day: clock.day,
    minute: clock.minute,
    phase,
    weather,
    room: currentRoom,
    activity,
    busyUntil: busyUntil % DAY_MIN,
    sleepAt,
    wakeAt,
    interaction: activeInteraction ? { act: activeInteraction.act, endsAt: activeInteraction.endsAt % DAY_MIN } : null,
    away: away ? { place: away.place, until: away.until % DAY_MIN, overnight: away.overnight } : null,
  });
  if (stats.ticks % 2 === 0) emitSnapshot();
}

function emitSnapshot() {
  emit({ type: "snapshot", snapshot: snapshotState() });
}

function snapshotState() {
  return {
    day: clock.day,
    minute: Math.round(clock.minute),
    phase,
    room: currentRoom,
    activity,
    busyUntil,
    plan,
    nextPlan,
    sleepAt,
    wakeAt,
    appliedBehaviors: [...appliedBehaviors],
    appliedSudden,
    interaction: activeInteraction ? { act: activeInteraction.act, endsAt: activeInteraction.endsAt } : null,
    away,
  };
}

function activateNextPlan() {
  if (!nextPlan) return;
  if (nextPlan.day < clock.day) {
    nextPlan = null;
    return;
  }
  if (nextPlan.day !== clock.day) return;
  plan = nextPlan;
  nextPlan = null;
  appliedBehaviors = new Set();
  appliedSudden = false;
  scheduleFor(clock.day);
}

function schedule() {
  clearInterval(timer);
  const ms = tickInterval(activity, cfg.tickMs);
  timer = setInterval(tick, ms);
  lastTs = 0;
}

self.onmessage = (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case "init": {
      scene = msg.scene;
      const snap = msg.snapshot || null;
      clock = createClock({ day: snap?.day ?? msg.day ?? 1, minute: snap?.minute ?? msg.minute ?? 8 * 60 });
      if (msg.timeScale) cfg.timeScale = msg.timeScale;
      else if (msg.minutesPerSecond) cfg.timeScale = msg.minutesPerSecond * 30;
      if (msg.tickMs) cfg.tickMs = msg.tickMs;
      if (msg.roamMin) cfg.roamMin = msg.roamMin;
      if (msg.thoughtMin) cfg.thoughtMin = msg.thoughtMin;
      llmCfg = msg.llm || null;
      interactionRegistry = scene?.interactions ? createInteractionRegistry(scene.interactions) : null;
      activeInteraction = null;
      const restoredEndsAt = migrateDeadline(snap?.interaction?.endsAt);
      if (snap?.interaction?.act && Number.isFinite(restoredEndsAt) && restoredEndsAt > nowAbs()) {
        const def = interactionRegistry?.acts?.[snap.interaction.act];
        if (def) activeInteraction = { act: snap.interaction.act, def, endsAt: restoredEndsAt };
      }
      interactionFlags = {};
      interactionCooldowns = {};
      badSpots = new Set();
      weather = weatherAt(clock.day, clock.minute).state;
      scheduleFor(clock.day);
      phase = snap?.phase || phaseAt(clock.minute);
      // 旧快照可能把 sleep 相位带到白天；以当前时钟为准，避免醒来后继续锁住。
      if (phase === "sleep" && phaseAt(clock.minute) !== "sleep") phase = phaseAt(clock.minute);
      currentRoom = snap?.room || PHASE_ROOM[phase] || "living";
      activity = snap?.activity || "active";
      busyUntil = Number.isFinite(snap?.busyUntil) ? migrateDeadline(snap.busyUntil) : -1e9;
      clearStaleSleep();
      plan = snap?.plan && snap.plan.day === clock.day ? snap.plan : null;
      nextPlan = snap?.nextPlan || (snap?.plan && snap.plan.day !== clock.day ? snap.plan : null);
      if (nextPlan && nextPlan.day < clock.day) nextPlan = null;
      if (!plan && nextPlan?.day === clock.day) activateNextPlan();
      scheduleFor(clock.day);
      if (Number.isFinite(snap?.sleepAt)) sleepAt = snap.sleepAt;
      if (Number.isFinite(snap?.wakeAt)) wakeAt = snap.wakeAt;
      appliedBehaviors = new Set(snap?.appliedBehaviors || []);
      if (!Array.isArray(snap?.appliedBehaviors) && plan?.day === clock.day) {
        for (let i = 0; i < (plan.behaviors || []).length; i++) {
          if (Number.isFinite(plan.behaviors[i].minute) && plan.behaviors[i].minute < clock.minute) appliedBehaviors.add(i);
        }
      }
      appliedSudden = !!snap?.appliedSudden;
      away = snap?.away ? { ...snap.away, until: migrateDeadline(snap.away.until) } : null;
      pending = null;
      lastLlmMinute = nowAbs();
      if (phase === "sleep") {
        pending = null;
        busyUntil = nowAbs();
        sleepRetryAt = nowAbs();
        delete interactionCooldowns.sleep;
        requestIntent("phase:sleep");
      }
      resetAnchor();
      schedule();
      emit({ type: "ready", day: clock.day, minute: clock.minute, phase, weather });
      emitSnapshot();
      if (away) event("travel", { to: away.place, durationMin: Math.max(0, away.until - nowAbs()), overnight: away.overnight, reason: "restore", act: away.act || null });
      if (phase !== "sleep") event("wake", { reason: "boot" });
      break;
    }
    case "arrived": {
      if (away) {
        // 外部场景到达：记录计划动作，但不占用 home 的 busyUntil（away.until 负责停留）。
        if (msg.act) event("act", { act: msg.act, room: away.place, durationMin: 0, external: true });
        pending = null;
        break;
      }
      const act = msg.act || pending?.act || null;
      // 睡觉期间只接受 sleep 行为；旧路径/用户点击到达不得把角色带出卧室
      if (phase === "sleep" && act !== "sleep") {
        pending = null;
        break;
      }
      const room = msg.room || pending?.room || currentRoom;
      const arrivalKey = `${room}:${act || ""}`;
      if (lastArrival.key === arrivalKey && nowAbs() - lastArrival.minute < 1) {
        pending = null;
        break;
      }
      lastArrival = { key: arrivalKey, minute: nowAbs() };
      const changed = room !== currentRoom;
      currentRoom = room;
      if (changed) {
        stats.sinceResume.rooms += 1;
        event("enter", { room });
      }
      const durationMin = pending?.durationMin || 10;
      const interactionDef = interactionRegistry?.acts?.[act];
      if (interactionDef) {
        activeInteraction = { act, def: interactionDef, endsAt: nowAbs() + durationMin };
        event("interaction_start", { act });
      }
      if (act) {
        recentActs.push(act);
        if (recentActs.length > 8) recentActs.shift();
      }
      event("act", { act, room, durationMin });
      if (act === "sleep" && phase === "sleep") {
        sleepRetryAt = -1e9;
        const bed = pending?.bed || (scene.props || []).find((p) => p.id === "bed");
        event("sleep", {
          from: "path",
          bed: bed ? { x: bed.x, y: bed.y, w: bed.w || 1, h: bed.h || 1, facing: bed.facing || "S" } : null,
          sleepAt,
          wakeAt,
        });
        stats.sinceResume.sleeps += 1;
      }
      busyUntil = nowAbs() + durationMin;
      if (act === "write") {
        const wk = weekdayInfo();
        emit({ type: "write", room, act, day: clock.day, minute: clock.minute, ...wk });
      }
      recentSpots.push(`${msg.x ?? pending?.x ?? -1},${msg.y ?? pending?.y ?? -1}`);
      if (recentSpots.length > 6) recentSpots.shift();
      pending = null;
      if (phase !== "sleep" && activity !== "asleep") {
        const text = (interactionDef?.bubble && String(interactionDef.bubble).trim())
          || (interactionDef?.label ? `${interactionDef.label}。` : "")
          || pickLineCore({
          phase,
          weather,
          act,
          day: clock.day,
          minute: Math.round(clock.minute),
          recent: recentLines,
        });
        if (text) {
          recentLines.push({ text, day: clock.day, minute: Math.round(clock.minute) });
          if (recentLines.length > 30) recentLines.shift();
          stats.says += 1;
          stats.sinceResume.says += 1;
          emit({ type: "say", text, ttl: 2600 });
          event("say", { text });
        }
      }
      break;
    }
    case "intentFailed": {
      // 睡眠目标不拉黑：一次寻路失败（页面挂起、位置纠偏等）不应让角色整晚睡不了。
      if (pending && pending.act !== "sleep") badSpots.add(`${pending.x},${pending.y}:${pending.act}`);
      if (pending?.act === "sleep") sleepRetryAt = nowAbs() + 1;
      pending = null;
      break;
    }
    case "setActivity": {
      activity = msg.level === "asleep" ? "asleep" : msg.level === "idle" ? "idle" : "active";
      resetAnchor();
      schedule();
      break;
    }
    case "suspend": {
      suspended = true;
      break;
    }
    case "resume": {
      suspended = false;
      lastTs = 0;
      resetAnchor();
      break;
    }
    case "sync": {
      // 主机回显的 clock 可能比端侧旧；只接受向前校准，避免时间倒退。
      if (clock.setForward(msg.day, msg.minute)) {
        phase = phaseOf(clock.minute);
        clearStaleSleep();
        resetAnchor();
        emitSnapshot();
      }
      break;
    }
    case "summary": {
      const s = stats.sinceResume;
      const text =
        s.rooms + s.says + s.sleeps === 0
          ? "你不在的这段时间，屋里一直很安静。"
          : `你不在的这段时间，她换了 ${s.rooms} 次地方，说了 ${s.says} 句，睡了 ${s.sleeps} 觉。`;
      stats.sinceResume = { rooms: 0, says: 0, sleeps: 0 };
      emit({ type: "summary", text });
      break;
    }
    case "setPlan": {
      const incoming = msg.plan || null;
      if (!incoming || incoming.day < clock.day) {
        if (!plan || plan.day < clock.day) plan = null;
      } else if (incoming.day === clock.day) {
        plan = incoming;
        if (nextPlan && nextPlan.day <= incoming.day) nextPlan = null;
        appliedBehaviors = new Set();
        appliedSudden = false;
        scheduleFor(clock.day);
      } else {
        nextPlan = incoming;
      }
      emitSnapshot();
      break;
    }
    case "setMemory": {
      memoryText = String(msg.text || "");
      break;
    }
    case "setMood": {
      mood = { ...mood, ...(msg.mood || {}) };
      break;
    }
    case "setSpeed": {
      cfg.timeScale = Math.max(0.5, Math.min(30, Number(msg.timeScale ?? msg.minutesPerSecond) || 1));
      resetAnchor();
      break;
    }
    case "setLlm": {
      llmCfg = msg.llm || null;
      break;
    }
    case "debug_trigger": {
      const kind = msg.kind;
      if (kind === "thought") {
        lastLlmMinute = -1e9;
        llmBusy = false;
        void maybeLlmThought();
      } else if (kind === "sleep") {
        clock.set(clock.day, 23 * 60);
        phase = "sleep";
        pending = null;
        busyUntil = nowAbs();
        requestIntent("debug:sleep");
      } else if (kind === "wake") {
        clock.set(clock.day, 7 * 60);
        phase = "wake";
        pending = null;
        busyUntil = nowAbs();
        requestIntent("debug:wake");
      } else if (kind === "night") {
        clock.set(clock.day, 23 * 60);
        phase = "sleep";
        pending = null;
        busyUntil = nowAbs();
        requestIntent("debug:sleep");
      } else if (kind === "act" && msg.act) {
        debugIntent(msg.act);
      }
      emit({ type: "debug_triggered", kind, act: msg.act || null, minute: clock.minute });
      emitSnapshot();
      break;
    }
    case "stats": {
      emit({ type: "stats", stats: { ...stats, pending: !!pending, activity, phase, weather } });
      break;
    }
    default:
      break;
  }
};

// 供主线程探活：worker 启动即报一次
emit({ type: "boot" });
