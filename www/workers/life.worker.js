// life.worker：端侧 tick 引擎（M11-T11 / PROJECT-PLAN §10.7）。
// 作息 / 漫游 / 天气 / 模板短句 / 事件流。零网络、零 token。
// 用 setInterval 驱动（不用 rAF）：息屏后 rAF 会停，tick 不能停（§10.7.5）。

import { createClock, phaseOf } from "../js/core/clock.js";
import { pickLine as pickLineCore, tickInterval } from "../js/core/life/lines.js";
import { weatherAt } from "../js/core/weather.js";
import { describeMood, moodTone } from "../js/core/mood/describe.js";
import { pickDuration } from "../js/core/life/acts.js";

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
let llmCfg = null;
let lastLlmMinute = -1e9;
let llmBusy = false;
let plan = null;
let mood = { energy: 0, valence: 0, social: 0, focus: 0 };
let saidToday = new Map(); // text -> day
let recentLines = [];
let stats = { ticks: 0, intents: 0, says: 0, sinceResume: { rooms: 0, says: 0, sleeps: 0 } };
let lastTs = 0;
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
  self.postMessage(msg);
}

function event(kind, payload = {}) {
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

function weatherForDay(day) {
  // 确定性：同一天同一天气
  const h = (day * 2654435761) >>> 0;
  const r = (h % 100) / 100;
  if (r < 0.55) return "clear";
  if (r < 0.78) return "cloudy";
  if (r < 0.93) return "rain";
  return "snow";
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

function pickTarget() {
  const planPlace = plan && plan.day === clock.day ? plan.place : null;
  const room = planPlace || PHASE_ROOM[phase] || "living";
  const inRoom = hotspotsIn(room);
  // 35% 概率去别的房间，避免一直在同一角落
  const roam = inRoom.length > 0 && Math.random() < 0.35;
  const base = roam ? scene.hotspots || [] : inRoom.length ? inRoom : scene.hotspots || [];
  if (!base.length) return null;
  // 优先当前时段动作，其次同房间任意热点
  const preferred = roam ? [] : base.filter((h) => h.act === PHASE_ACT[phase]);
  let list = preferred.length ? preferred : base;
  // 避开最近去过的热点，减少原地重复
  const fresh = list.filter((h) => !recentSpots.includes(`${h.x},${h.y}`));
  if (fresh.length) list = fresh;
  const h = list[Math.floor(Math.random() * list.length)];
  let act = h.act;
  // 剧情安排的动作优先（必须找到对应热点）
  if (plan && plan.day === clock.day && plan.act) {
    const props = DEBUG_ACT_PROP[plan.act] || [];
    const exact = (scene.hotspots || []).filter((x) => x.act === plan.act || props.includes(x.prop));
    if (exact.length) {
      const p = exact[Math.floor(Math.random() * exact.length)];
      return { x: p.x, y: p.y, act: plan.act, room: p.room || room, durationMin: pickDuration(plan.act) };
    }
  }
  // 晚上有概率改成写作（桌边/沙发/床边都行）
  if ((phase === "evening" || phase === "night") && Math.random() < 0.18) {
    act = "write";
  }
  // 心情偏置：低能量想歇，低情绪想静，高社交想出门
  if (mood.energy < -0.25 && Math.random() < 0.4) act = "rest";
  if (mood.valence < -0.3 && Math.random() < 0.3) act = "read";
  if (mood.social > 0.3 && Math.random() < 0.25) act = "sit";
  return { x: h.x, y: h.y, act, room: h.room || room, durationMin: pickDuration(act) };
}

async function maybeLlmThought() {
  if (!llmCfg?.baseUrl || !llmCfg?.model || llmBusy) return;
  if (phase === "sleep") return;
  if (clock.minute - lastLlmMinute < cfg.thoughtMin) return;
  lastLlmMinute = clock.minute;
  llmBusy = true;
  const t0 = Date.now();
  const promptText = `她在${currentRoom || "家里"}，${phase}，天气${weather}。她现在${describeMood(mood)}。${moodTone(mood)}。${plan && plan.day === clock.day ? `今天的方向：${plan.text}。` : ""}写一句 20 字内的独白，不要台词，不要解释。`;
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
          max_tokens: 60,
          temperature: 0.8,
          ...(llmCfg.reasoningEffort ? { reasoning_effort: llmCfg.reasoningEffort } : {}),
        },
      }),
    });
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("空文本");
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
    emit({ type: "llm_call", agent: "thought", ok: false, ms: Date.now() - t0, prompt: "", response: err.message });
  } finally {
    llmBusy = false;
  }
}

const DEBUG_ACT_PROP = {
  read: ["shelf", "bookshelf"],
  cook: ["counter", "stove", "fridge"],
  write: ["table", "desk", "coffee_table"],
  eat: ["table"],
  watch: ["tv"],
  rest: ["sofa", "armchair", "coffee_table"],
  dress: ["wardrobe", "dresser", "coat_rack"],
  bath: ["bathtub"],
  wash: ["sink"],
  laundry: ["washer"],
  play: ["cat_tree"],
  water: ["plant", "plant_big"],
  light: ["lamp"],
  toilet: ["toilet"],
  sit: ["chair", "stool", "bench"],
  sleep: ["bed"],
};

