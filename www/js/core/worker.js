// 核心机骨架（W1）+ 世界状态机（W3）+ 生活状态机（W4）+ 事件日志（W5）。
// 契约见 docs/CONTRACTS.md §1；状态机见 core/machine/*；日志见 core/log/*。

import { makeMsg, validateMsg, errorMsg, replyMsg } from "./bus.js";
import { createWorldRuntime, GRAPH } from "./machine/world.js";
import { createLifeRuntime } from "./machine/life.js";
import { createEventLog, createMemoryBackend } from "./log/events.js";
import { openCoreDb, createIdbEventBackend } from "./log/idb.js";
import { createSnapshotStore, createMemorySnapshotStore, validateSnapshot } from "./snapshot.js";
import { createHostBridge } from "./host.js";
import { createRemoteRuntime } from "../runtime/remote.js";
import { createLocalMemory, createIdbMemoryBackend, createMemoryDocBackend } from "./memory/local.js";
import { createRemoteMemory } from "./memory/remote.js";
import { createScheduler, createIdbJobBackend, createMemoryJobBackend } from "./sched/scheduler.js";
import { createProviderStore, maskKey, isConfigured } from "./llm/provider.js";
import { createLlmClient } from "./llm/client.js";
import { createBudgetLedger } from "./llm/budget.js";
import { createAgentRegistry } from "./agent/registry.js";
import { createManagerAgent } from "./agent/manager.js";
import { createPlotAgent, EVENT_POOL } from "./agent/subs/plot.js";
import { createEventPoolAgent } from "./agent/subs/events.js";
import { createBgAgent } from "./agent/subs/bg.js";
import { createIdbKvBackend, createMemoryKvBackend } from "./kv.js";

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
  host: { conn: "down", offsetMs: 0, lastSeen: 0, session: null },
};

const logs = [];
let startedAt = 0;
let heartbeat = null;
let ticks = 0;
let lastTickAt = 0;
let eventLog = null;
let kvBackend = null;
let logStats = { count: 0, lastSeq: 0, dropped: 0 };
let snapStore = createMemorySnapshotStore();
let snapMeta = { ts: 0, lastSeq: 0, resumed: false };
let saveTimer = null;
let remote = null;
let lastSyncedSeq = 0;
let localMemory = null;
let scheduler = null;
let providerStore = null;
let llm = null;
let budget = null;
let agentRegistry = null;
let manager = null;
let plotAgent = null;
let bgAgent = null;
let bgMeta = null;
let eventPoolAgent = null;
let eventPool = { updatedAt: 0, events: [] };

const life = createLifeRuntime({ minute: 8 * 60 });

const host = createHostBridge({
  dispatchWorld: (ev) => dispatchWorld(ev),
  send: (m) => (remote ? remote.send(m) : false),
  post,
});

const remoteMemory = createRemoteMemory({
  send: (m) => (host ? host.sendRaw(m) : false),
  timeoutMs: 200,
});
host.setMemoryHandler((payload) => remoteMemory.handle(payload));

