// life.worker：端侧 tick 引擎（M11-T11 / PROJECT-PLAN §10.7）。
// 作息 / 漫游 / 天气 / 模板短句 / 事件流。零网络、零 token。
// 用 setInterval 驱动（不用 rAF）：息屏后 rAF 会停，tick 不能停（§10.7.5）。

import { createClock, phaseOf } from "../js/core/clock.js";
import { pickLine as pickLineCore, tickInterval, weatherForDay as weatherForDayCore } from "../js/core/life/lines.js";

const cfg = {
  minutesPerSecond: 1, // 活跃档：1 现实秒 = 1 游戏分钟
  tickMs: 1000,
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
let pending = null; // {x,y,act,room}
let saidToday = new Map(); // text -> day
let recentLines = [];
let stats = { ticks: 0, intents: 0, says: 0, sinceResume: { rooms: 0, says: 0, sleeps: 0 } };
let lastTs = 0;

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
  noon: "living",
  afternoon: "living",
  evening: "living",
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
  const room = PHASE_ROOM[phase] || "living";
  const inRoom = hotspotsIn(room);
  const pool = inRoom.length ? inRoom : scene.hotspots || [];
  if (!pool.length) return null;
  // 优先当前时段动作，其次同房间任意热点
  const preferred = pool.filter((h) => h.act === PHASE_ACT[phase]);
  const list = preferred.length ? preferred : pool;
  const h = list[Math.floor(Math.random() * list.length)];
  return { x: h.x, y: h.y, act: h.act, room: h.room || room };
}

function requestIntent(reason) {
  if (pending) return;
  const target = pickTarget();
  if (!target) return;
  pending = target;
  lastIntentMinute = clock.minute;
  stats.intents += 1;
  emit({ type: "intent", x: target.x, y: target.y, act: target.act, room: target.room, reason });
}

function tick() {
  const ts = nowMs();
  const elapsed = lastTs ? Math.min((ts - lastTs) / 1000, 5) : 0;
  lastTs = ts;
  if (suspended) return;

  stats.ticks += 1;

  const speed = activity === "asleep" ? 1 / 60 : activity === "idle" ? 0.5 : cfg.minutesPerSecond;
  clock.advance(elapsed * speed);

  const nextPhase = phaseOf(clock.minute);
  if (nextPhase !== phase) {
    const prev = phase;
    phase = nextPhase;
    if (phase === "sleep") {
      event("sleep", { from: prev });
      stats.sinceResume.sleeps += 1;
      pending = null;
      requestIntent("phase:sleep");
    } else if (prev === "sleep") {
      event("wake", { to: phase });
    }
    const w = weatherForDay(clock.day);
    if (w !== weather) {
      weather = w;
      event("weather", { weather });
    }
  }

  // 漫游：活跃档每 10 游戏分钟换一次目标；息屏档不漫游
  if (activity !== "asleep" && clock.minute - lastIntentMinute >= 10) {
    requestIntent("roam");
  }

  emit({
    type: "tick",
    day: clock.day,
    minute: clock.minute,
    phase,
    weather,
    room: currentRoom,
    activity,
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
      if (msg.minutesPerSecond) cfg.minutesPerSecond = msg.minutesPerSecond;
      if (msg.tickMs) cfg.tickMs = msg.tickMs;
      weather = weatherForDayCore(clock.day);
      phase = phaseOf(clock.minute);
      currentRoom = PHASE_ROOM[phase] || "living";
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
      event("act", { act: msg.act || pending?.act || null, room });
      pending = null;
      if (activity !== "asleep") {
        const text = pickLineCore({
          phase,
          weather,
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
