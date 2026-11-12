// 核心机骨架（W1）+ 世界状态机（W3）+ 生活状态机（W4）+ 事件日志（W5）。
// 契约见 docs/CONTRACTS.md §1；状态机见 core/machine/*；日志见 core/log/*。

import { makeMsg, validateMsg, errorMsg, replyMsg } from "./bus.js";
import { createWorldRuntime, GRAPH } from "./machine/world.js";
import { createLifeRuntime } from "./machine/life.js";
import { createEventLog, createMemoryBackend } from "./log/events.js";
import { openEventDb, createIdbEventBackend } from "./log/idb.js";

const LOG_CAP = 200;
const WORLD_EVENTS = new Set([
  "HOST_UP",
  "HOST_DOWN",
  "HOST_LOST",
  "PRESENT_REQUEST",
  "PRESENT_EXIT",
  "WORLD_START",
  "WORLD_STOP",
  "EDGE_START",
  "TIER_SET",
  "TAKEOVER",
]);

const state = {
  display: "overview",
  conn: "down",
  tier: "idle",
  paused: false,
  scene: null,
  clock: { day: 1, minute: 8 * 60 },
  mood: { energy: 0.55, valence: 0.55, social: 0.4, focus: 0.5 },
  jobs: 0,
  doctor: { status: "ok", lastCheck: 0 },
  machine: null,
  life: null,
};

const logs = [];
let startedAt = 0;
let heartbeat = null;
let ticks = 0;
let lastTickAt = 0;
let eventLog = null;
let logStats = { count: 0, lastSeq: 0, dropped: 0 };

const life = createLifeRuntime({ minute: 8 * 60 });

const world = createWorldRuntime({
  log(rec) {
    log("info", "world", rec);
    void appendEvent("world_transition", rec);
  },
});

const ready = (async () => {
  try {
    const db = await openEventDb();
    eventLog = createEventLog({ backend: createIdbEventBackend(db) });
  } catch (err) {
    log("warn", "idb_unavailable", { msg: err.message });
    eventLog = createEventLog({ backend: createMemoryBackend() });
  }
  await eventLog.init();
  logStats = eventLog.stats;
})();

function log(level, msg, data) {
  logs.push({ t: Date.now(), level, msg, data });
  if (logs.length > LOG_CAP) logs.shift();
}

function post(type, payload, extra) {
  self.postMessage(makeMsg(type, payload, extra));
}

function patch(partial) {
  Object.assign(state, partial);
  post("core:state", { patch: partial });
}

async function appendEvent(kind, payload = {}, src = "device") {
  await ready;
  const res = await eventLog.append({ kind, payload, src });
  if (!res.duplicate) {
    logStats = eventLog.stats;
    patch({ log: { ...logStats } });
    post("core:event", { ev: res.record });
  }
  return res;
}

/** 把状态机结果镜像到扁平 state（UI 只读扁平字段）。 */
function syncWorld() {
  const m = world.state;
  return {
    display: m.display,
    conn: m.conn,
    tier: m.tier,
    machine: { ...m },
    transitions: world.records.length,
    life: life.snapshot(),
  };
}

function health() {
  return {
    ok: true,
    uptime: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
    display: state.display,
    conn: state.conn,
    tier: state.tier,
    paused: state.paused,
    ticks,
    lastTickAt,
    queue: state.jobs,
    world: { ...world.state },
    transitions: world.records.length,
    illegal: world.state.illegal,
    life: life.snapshot(),
    log: { ...logStats },
    doctor: state.doctor,
    logs: logs.length,
  };
}

function startHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = setInterval(() => post("core:health", health()), 5000);
}

function dispatchWorld(event) {
  if (!WORLD_EVENTS.has(event.type)) {
    throw Object.assign(new Error(`未知世界事件: ${event.type}`), { code: "bad_payload" });
  }
  const res = world.dispatch(event);
  patch(syncWorld());
  return { ok: true, illegal: res.illegal, state: world.state };
}