const world = createWorldRuntime({
  log(rec) {
    log("info", "world", rec);
    void appendEvent("world_transition", rec);
  },
});

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const ready = (async () => {
  let memoryBackend = null;
  let jobBackend = null;
  try {
    const db = await withTimeout(openCoreDb(), 3000, "indexedDB open");
    eventLog = createEventLog({ backend: createIdbEventBackend(db) });
    snapStore = createSnapshotStore(db);
    memoryBackend = createIdbMemoryBackend(db);
    jobBackend = createIdbJobBackend(db);
    kvBackend = createIdbKvBackend(db);
  } catch (err) {
    log("warn", "idb_unavailable", { msg: err.message });
    eventLog = createEventLog({ backend: createMemoryBackend() });
    snapStore = createMemorySnapshotStore();
    memoryBackend = createMemoryDocBackend();
    jobBackend = createMemoryJobBackend();
    kvBackend = createMemoryKvBackend();
  }
  localMemory = createLocalMemory({
    backend: memoryBackend,
    now: () => Date.now() + (host ? host.offsetMs : 0),
  });
  scheduler = createScheduler({
    backend: jobBackend,
    maxSliceMs: 5000,
    onEvent: (e) => {
      log("debug", "sched", { type: e.type, id: e.job?.id, kind: e.job?.kind });
      patch({ sched: scheduler.stats });
    },
  });
  scheduler.register("debug", async (payload, { shouldYield }) => {
    const ms = Math.max(10, Number(payload.ms) || 50);
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (shouldYield()) throw Object.assign(new Error("yield"), { code: "yield" });
      await new Promise((r) => setTimeout(r, 10));
    }
    return { ok: true, ms };
  });

  providerStore = createProviderStore({ backend: kvBackend });
  await providerStore.init();
  budget = createBudgetLedger({ backend: kvBackend });
  await budget.init();
  agentRegistry = createAgentRegistry();
  try {
    await agentRegistry.load();
  } catch (err) {
    log("warn", "agent_registry_failed", { msg: err.message });
  }
  llm = createLlmClient({
    getProvider: () => providerStore.get(),
    onUsage: (e) => {
      if (!budget) return;
      budget.record(e);
      patch({ budget: budget.stats() });
    },
  });
  plotAgent = createPlotAgent({ llm, registry: agentRegistry });
  bgAgent = createBgAgent();
  eventPoolAgent = createEventPoolAgent({ llm, registry: agentRegistry });
  const savedPool = await kvBackend.get("event_pool");
  if (savedPool && Array.isArray(savedPool.events)) eventPool = savedPool;
  scheduler.register("event_pool", async () => {
    await refreshEventPool(6);
  });
  manager = createManagerAgent({
    llm,
    registry: agentRegistry,
    subAgents: { "plot-writer": (args) => plotAgent.run(args) },
    appendEvent: (kind, payload) => appendEvent(kind, payload),
    saveRun: async (rec) => {
      const prev = (await kvBackend.get("agent_runs")) || [];
      await kvBackend.put("agent_runs", [rec, ...prev].slice(0, 50));
    },
  });
  host.setLlmConfigHandler(async (patch) => {
    await providerStore.set(patch);
    patchState({ llm: llmView() });
  });

  await eventLog.init();
  await localMemory.init();
  await scheduler.init();
  if (Date.now() - eventPool.updatedAt > 6 * 3600 * 1000) {
    scheduler.enqueue({ kind: "event_pool", priority: 6 });
  }
  setInterval(() => {
    if (Date.now() - eventPool.updatedAt < 6 * 3600 * 1000) return;
    if (scheduler.queue.some((j) => j.kind === "event_pool")) return;
    scheduler.enqueue({ kind: "event_pool", priority: 6 });
  }, 30 * 60 * 1000);
  logStats = eventLog.stats;
})();

async function refreshEventPool(count = 6) {
  if (!eventPoolAgent) return { ok: false, reason: "not_ready", events: [], rejected: [] };
  const existing = [...EVENT_POOL.map((e) => e.text), ...eventPool.events.map((e) => e.text)];
  const r = await eventPoolAgent.refresh({ existing, count });
  if (r.ok) {
    eventPool = {
      updatedAt: Date.now(),
      events: [...r.events, ...eventPool.events].slice(0, 60),
    };
    await kvBackend.put("event_pool", eventPool);
    await appendEvent("event_pool:updated", {
      added: r.events.length,
      rejected: r.rejected.length,
      total: eventPool.events.length,
    });
    patch({ eventPool: { total: eventPool.events.length, updatedAt: eventPool.updatedAt } });
  }
  return r;
}

function llmView() {
  if (!providerStore) return null;
  const p = providerStore.get();
  return {
    configured: isConfigured(p),
    baseUrl: p.baseUrl,
    model: p.model,
    maskedKey: maskKey(p.apiKey),
    timeoutMs: p.timeoutMs,
    maxAttempts: p.maxAttempts,
    retryBaseMs: p.retryBaseMs,
    stats: llm ? llm.stats : null,
  };
}

function patchState(partial) {
  patch(partial);
}

async function persistSnapshot(reason = "auto") {
  await ready;
  const snap = {
    v: 1,
    ts: Date.now(),
    lastSeq: eventLog.lastSeq,
    lastSyncedSeq,
    world: world.state,
    life: life.snapshot(),
    reason,
  };
  try {
    await snapStore.save(snap);
    snapMeta = { ts: snap.ts, lastSeq: snap.lastSeq, resumed: snapMeta.resumed };
    patch({ snapshot: { ...snapMeta } });
  } catch (err) {
    log("warn", "snapshot_save_failed", { msg: err.message });
  }
  return snap;
}

function scheduleSnapshot() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void persistSnapshot("debounce");
  }, 2000);
}

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

