// 核心机骨架（W1）+ 世界状态机（W3）。
// 契约见 docs/CONTRACTS.md §1；状态机见 core/machine/world.js。

import { makeMsg, validateMsg, errorMsg, replyMsg } from "./bus.js";
import { createWorldRuntime, GRAPH } from "./machine/world.js";
import { createLifeRuntime } from "./machine/life.js";

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

const life = createLifeRuntime({ minute: 8 * 60 });

const world = createWorldRuntime({
  log(rec) {
    log("info", "world", rec);
    post("core:event", { ev: { uuid: `w-${rec.seq}-${rec.t}`, kind: "world_transition", t: rec.t, payload: rec } });
  },
});

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
  "core:init"(p) {
    startedAt = Date.now();
    world.reset();
    life.reset({ minute: p.clock?.minute ?? 8 * 60, mood: p.mood });
    if (p.scene) state.scene = p.scene.id || p.scene;
    if (p.clock) state.clock = { day: p.clock.day ?? 1, minute: p.clock.minute ?? 480 };
    if (p.mood) Object.assign(state.mood, p.mood);
    log("info", "init", { scene: state.scene });
    patch({ ...state, ...syncWorld(), life: life.snapshot() });
    post("core:event", { ev: { uuid: `boot-${startedAt}`, kind: "core_ready", t: Date.now() } });
    startHeartbeat();
    return { ok: true, scene: state.scene, world: world.state };
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

  "core:snapshot"() {
    patch({ ...state });
    post("core:health", health());
    return { ok: true, world: world.state, life: life.snapshot(), graph: GRAPH };
  },

  "core:command"(p) {
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
      life.applyMood(p.args?.deltas || {});
      patch({ life: life.snapshot() });
      return { ok: true, life: life.snapshot() };
    }
    if (p.name === "life_pick") {
      const chosen = life.pick(p.args?.hotspots || [], p.args?.from || null);
      patch({ life: life.snapshot() });
      return { ok: true, chosen, life: life.snapshot() };
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

self.onmessage = (e) => {
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
    const result = handler(msg.payload || {});
    if (result !== undefined) self.postMessage(replyMsg(msg.id, result));
  } catch (err) {
    log("error", "handler_failed", { type: msg.type, msg: err.message });
    self.postMessage(errorMsg(msg.id, err.code || "internal", err.message));
  }
};

log("info", "core worker boot");
post("core:health", health());