const handlers = {
  async "core:init"(p) {
    await ready;
    startedAt = Date.now();
    world.reset();
    life.reset({ minute: p.clock?.minute ?? 8 * 60, mood: p.mood });
    if (p.scene) state.scene = p.scene.id || p.scene;
    if (p.clock) state.clock = { day: p.clock.day ?? 1, minute: p.clock.minute ?? 480 };
    if (p.mood) Object.assign(state.mood, p.mood);
    log("info", "init", { scene: state.scene });
    patch({ ...state, ...syncWorld() });
    await appendEvent("core_ready", { scene: state.scene, lastSeq: eventLog.lastSeq });
    startHeartbeat();
    return { ok: true, scene: state.scene, world: world.state, log: eventLog.stats };
  },

  "core:input"(p) {
    log("debug", "input", p);
    return { ok: true };
  },

  "core:display"(p) {
    if (p.state !== "overview" && p.state !== "present") {
      throw Object.assign(new Error("display 只能是 overview/present"), { code: "bad_payload" });
    }
    return dispatchWorld({ type: p.state === "present" ? "PRESENT_REQUEST" : "PRESENT_EXIT" });
  },

  "core:host"(p) {
    const next = p.conn === "up" ? "up" : "down";
    const out = dispatchWorld({ type: next === "up" ? "HOST_UP" : "HOST_DOWN" });
    if (p.tier) dispatchWorld({ type: "TIER_SET", value: p.tier });
    return out;
  },

  "core:pause"() {
    patch({ paused: true });
    return { ok: true };
  },

  "core:resume"() {
    patch({ paused: false });
    return { ok: true };
  },

  "core:query"(p) {
    return { hits: [], semantic: false, query: p.text || "" };
  },

  async "core:snapshot"() {
    await ready;
    patch({ ...state });
    post("core:health", health());
    return {
      ok: true,
      world: world.state,
      life: life.snapshot(),
      graph: GRAPH,
      log: { stats: eventLog.stats, latest: await eventLog.latest(10) },
    };
  },

  async "core:command"(p) {
    await ready;
    if (p.name === "world") {
      const ev = p.args?.event;
      if (!ev || typeof ev.type !== "string") {
        throw Object.assign(new Error("world 命令需要 args.event"), { code: "bad_payload" });
      }
      return dispatchWorld(ev);
    }
    if (p.name === "life_advance") {
      life.advance(p.args?.minutes ?? 60);
      patch({ life: life.snapshot() });
      return { ok: true, life: life.snapshot() };
    }
    if (p.name === "life_mood") {
      life.applyMood(p.args?.deltas || {}, {
        source: p.args?.source || "user",
        reason: p.args?.reason || "",
      });
      patch({ life: life.snapshot() });
      return { ok: true, life: life.snapshot() };
    }
    if (p.name === "life_pick") {
      const chosen = life.pick(p.args?.hotspots || [], p.args?.from || null);
      patch({ life: life.snapshot() });
      return { ok: true, chosen, life: life.snapshot() };
    }
    if (p.name === "log_append") {
      const res = await appendEvent(p.args?.kind || "debug", p.args?.payload || {});
      return { ok: true, ...res, stats: eventLog.stats };
    }
    if (p.name === "log_latest") {
      return { ok: true, events: await eventLog.latest(p.args?.n || 10), stats: eventLog.stats };
    }
    if (p.name === "log_clear") {
      await eventLog.clear();
      logStats = eventLog.stats;
      return { ok: true, stats: logStats };
    }
    if (p.name === "world_reset") {
      world.reset();
      patch(syncWorld());
      return { ok: true, world: world.state };
    }
    log("info", "command", p);
    return { ok: true, name: p.name || null };
  },
};

self.onmessage = async (e) => {
  const msg = e.data;
  const v = validateMsg(msg);
  if (!v.ok) {
    self.postMessage(errorMsg(msg && msg.id, v.code, v.msg));
    return;
  }
  const handler = handlers[msg.type];
  if (!handler) {
    self.postMessage(errorMsg(msg.id, "bad_type", msg.type));
    return;
  }
  try {
    const result = await handler(msg.payload || {});
    if (result !== undefined) self.postMessage(replyMsg(msg.id, result));
  } catch (err) {
    log("error", "handler_failed", { type: msg.type, msg: err.message });
    self.postMessage(errorMsg(msg.id, err.code || "internal", err.message));
  }
};

log("info", "core worker boot");
post("core:health", health());