async function queryMemory(text, k = 5) {
  await ready;
  if (host.conn === "up") {
    try {
      const r = await remoteMemory.query(text, k);
      return { hits: r.hits || [], semantic: true, source: "pc", query: text };
    } catch (err) {
      log("debug", "memory_remote_failed", { code: err.code || "error" });
    }
  }
  return { hits: localMemory.search(text, { k }), semantic: false, source: "local", query: text };
}

async function flushEvents() {
  await ready;
  if (!remote || remote.conn !== "up") return 0;
  const events = await eventLog.since(lastSyncedSeq, 200);
  if (!events.length) return 0;
  if (host.eventsBatch(events)) {
    lastSyncedSeq = events[events.length - 1].seq;
    scheduleSnapshot();
  }
  return events.length;
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
    snapshot: { ...snapMeta },
    transitions: world.records.length,
    illegal: world.state.illegal,
    host: {
      conn: host.conn,
      offsetMs: host.offsetMs,
      lastSeen: host.lastSeen,
      session: host.sessionId,
    },
    lastSyncedSeq,
    memory: {
      count: localMemory ? localMemory.count : 0,
      terms: localMemory ? localMemory.terms : 0,
      remote: remoteMemory.stats,
    },
    sched: scheduler ? scheduler.stats : null,
    llm: llmView(),
    budget: budget ? budget.stats() : null,
    agent: agentRegistry ? agentRegistry.stats() : { loaded: false },
    bg: bgMeta,
    eventPool: { total: eventPool.events.length, updatedAt: eventPool.updatedAt },
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
  if (scheduler) scheduler.setPresent(world.state.display === "present");
  if (event.type === "PRESENT_REQUEST" && !res.illegal) host.presentBegin();
  if (event.type === "PRESENT_EXIT" && !res.illegal) host.presentEnd();
  scheduleSnapshot();
  return { ok: true, illegal: res.illegal, state: world.state };
}