function debugIntent(act) {
  pending = null;
  busyUntil = clock.minute;
  const props = DEBUG_ACT_PROP[act] || [];
  const exact = (scene.hotspots || []).filter((h) => h.act === act || props.includes(h.prop));
  const target = exact.length
    ? exact[Math.floor(Math.random() * exact.length)]
    : pickTarget();
  if (!target) return;
  const t = { x: target.x, y: target.y, act, room: target.room || currentRoom, durationMin: pickDuration(act) };
  pending = t;
  lastIntentMinute = clock.minute;
  stats.intents += 1;
  emit({ type: "intent", x: t.x, y: t.y, act: t.act, room: t.room, durationMin: t.durationMin, reason: "debug" });
}

function requestIntent(reason) {
  if (pending) return;
  if (clock.minute < busyUntil) return;
  const target = pickTarget();
  if (!target) return;
  pending = target;
  lastIntentMinute = clock.minute;
  stats.intents += 1;
  emit({
    type: "intent",
    x: target.x,
    y: target.y,
    act: target.act,
    room: target.room,
    durationMin: target.durationMin,
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
  clock.advance(target - clock.minute);
  anchorMinute = clock.minute;
  anchorReal = Date.now();

  const nextPhase = phaseOf(clock.minute);
  if (nextPhase !== phase) {
    const prev = phase;
    phase = nextPhase;
    if (phase === "sleep") {
      event("sleep", { from: prev });
      stats.sinceResume.sleeps += 1;
      pending = null;
      busyUntil = clock.minute;
      requestIntent("phase:sleep");
    } else if (prev === "sleep") {
      event("wake", { to: phase });
    }
  }

  // 天气每 3 游戏小时一个块，独立于时段
  const w = weatherAt(clock.day, clock.minute);
  if (w.state !== weather) {
    weather = w.state;
    event("weather", { weather, temp: w.temp, wind: w.wind, block: w.block });
  }

  // 漫游：活跃档每 10 游戏分钟换一次目标；息屏档不漫游
  if (activity !== "asleep" && clock.minute - lastIntentMinute >= cfg.roamMin) {
    requestIntent("roam");
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
    busyUntil,
  });
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
      clock = createClock({ day: msg.day ?? 1, minute: msg.minute ?? 8 * 60 });
      if (msg.timeScale) cfg.timeScale = msg.timeScale;
      else if (msg.minutesPerSecond) cfg.timeScale = msg.minutesPerSecond * 30;
      if (msg.tickMs) cfg.tickMs = msg.tickMs;
      if (msg.roamMin) cfg.roamMin = msg.roamMin;
      if (msg.thoughtMin) cfg.thoughtMin = msg.thoughtMin;
      llmCfg = msg.llm || null;
      weather = weatherAt(clock.day, clock.minute).state;
      phase = phaseOf(clock.minute);
      currentRoom = PHASE_ROOM[phase] || "living";
      lastLlmMinute = clock.minute;
      resetAnchor();
      schedule();
      emit({ type: "ready", day: clock.day, minute: clock.minute, phase, weather });
      event("wake", { reason: "boot" });
      break;
    }
    case "arrived": {
      const room = msg.room || pending?.room || currentRoom;
      const changed = room !== currentRoom;
      currentRoom = room;
      if (changed) {
        stats.sinceResume.rooms += 1;
        event("enter", { room });
      }
      const act = msg.act || pending?.act || null;
      // 睡觉期间只接受 sleep 行为；旧路径/用户点击到达不得把角色带出卧室
      if (phase === "sleep" && act !== "sleep" && !pending) {
        pending = null;
        break;
      }
      const durationMin = pending?.durationMin || 10;
      event("act", { act, room, durationMin });
      busyUntil = clock.minute + durationMin;
      if (act === "write") emit({ type: "write", room, act, day: clock.day, minute: clock.minute });
      recentSpots.push(`${msg.x ?? pending?.x ?? -1},${msg.y ?? pending?.y ?? -1}`);
      if (recentSpots.length > 6) recentSpots.shift();
      pending = null;
      if (activity !== "asleep") {
        const text = pickLineCore({
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
      if (Number.isFinite(msg.day) && Number.isFinite(msg.minute)) {
        clock.set(msg.day, msg.minute);
        phase = phaseOf(clock.minute);
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
      plan = msg.plan || null;
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
        busyUntil = clock.minute;
        requestIntent("debug:sleep");
      } else if (kind === "wake") {
        clock.set(clock.day, 7 * 60);
        phase = "wake";
        pending = null;
        busyUntil = clock.minute;
        requestIntent("debug:wake");
      } else if (kind === "act" && msg.act) {
        debugIntent(msg.act);
      }
      emit({ type: "debug_triggered", kind, act: msg.act || null, minute: clock.minute });
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
