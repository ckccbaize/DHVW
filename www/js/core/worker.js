// 核心机骨架（W1）：消息总线 + 生命周期 + 健康 + 日志环。
// 契约见 docs/CONTRACTS.md §1；本文件只做骨架，不含状态机/记忆/调度。

import { makeMsg, validateMsg, errorMsg, replyMsg } from "./bus.js";

const LOG_CAP = 200;

const state = {
  display: "overview",
  conn: "down",
  tier: "edge",
  paused: false,
  scene: null,
  clock: { day: 1, minute: 8 * 60 },
  mood: { energy: 0.55, valence: 0.55, social: 0.4, focus: 0.5 },
  jobs: 0,
  doctor: { status: "ok", lastCheck: 0 },
};

const logs = [];
let startedAt = 0;
let heartbeat = null;
let ticks = 0;
let lastTickAt = 0;

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

function health() {
  return {
    ok: true,
    uptime: startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0,
    tier: state.tier,
    conn: state.conn,
    display: state.display,
    paused: state.paused,
    ticks,
    lastTickAt,
    queue: state.jobs,
    doctor: state.doctor,
    logs: logs.length,
  };
}

function startHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = setInterval(() => post("core:health", health()), 5000);
}

const handlers = {
  "core:init"(p) {
    startedAt = Date.now();
    if (p.scene) state.scene = p.scene.id || p.scene;
    if (p.clock) state.clock = { day: p.clock.day ?? 1, minute: p.clock.minute ?? 480 };
    if (p.mood) Object.assign(state.mood, p.mood);
    log("info", "init", { scene: state.scene });
    post("core:state", { patch: { ...state } });
    post("core:event", { ev: { uuid: `boot-${startedAt}`, kind: "core_ready", t: Date.now() } });
    startHeartbeat();
    return { ok: true, scene: state.scene };
  },

  "core:input"(p) {
    log("debug", "input", p);
    return { ok: true };
  },

  "core:display"(p) {
    if (p.state !== "overview" && p.state !== "present") {
      throw Object.assign(new Error("display 只能是 overview/present"), { code: "bad_payload" });
    }
    patch({ display: p.state });
    return { ok: true };
  },

  "core:host"(p) {
    const next = p.conn === "up" ? "up" : "down";
    const partial = { conn: next };
    if (p.tier) partial.tier = p.tier;
    patch(partial);
    return { ok: true };
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
    // W1 骨架：记忆模块未接入，返回空结果并标注非语义
    return { hits: [], semantic: false, query: p.text || "" };
  },

  "core:snapshot"() {
    post("core:state", { patch: { ...state } });
    post("core:health", health());
    return { ok: true };
  },

  "core:command"(p) {
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