const handlers = {
  async "core:init"(p) {
    await ready;
    startedAt = Date.now();
    let snap = null;
    try {
      snap = validateSnapshot(await snapStore.load());
    } catch (err) {
      log("warn", "snapshot_load_failed", { msg: err.message });
    }
    if (snap) {
      try {
        world.reset(snap.world);
        life.restore(snap.life);
        lastSyncedSeq = Number(snap.lastSyncedSeq) || 0;
        snapMeta = { ts: snap.ts, lastSeq: snap.lastSeq, resumed: true };
        log("info", "snapshot_restored", { ts: snap.ts, lastSeq: snap.lastSeq });
      } catch (err) {
        log("warn", "snapshot_invalid", { msg: err.message });
        world.reset();
        life.reset({ minute: p.clock?.minute ?? 8 * 60, mood: p.mood });
        snapMeta = { ts: 0, lastSeq: 0, resumed: false };
      }
    } else {
      world.reset();
      life.reset({ minute: p.clock?.minute ?? 8 * 60, mood: p.mood });
      snapMeta = { ts: 0, lastSeq: 0, resumed: false };
    }
    if (p.scene) state.scene = p.scene.id || p.scene;
    if (p.clock) state.clock = { day: p.clock.day ?? 1, minute: p.clock.minute ?? 480 };
    if (p.mood) Object.assign(state.mood, p.mood);
    log("info", "init", { scene: state.scene });
    patch({ ...state, ...syncWorld() });
    if (remote) {
      remote.stop();
      remote = null;
    }
    const hostCfg = p.config?.host || {};
    remote = createRemoteRuntime({
      url: hostCfg.wsUrl || "",
      probeUrl: hostCfg.probeUrl || "",
      onConn: (next, info) => {
        host.onConn(next, info);
        if (next === "up") void flushEvents();
      },
      onMessage: (m) => host.onMessage(m),
      log: (m) => log("info", "remote", { msg: m }),
    });
    remote.start();

    await appendEvent("core_ready", {
      scene: state.scene,
      lastSeq: eventLog.lastSeq,
      resumed: snapMeta.resumed,
    });
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

  async "core:query"(p) {
    return queryMemory(p.text || "", p.k || 5);
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
      scheduleSnapshot();
      return { ok: true, life: life.snapshot() };
    }
    if (p.name === "life_mood") {
      life.applyMood(p.args?.deltas || {}, {
        source: p.args?.source || "user",
        reason: p.args?.reason || "",
      });
      patch({ life: life.snapshot() });
      scheduleSnapshot();
      return { ok: true, life: life.snapshot() };
    }
    if (p.name === "life_pick") {
      const chosen = life.pick(p.args?.hotspots || [], p.args?.from || null);
      patch({ life: life.snapshot() });
      scheduleSnapshot();
      return { ok: true, chosen, life: life.snapshot() };
    }
    if (p.name === "log_append") {
      const res = await appendEvent(p.args?.kind || "debug", p.args?.payload || {});
      return { ok: true, ...res, stats: eventLog.stats };
    }
    if (p.name === "log_latest") {
      return { ok: true, events: await eventLog.latest(p.args?.n || 10), stats: eventLog.stats };
    }
    if (p.name === "agent_skills") {
      return { ok: true, skills: agentRegistry ? agentRegistry.list() : [], stats: agentRegistry.stats() };
    }
    if (p.name === "agent_run") {
      const r = await manager.run(p.args?.intent, p.args?.ctx || {});
      return { ...r };
    }
    if (p.name === "agent_plot") {
      const recent = (await kvBackend.get("plot_recent")) || [];
      const recentEvents = (await kvBackend.get("plot_events")) || [];
      const r = await plotAgent.run({
        input: p.args?.input || "",
        place: p.args?.place || "",
        mood: p.args?.mood || "",
        recent,
        recentEvents,
        extraEvents: eventPool.events,
      });
      if (r.ok) {
        life.applyMood(r.mood, { source: "plot", reason: r.event });
        patch({ life: life.snapshot() });
        scheduleSnapshot();
        await kvBackend.put("plot_recent", [r.text, ...recent].slice(0, 20));
        await kvBackend.put("plot_events", [r.event, ...recentEvents].slice(0, 10));
        await kvBackend.put("last_plot", {
          text: r.text,
          event: r.event,
          place: r.place,
          scene: r.scene,
          imageQuery: r.imageQuery,
          ts: Date.now(),
        });
        await appendEvent("plot:generated", {
          text: r.text,
          event: r.event,
          place: r.place,
          scene: r.scene,
          imageQuery: r.imageQuery,
          mood: r.mood,
          attempts: r.attempts,
        });
      }
      return { ...r, life: life.snapshot() };
    }
    if (p.name === "event_pool_refresh") {
      return await refreshEventPool(p.args?.count || 6);
    }
    if (p.name === "event_pool_list") {
      return { ok: true, updatedAt: eventPool.updatedAt, events: eventPool.events };
    }
    if (p.name === "event_pool_clear") {
      eventPool = { updatedAt: 0, events: [] };
      await kvBackend.put("event_pool", eventPool);
      patch({ eventPool: { total: 0, updatedAt: 0 } });
      return { ok: true };
    }
    if (p.name === "plot_clear") {
      await kvBackend.put("plot_recent", []);
      await kvBackend.put("plot_events", []);
      await kvBackend.put("last_plot", null);
      return { ok: true };
    }
    if (p.name === "bg_search") {
      return await bgAgent.search(p.args?.query, { n: p.args?.n, provider: p.args?.provider });
    }
    if (p.name === "bg_prepare") {
      const r = await bgAgent.prepare(p.args?.url);
      if (r.ok) {
        const { bytes, ...meta } = r;
        bgMeta = meta;
        await kvBackend.put("bg_last", { bytes, meta });
        patch({ bg: bgMeta });
      }
      const { bytes, ...rest } = r;
      return rest;
    }
    if (p.name === "bg_generate") {
      const r = await bgAgent.generate(p.args?.query, { n: p.args?.n, provider: p.args?.provider });
      if (r.ok) {
        const { bytes, ...meta } = r;
        bgMeta = meta;
        await kvBackend.put("bg_last", { bytes, meta });
        patch({ bg: bgMeta });
      }
      const { bytes, ...rest } = r;
      return rest;
    }
    if (p.name === "bg_last") {
      const saved = await kvBackend.get("bg_last");
      return { ok: !!saved, meta: saved?.meta || null };
    }
    if (p.name === "agent_runs") {
      return { ok: true, runs: (await kvBackend.get("agent_runs")) || [] };
    }
    if (p.name === "agent_prompt") {
      const text = agentRegistry.render(p.args?.name, p.args?.vars || {});
      return { ok: true, name: p.args?.name, text };
    }
    if (p.name === "budget_stats") {
      return { ok: true, budget: budget.stats() };
    }
    if (p.name === "budget_history") {
      return { ok: true, history: budget.history(p.args?.days || 7) };
    }
    if (p.name === "budget_soft_limit") {
      const v = budget.setSoftLimit(p.args?.limit);
      patch({ budget: budget.stats() });
      return { ok: true, softLimitOut: v, budget: budget.stats() };
    }
    if (p.name === "budget_reset") {
      const s = await budget.reset(p.args?.day);
      patch({ budget: s });
      return { ok: true, budget: s };
    }
    if (p.name === "llm_config_get") {
      return { ok: true, config: providerStore.get(), masked: llmView() };
    }
    if (p.name === "llm_config_set") {
      await providerStore.set(p.args || {});
      patch({ llm: llmView() });
      return { ok: true, masked: llmView() };
    }
    if (p.name === "llm_complete") {
      try {
        const out = await llm.complete({
          messages: p.args?.messages || [{ role: "user", content: p.args?.text || "ping" }],
          maxTokens: p.args?.maxTokens || 200,
          temperature: p.args?.temperature ?? 0.3,
          json: !!p.args?.json,
          cls: p.args?.cls || "work",
          kind: p.args?.kind || "debug",
        });
        patch({ llm: llmView() });
        return { ok: true, ...out };
      } catch (err) {
        patch({ llm: llmView() });
        throw err;
      }
    }
    if (p.name === "llm_stats") {
      return { ok: true, masked: llmView() };
    }
    if (p.name === "sched_enqueue") {
      const job = scheduler.enqueue({
        kind: p.args?.kind || "debug",
        priority: p.args?.priority ?? 5,
        payload: p.args?.payload || {},
      });
      return { ok: true, job, stats: scheduler.stats };
    }
    if (p.name === "sched_stats") {
      return { ok: true, stats: scheduler.stats, queue: scheduler.queue };
    }
    if (p.name === "sched_activity") {
      scheduler.setActivity(p.args?.level || "active");
      patch({ sched: scheduler.stats });
      return { ok: true, stats: scheduler.stats };
    }
    if (p.name === "sched_present") {
      scheduler.setPresent(!!p.args?.on);
      patch({ sched: scheduler.stats });
      return { ok: true, stats: scheduler.stats };
    }
    if (p.name === "sched_pause") {
      scheduler.pause();
      patch({ sched: scheduler.stats });
      return { ok: true, stats: scheduler.stats };
    }
    if (p.name === "sched_resume") {
      scheduler.resume();
      patch({ sched: scheduler.stats });
      return { ok: true, stats: scheduler.stats };
    }
    if (p.name === "sched_cancel") {
      const ok = scheduler.cancel(p.args?.id);
      patch({ sched: scheduler.stats });
      return { ok, stats: scheduler.stats };
    }
    if (p.name === "memory_query") {
      return { ok: true, ...(await queryMemory(p.args?.text || "", p.args?.k || 5)) };
    }
    if (p.name === "memory_add") {
      const doc = await localMemory.add(p.args || {});
      patch({ memory: { count: localMemory.count, terms: localMemory.terms } });
      return { ok: true, doc, stats: { count: localMemory.count, terms: localMemory.terms } };
    }
    if (p.name === "memory_search") {
      const hits = localMemory.search(p.args?.text || "", { k: p.args?.k || 5 });
      return { ok: true, hits, semantic: false };
    }
    if (p.name === "memory_clear") {
      await localMemory.clear();
      patch({ memory: { count: 0, terms: 0 } });
      return { ok: true };
    }
    if (p.name === "memory_stats") {
      return { ok: true, count: localMemory.count, terms: localMemory.terms };
    }
    if (p.name === "host_flush") {
      const n = await flushEvents();
      return { ok: true, sent: n, lastSyncedSeq };
    }
    if (p.name === "host_info") {
      return {
        ok: true,
        host: { conn: host.conn, offsetMs: host.offsetMs, lastSeen: host.lastSeen, session: host.sessionId },
        lastSyncedSeq,
      };
    }
    if (p.name === "snapshot_save") {
      const snap = await persistSnapshot("manual");
      return { ok: true, snapshot: { ts: snap.ts, lastSeq: snap.lastSeq } };
    }
    if (p.name === "snapshot_info") {
      return { ok: true, snapshot: { ...snapMeta }, world: world.state, life: life.snapshot() };
    }
    if (p.name === "snapshot_clear") {
      await snapStore.clear();
      snapMeta = { ts: 0, lastSeq: 0, resumed: false };
      patch({ snapshot: { ...snapMeta } });
      return { ok: true };
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
setInterval(() => {
  void persistSnapshot("periodic");
}, 30000);
