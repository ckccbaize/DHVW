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
import { planOuting, pickDestination, dateKey, SPECIAL_DATES, DESTINATIONS } from "./life/outing.js";
import { buildDigest, createDigestStore } from "./digest.js";
import { allowedAt, checkWatchdog, createGovernor } from "./governor.js";
import { createStateLog, createTaskLedger } from "./observe.js";
import { createSyncManager, mergeFacts } from "./sync.js";
import { buildMoodView, createMoodSeries } from "./mood.js";
import { createWakeEngine } from "./wake/engine.js";
import { createBehaviorRegistry } from "./actions/registry.js";
import { pickBehavior } from "./actions/plan.js";
import { createWakeRuntime } from "./wake/runtime.js";
import { createRecordAgent } from "./agent/subs/record.js";
import { createBrowsePlanner, searchBing, validatePublicUrl } from "./actions/browse.js";
import { createDoctor } from "./doctor.js";
import { createMoodPolicy } from "./mood/policy.js";
import { cleanupTombstones, mergeBatch, mergeRecord } from "./sync/merge.js";
import { createMemoryPipeline } from "./memory/pipeline.js";
import { createPlaceGraph, HOME_ID, planTravel } from "./places/graph.js";
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
let governorTimer = null;
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
let outing = { lastAt: 0, day: "", count: 0, plan: null, specialDates: {}, lastCheckAt: 0 };
let agenda = [];
let sceneRequests = [];
let pcActions = [];
let digestStore = null;
let digestTimer = null;
let lastDigestAt = 0;
let governor = null;
let governorLast = null;
let stateLog = null;
let ledger = null;
let heapInfo = null;
let sync = null;
let mergedFactIds = new Set();
let moodSeries = null;
let lastMoodPushAt = 0;
let wake = null;
let behaviors = null;
let behaviorLog = [];
let netLog = [];
let browseUrl = "https://www.weather.com.cn/weather/101010100.shtml";
let wakeRuntime = null;
let recordAgent = null;
let browsePlanner = null;
let doctor = null;
let doctorTimer = null;
let moodPolicy = null;
let memoryPipeline = null;
let pipelineSeen = new Set();
let lastPipelineSeq = 0;
let pipelineLast = null;
let places = null;
let currentPlace = HOME_ID;
let lastHealthAt = Date.now();

const PC_ACTIONS = new Set(["map.generate", "app.open", "media.play", "notify", "web.open"]);

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
host.on("mood:get", () => {
  host.sendRaw({ type: "mood:state", payload: moodView() });
});
host.on("events:ack", (p) => {
  if (!sync) return;
  if (sync.onAck(p)) {
    lastSyncedSeq = sync.ackedSeq;
    scheduleSnapshot();
  }
});
host.setFactsHandler(async (p) => {
  const r = mergeFacts(p.facts || [], { seen: mergedFactIds });
  for (const f of r.accepted) {
    try {
      await localMemory.add(f);
    } catch {
      /* 单条失败不影响其余 */
    }
  }
  const ids = [...mergedFactIds].slice(-500);
  mergedFactIds = new Set(ids);
  await kvBackend.put("pc_fact_ids", ids);
  host.sendRaw({
    type: "facts:ack",
    payload: { accepted: r.accepted.length, merged: r.merged.length, rejected: r.rejected.length },
  });
  patch({ memory: { count: localMemory.count, terms: localMemory.terms } });
  await appendEvent("memory:facts_merged", {
    accepted: r.accepted.length,
    merged: r.merged.length,
    rejected: r.rejected.length,
  });
});
host.on("digest:get", () => {
  void writeDigest();
});
host.on("pc:action:ack", (p) => {
  const item = pcActions.find((a) => a.id === p.id);
  if (!item) return;
  item.status = p.ok ? "acked" : "failed";
  item.result = p.result ?? null;
  item.ackedAt = Date.now();
  void kvBackend.put("pc_actions", pcActions);
  scheduleDigest();
});
host.on("scene:ready", async (p) => {
  const item = sceneRequests.find((s) => s.id === p.id);
  if (!item) return;
  item.status = "ready";
  await kvBackend.put("scene_requests", sceneRequests);
  scheduleDigest();
});

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
      if (ledger && (e.type === "job_done" || e.type === "job_fail")) {
        void ledger.record({
          kind: e.job?.kind || "job",
          ok: e.type === "job_done",
          ms: Math.max(0, (e.job?.finishedAt || 0) - (e.job?.startedAt || 0)),
          error: e.job?.error || null,
        });
      }
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
  const savedOuting = await kvBackend.get("outing_state");
  if (savedOuting && typeof savedOuting === "object") outing = { ...outing, ...savedOuting };
  agenda = (await kvBackend.get("agenda")) || [];
  sceneRequests = (await kvBackend.get("scene_requests")) || [];
  pcActions = (await kvBackend.get("pc_actions")) || [];
  digestStore = createDigestStore({ backend: kvBackend });
  stateLog = createStateLog({ backend: kvBackend });
  await stateLog.init();
  ledger = createTaskLedger({ backend: kvBackend });
  await ledger.init();
  governor = createGovernor({
    getMetrics: () => ({
      heapRatio: heapInfo && Date.now() - heapInfo.ts < 60000 ? heapInfo.ratio : heapRatio(),
      eventCount: eventLog ? eventLog.stats.count : 0,
      queue: scheduler ? scheduler.stats.queued : 0,
    }),
    onTier: (t) => {
      governorLast = t;
      log("info", "governor_tier", { tier: t.tier, reasons: t.reasons });
      void appendEvent("governor:tier", { tier: t.tier, reasons: t.reasons, metrics: t.metrics });
      scheduler.setSafeMode(t.tier === "P2");
      patch({ governor: { tier: t.tier, reasons: t.reasons, metrics: t.metrics } });
    },
  });
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
  sync = createSyncManager({
    eventLog,
    send: (m) => host.sendRaw(m),
    backend: kvBackend,
  });
  lastSyncedSeq = await sync.init();
  mergedFactIds = new Set((await kvBackend.get("pc_fact_ids")) || []);
  moodSeries = createMoodSeries({ backend: kvBackend });
  await moodSeries.init();
  wake = createWakeEngine();
  wake.restore((await kvBackend.get("wake_state")) || {});
  wakeRuntime = createWakeRuntime({
    llm,
    registry: agentRegistry,
    store: kvBackend,
    lock: globalThis.navigator?.locks || null,
  });
  await wakeRuntime.init();
  recordAgent = createRecordAgent({ llm, registry: agentRegistry });
  browsePlanner = createBrowsePlanner({ llm, registry: agentRegistry });
  moodPolicy = createMoodPolicy();
  pipelineSeen = new Set((await kvBackend.get("memory_seen")) || []);
  lastPipelineSeq = (await kvBackend.get("pipeline_state"))?.lastSeq || 0;
  memoryPipeline = createMemoryPipeline({
    llm,
    registry: agentRegistry,
    localMemory,
    seen: pipelineSeen,
    sendCandidates: (payload) => host.sendRaw({ type: "facts:candidates", payload }),
  });
  doctor = createDoctor({
    llm,
    registry: agentRegistry,
    getSnapshot: () => ({
      governor: governorLast ? { tier: governorLast.tier } : { tier: governor?.tier },
      sched: scheduler.stats,
      log: { ...eventLog.stats },
      sync: sync ? sync.stats : null,
      budget: budget ? budget.stats() : null,
      memory: { count: localMemory.count },
      wake: wake ? wake.state : null,
      llm: llmView(),
      wakeRuntime: { events: wakeRuntime ? wakeRuntime.state.events.length : 0 },
      logs,
    }),
    applyAction: (type, args) => doctorApply(type, args),
  });
  places = createPlaceGraph({
    places: [
      ...DESTINATIONS.map((d) => ({ id: d.id, name: d.name, kind: d.kind, distance: d.distance })),
      ...((await kvBackend.get("places")) || []),
    ],
  });
  currentPlace = (await kvBackend.get("current_place")) || HOME_ID;
  behaviors = createBehaviorRegistry({ custom: (await kvBackend.get("behavior_pool")) || [] });
  behaviorLog = (await kvBackend.get("behavior_log")) || [];
  netLog = (await kvBackend.get("net_log")) || [];
  const bcfg = await kvBackend.get("behavior_config");
  if (bcfg?.browseUrl) browseUrl = bcfg.browseUrl;
  await localMemory.init();
  await scheduler.init();
  if (Date.now() - eventPool.updatedAt > 6 * 3600 * 1000) {
    scheduler.enqueue({ kind: "event_pool", priority: 6 });
  }
  setTimeout(() => {
    void doctor.check().then((r) => {
      if (r.issues?.length) log("warn", "doctor", { issues: r.issues, diagnosis: r.diagnosis });
      patch({ doctor: { status: r.issues?.length ? "issues" : "ok", lastCheck: Date.now(), issues: r.issues, diagnosis: r.diagnosis } });
    });
  }, 30_000);
  scheduler.register("memory", async () => {
    await runMemoryPipeline();
  });
  setInterval(() => {
    if (scheduler.queue.some((j) => j.kind === "memory")) return;
    if (eventLog.lastSeq - lastPipelineSeq < 20) return;
    scheduler.enqueue({ kind: "memory", priority: 4 });
  }, 30 * 60_000);
  doctorTimer = setInterval(() => {
    void doctor.check().then((r) => {
      if (r.issues?.length) log("warn", "doctor", { issues: r.issues, diagnosis: r.diagnosis });
      patch({ doctor: { status: r.issues?.length ? "issues" : "ok", lastCheck: Date.now(), issues: r.issues, diagnosis: r.diagnosis } });
    });
  }, 5 * 60_000);
  setInterval(() => {
    if (Date.now() - eventPool.updatedAt < 6 * 3600 * 1000) return;
    if (scheduler.queue.some((j) => j.kind === "event_pool")) return;
    scheduler.enqueue({ kind: "event_pool", priority: 6 });
  }, 30 * 60 * 1000);
  logStats = eventLog.stats;
})();

function heapRatio() {
  const m = globalThis.performance?.memory;
  return m && m.jsHeapSizeLimit ? m.usedJSHeapSize / m.jsHeapSizeLimit : 0;
}

function degraded(kind) {
  if (!governor) return null;
  if (allowedAt(governor.tier, kind)) return null;
  return { ok: false, reason: `degraded:${governor.tier}` };
}

function applyGuidedMood({ source = "system", reason = "", deltas = null, setpoint = null, ttlMs = 0 } = {}) {
  const r = moodPolicy.apply({ source, reason, deltas, setpoint, ttlMs });
  if (!r.ok) {
    log("debug", "mood_rejected", { source, reason: r.reason });
    return r;
  }
  if (r.mode === "setpoint") life.setMood(setpoint, { source, reason });
  else life.applyMood(deltas || {}, { source, reason });
  patch({ life: life.snapshot() });
  void sampleMood(source, reason);
  return r;
}

async function runMemoryPipeline() {
  const events = await eventLog.since(lastPipelineSeq, 200);
  if (events.length < 3) return { ok: false, reason: "not_enough_events", count: events.length };
  const r = await memoryPipeline.run(events);
  if (r.ok) {
    lastPipelineSeq = events[events.length - 1].seq;
    await kvBackend.put("pipeline_state", { lastSeq: lastPipelineSeq, at: Date.now() });
    await kvBackend.put("memory_seen", [...pipelineSeen].slice(-500));
    pipelineLast = { at: Date.now(), facts: r.facts.length, scanned: r.scanned };
    await appendEvent("memory:pipeline", { facts: r.facts.length, scanned: r.scanned });
    patch({ memory: { count: localMemory.count, terms: localMemory.terms }, memoryPipeline: pipelineLast });
  }
  return r;
}

async function doctorApply(type, args = {}) {
  switch (type) {
    case "clear_event_log":
      await eventLog.clear();
      logStats = eventLog.stats;
      break;
    case "trim_memory":
      await localMemory.clear();
      patch({ memory: { count: localMemory.count, terms: localMemory.terms } });
      break;
    case "pause_agent":
      scheduler.pause();
      break;
    case "resume_agent":
      scheduler.resume();
      break;
    case "reset_budget":
      await budget.reset();
      break;
    case "enter_safe_mode":
      scheduler.setSafeMode(true);
      applyGuidedMood({ source: "doctor", reason: "安全模式", setpoint: { social: 0.15 }, ttlMs: 30 * 60_000 });
      patch({ doctor: { status: "safe_mode", lastCheck: Date.now() } });
      break;
    case "exit_safe_mode":
      scheduler.setSafeMode(false);
      moodPolicy.reset();
      patch({ doctor: { status: "ok", lastCheck: Date.now() } });
      break;
    case "snapshot_save":
      await persistSnapshot("doctor");
      break;
    default:
      throw new Error(`未知动作 ${type}`);
  }
  await appendEvent("doctor:action", { action: type, args });
}

function pushAgenda(entry) {
  agenda.unshift(entry);
  agenda = agenda.slice(0, 50);
  void kvBackend.put("agenda", agenda);
  scheduleDigest();
}

function enqueuePcAction(action, args = {}) {
  if (!PC_ACTIONS.has(action)) return { ok: false, reason: "bad_action" };
  const entry = {
    id: `pc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    action,
    args: args && typeof args === "object" ? args : {},
    status: "queued",
    createdAt: Date.now(),
  };
  pcActions.unshift(entry);
  pcActions = pcActions.slice(0, 50);
  if (host.conn === "up" && host.sendRaw({ type: "pc:action", payload: { id: entry.id, action: entry.action, args: entry.args } })) {
    entry.status = "sent";
  }
  void kvBackend.put("pc_actions", pcActions);
  scheduleDigest();
  return { ok: true, action: entry };
}

function scheduleDigest() {
  clearTimeout(digestTimer);
  digestTimer = setTimeout(() => void writeDigest(), 800);
}

async function writeDigest() {
  if (!digestStore) return null;
  const snap = life.snapshot();
  const d = buildDigest({
    now: Date.now(),
    seq: eventLog ? eventLog.lastSeq : 0,
    clock: {
      day: new Date().toISOString().slice(0, 10),
      minute: snap.minute,
      phase: snap.phase,
    },
    world: { display: state.display, conn: host.conn, tier: world.state.tier },
    life: snap,
    agenda,
    sceneRequests,
    pcActions,
    recentEvents: eventLog ? await eventLog.latest(20) : [],
    budget: budget ? budget.stats() : null,
    eventPool: { total: eventPool.events.length, updatedAt: eventPool.updatedAt },
    outing: outingView(),
    digest: { ts: lastDigestAt, agenda: agenda.length, scenes: sceneRequests.length, pcActions: pcActions.length },
    governor: governorLast
      ? { tier: governorLast.tier, reasons: governorLast.reasons, metrics: governorLast.metrics }
      : { tier: governor ? governor.tier : "P4", reasons: [], metrics: null },
    mood: moodSeries ? { ...moodSeries.stats(), band: life.snapshot().band, dims: life.snapshot().mood } : null,
    moodPolicy: moodPolicy ? moodPolicy.stats() : null,
    memoryPipeline: { lastSeq: lastPipelineSeq, seen: pipelineSeen.size, last: pipelineLast },
    wake: wake ? wake.state : null,
    behaviors: behaviors ? { count: behaviors.list().length, custom: behaviors.custom().length, recent: behaviorLog.slice(0, 5) } : null,
    places: { current: currentPlace, count: places ? places.list().length : 0 },
    places: { current: currentPlace, count: places ? places.list().length : 0 },
    wakeRuntime: wakeRuntime
      ? {
          events: wakeRuntime.state.events.length,
          threads: wakeRuntime.state.threads.filter((t) => !t.closedAt).length,
          residue: wakeRuntime.residue()?.text || null,
          nextWakeAt: wakeRuntime.state.nextWakeAt,
        }
      : null,
    observe: {
      stateLog: stateLog ? stateLog.stats() : null,
      ledger: ledger ? ledger.stats() : null,
      heap: heapInfo,
    },
    lastPlot: await kvBackend.get("last_plot"),
    mood: moodView(60),
    wake: wake ? wake.state : null,
    places: { current: currentPlace, count: places ? places.list().length : 0 },
    behaviors: behaviorLog.slice(0, 10),
    net: netLog.slice(0, 5),
    places: { current: currentPlace, count: places ? places.list().length : 0 },
    wakeRuntime: wakeRuntime
      ? {
          events: wakeRuntime.state.events.length,
          threads: wakeRuntime.state.threads.filter((t) => !t.closedAt).length,
          residue: wakeRuntime.residue()?.text || null,
          nextWakeAt: wakeRuntime.state.nextWakeAt,
        }
      : null,
  });
  await digestStore.save(d);
  if (host.conn === "up") host.sendRaw({ type: "world:digest", payload: { digest: d } });
  lastDigestAt = Date.now();
  patch({
    digest: {
      ts: d.ts,
      agenda: agenda.length,
      scenes: sceneRequests.length,
      pcActions: pcActions.length,
    },
  });
  return d;
}

async function fetchPage(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(`/__fetch?url=${encodeURIComponent(url)}`, { cache: "no-store" });
    if (!res.ok) return { ok: false, reason: `fetch_http_${res.status}`, ms: Date.now() - t0 };
    const data = await res.json();
    return { ok: true, data, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, reason: err.message, ms: Date.now() - t0 };
  }
}

const BOT_MARKERS = /安全校验|验证码|访问异常|人机验证|Just a moment/i;

async function browseBehavior() {
  const t0 = Date.now();
  let plan = { ok: false };
  if (browsePlanner) {
    plan = await browsePlanner.plan({
      threads: wakeRuntime ? wakeRuntime.threads().filter((t) => !t.closedAt).map((t) => t.text) : [],
      recent: netLog,
      mood: life.snapshot().mood,
    });
  }

  const candidates = [];
  if (plan.ok && plan.mode === "search") {
    const sr = await searchBing(plan.query);
    for (const hit of sr.results.slice(0, 3)) {
      if (validatePublicUrl(hit.url) !== null) continue;
      candidates.push({ url: hit.url, topic: plan.query, reason: plan.reason, query: plan.query, resultTitle: hit.title, searchCount: sr.results.length });
    }
  } else if (plan.ok) {
    candidates.push({ url: plan.url, topic: plan.topic || "", reason: plan.reason || "", query: "", resultTitle: "", searchCount: 0 });
  }
  if (!candidates.length) candidates.push({ url: browseUrl, topic: "", reason: "", query: "", resultTitle: "", searchCount: 0 });

  const attempts = [];
  for (const c of candidates) {
    const r = await fetchPage(c.url);
    if (!r.ok) {
      attempts.push({ url: c.url, reason: r.reason });
      continue;
    }
    const excerpt = String(r.data.text || "");
    if (excerpt.length < 80 || BOT_MARKERS.test(excerpt)) {
      attempts.push({ url: c.url, reason: excerpt.length < 80 ? "too_short" : "bot_check" });
      continue;
    }
    netLog.unshift({
      url: c.url,
      ts: Date.now(),
      bytes: r.data.bytes || 0,
      excerpt: excerpt.slice(0, 600),
      topic: c.topic,
      reason: c.reason,
      planned: plan.ok,
      query: c.query,
      resultTitle: c.resultTitle,
      searchCount: c.searchCount,
      attempts: attempts.length,
    });
    netLog = netLog.slice(0, 50);
    await kvBackend.put("net_log", netLog);
    await appendEvent("behavior:browse", {
      url: c.url,
      bytes: r.data.bytes || 0,
      excerpt: excerpt.slice(0, 200),
      topic: c.topic,
      reason: c.reason,
      planned: plan.ok,
      query: c.query,
      resultTitle: c.resultTitle,
      attempts: attempts.length,
    });
    if (ledger) void ledger.record({ kind: "browse", ok: true, ms: Date.now() - t0, meta: { url: c.url, planned: plan.ok } });
    return {
      ok: true,
      kind: "network",
      url: c.url,
      excerpt,
      plan: plan.ok ? { mode: plan.mode, topic: c.topic, query: c.query, reason: c.reason } : null,
      search: c.searchCount ? { count: c.searchCount, title: c.resultTitle } : null,
      attempts,
    };
  }
  if (ledger) void ledger.record({ kind: "browse", ok: false, ms: Date.now() - t0, error: "no_usable_page" });
  return { ok: false, reason: "no_usable_page", attempts };
}

async function runBehavior(behavior, { reason = "wake" } = {}) {
  const at = Date.now();
  const before = life.snapshot().mood;
  let result;
  if (behavior.kind === "travel") {
    const r = await maybeOuting({ force: true });
    result = { ok: !!r.ok, kind: "outing", detail: r.destination || null };
  } else if (behavior.kind === "network") {
    result = await browseBehavior();
  } else {
    applyGuidedMood({ source: "plot", reason: behavior.name, deltas: behavior.effects || {} });
    await appendEvent("behavior:done", { id: behavior.id, name: behavior.name, kind: behavior.kind });
    result = { ok: true, kind: behavior.kind };
  }
  const after = life.snapshot().mood;
  let record = null;
  if (recordAgent) {
    const rec = await recordAgent.run({
      behavior,
      before,
      after,
      place: behavior.kind === "travel" ? "外面" : "家里",
      detail: result.detail?.name || result.url || "",
    });
    record = rec.ok
      ? { summary: rec.summary, mood: rec.mood, evidence: rec.evidence, ts: rec.ts }
      : { error: rec.reason };
    if (rec.ok) {
      await appendEvent("behavior:recorded", {
        id: behavior.id,
        summary: rec.summary,
        mood: rec.mood,
        evidence: rec.evidence,
      });
    }
  }
  behaviorLog.unshift({
    id: behavior.id,
    name: behavior.name,
    kind: behavior.kind,
    at,
    ok: result.ok,
    reason,
    mood: { before, after },
    record,
  });
  behaviorLog = behaviorLog.slice(0, 50);
  await kvBackend.put("behavior_log", behaviorLog);
  patch({ behaviors: { count: behaviors.list().length, custom: behaviors.custom().length, recent: behaviorLog.slice(0, 5) } });
  pushAgenda({
    id: `behavior-${at.toString(36)}`,
    kind: "behavior",
    at,
    status: result.ok ? "done" : "failed",
    payload: { id: behavior.id, name: behavior.name, kind: behavior.kind, result },
  });
  scheduleDigest();
  return result;
}

function moodView(limit = 120) {
  const snap = life.snapshot();
  return buildMoodView({
    now: Date.now(),
    minute: snap.minute,
    mood: snap.mood,
    band: snap.band,
    series: moodSeries ? moodSeries.history({ limit: 480 }) : [],
    moodLog: snap.moodLog || [],
    limit,
  });
}

async function sampleMood(source, reason = "") {
  if (!moodSeries) return;
  const snap = life.snapshot();
  await moodSeries.sample({ minute: snap.minute, mood: snap.mood, band: snap.band, source, reason });
  maybePushMood();
}

function maybePushMood(force = false) {
  if (!moodSeries) return;
  const now = Date.now();
  if (!force && now - lastMoodPushAt < 5000) return;
  lastMoodPushAt = now;
  const view = moodView();
  if (host.conn === "up") host.sendRaw({ type: "mood:state", payload: view });
  patch({ moodView: { band: view.band, dims: view.dims, ts: view.ts } });
}

function outingView() {
  return {
    lastAt: outing.lastAt,
    count: outing.count,
    plan: outing.plan,
    specialDates: outing.specialDates,
  };
}

async function maybeOuting({ force = false } = {}) {
  if (!force && scheduler.stats.present) return { ok: false, reason: "present" };
  const now = Date.now();
  if (!force && now - outing.lastCheckAt < 60_000) return { ok: false, reason: "throttled" };
  outing.lastCheckAt = now;
  const day = dateKey(now);
  if (outing.day !== day) {
    outing.day = day;
    outing.count = 0;
  }
  const snap = life.snapshot();
  const r = planOuting({
    now,
    mood: snap.mood,
    lastOutingAt: outing.lastAt,
    outingsToday: outing.count,
    sameActCount: snap.recent.length,
    specialDates: outing.specialDates,
  });
  if (!r.go && !force) {
    patch({ outing: outingView() });
    return { ok: true, ...r };
  }
  const destination = r.destination || pickDestination({ mood: snap.mood, special: r.special });
  outing.lastAt = now;
  outing.count += 1;
  outing.plan = {
    ts: now,
    reason: r.reason,
    special: r.special,
    destination,
    moodDelta: destination.mood,
    mapSpec: {
      kind: destination.kind,
      name: destination.name,
      distance: destination.distance,
      seed: `${day}-${outing.count}`,
    },
  };
  applyGuidedMood({ source: "plot", reason: `出门:${destination.name}`, deltas: destination.mood });
  patch({ life: life.snapshot(), outing: outingView() });
  scheduleSnapshot();
  await kvBackend.put("outing_state", outing);
  await appendEvent("outing:intent", outing.plan);
  pushAgenda({
    id: `outing-${now.toString(36)}`,
    kind: "outing",
    at: now,
    status: "planned",
    payload: { destination, mapSpec: outing.plan.mapSpec, reason: outing.plan.reason },
  });
  sceneRequests.unshift({
    id: `scene-${now.toString(36)}`,
    reason: "outing",
    mapSpec: outing.plan.mapSpec,
    status: "pending",
    createdAt: now,
  });
  sceneRequests = sceneRequests.slice(0, 20);
  void kvBackend.put("scene_requests", sceneRequests);
  scheduleDigest();
  return { ok: true, ...r, go: true, destination };
}

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
  if (!remote || remote.conn !== "up" || !sync) return 0;
  return sync.flush();
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
    sync: sync ? sync.stats : null,
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
    outing: outingView(),
    digest: { ts: lastDigestAt, agenda: agenda.length, scenes: sceneRequests.length, pcActions: pcActions.length },
    governor: governorLast
      ? { tier: governorLast.tier, reasons: governorLast.reasons, metrics: governorLast.metrics }
      : { tier: governor ? governor.tier : "P4", reasons: [], metrics: null },
    mood: moodSeries ? { ...moodSeries.stats(), band: life.snapshot().band, dims: life.snapshot().mood } : null,
    moodPolicy: moodPolicy ? moodPolicy.stats() : null,
    memoryPipeline: { lastSeq: lastPipelineSeq, seen: pipelineSeen.size, last: pipelineLast },
    wake: wake ? wake.state : null,
    behaviors: behaviors ? { count: behaviors.list().length, custom: behaviors.custom().length, recent: behaviorLog.slice(0, 5) } : null,
    places: { current: currentPlace, count: places ? places.list().length : 0 },
    places: { current: currentPlace, count: places ? places.list().length : 0 },
    wakeRuntime: wakeRuntime
      ? {
          events: wakeRuntime.state.events.length,
          threads: wakeRuntime.state.threads.filter((t) => !t.closedAt).length,
          residue: wakeRuntime.residue()?.text || null,
          nextWakeAt: wakeRuntime.state.nextWakeAt,
        }
      : null,
    observe: {
      stateLog: stateLog ? stateLog.stats() : null,
      ledger: ledger ? ledger.stats() : null,
      heap: heapInfo,
    },
    life: life.snapshot(),
    log: { ...logStats },
    doctor: state.doctor,
    logs: logs.length,
  };
}

function startHeartbeat() {
  clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    lastHealthAt = Date.now();
    post("core:health", health());
  }, 5000);
  clearInterval(governorTimer);
  governorTimer = setInterval(() => {
    if (governor) governorLast = governor.check();
    const w = checkWatchdog({ lastBeatAt: lastHealthAt, now: Date.now(), timeoutMs: 30000 });
    if (w.stale) {
      log("warn", "watchdog_stall", w);
      lastHealthAt = Date.now();
    }
  }, 30000);
}

function dispatchWorld(event) {
  if (!WORLD_EVENTS.has(event.type)) {
    throw Object.assign(new Error(`未知世界事件: ${event.type}`), { code: "bad_payload" });
  }
  const before = world.state.display;
  const res = world.dispatch(event);
  if (stateLog && (before !== res.state.display || res.illegal)) {
    void stateLog.append({ kind: "world", from: before, to: res.state.display, meta: { event: event.type, illegal: res.illegal } });
  }
  patch(syncWorld());
  if (scheduler) scheduler.setPresent(world.state.display === "present");
  if (event.type === "PRESENT_REQUEST" && !res.illegal) {
    wake?.suspend();
    host.presentBegin();
  }
  if (event.type === "PRESENT_EXIT" && !res.illegal) {
    wake?.resume();
    host.presentEnd();
  }
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
        if (next === "up") {
          if (sync) sync.onReconnect();
          void flushEvents();
        }
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
    if (next === "up") {
      for (const a of pcActions) {
        if (a.status !== "queued") continue;
        if (host.sendRaw({ type: "pc:action", payload: { id: a.id, action: a.action, args: a.args } })) {
          a.status = "sent";
        }
      }
      if (kvBackend) void kvBackend.put("pc_actions", pcActions);
      void writeDigest();
    }
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
      const before = life.snapshot();
      life.advance(p.args?.minutes ?? 60);
      const after = life.snapshot();
      if (stateLog && (before.phase !== after.phase || before.band !== after.band)) {
        void stateLog.append({
          kind: "life",
          from: `${before.phase}/${before.band}`,
          to: `${after.phase}/${after.band}`,
          meta: { minute: after.minute },
        });
      }
      patch({ life: after });
      void sampleMood("tick", "life_advance");
      scheduleSnapshot();
      void maybeOuting();
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
      const blocked = degraded("plot");
      if (blocked) return blocked;
      const t0 = Date.now();
      const r = await manager.run(p.args?.intent, p.args?.ctx || {});
      if (ledger) {
        void ledger.record({ kind: "agent_run", ok: r.ok, ms: Date.now() - t0, error: r.reason || null, meta: { tasks: r.tasks?.length || 0 } });
      }
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
        applyGuidedMood({ source: "plot", reason: r.event, deltas: r.mood });
        scheduleSnapshot();
        await kvBackend.put("plot_recent", [r.text, ...recent].slice(0, 20));
        await kvBackend.put("plot_events", [r.event, ...recentEvents].slice(0, 10));
        await kvBackend.put("last_plot", {
          text: r.text,
          event: r.event,
          place: r.place,
          imageQuery: r.imageQuery,
          ts: Date.now(),
        });
        await appendEvent("plot:generated", {
          text: r.text,
          event: r.event,
          place: r.place,
          imageQuery: r.imageQuery,
          mood: r.mood,
          attempts: r.attempts,
        });
        pushAgenda({
          id: `plot-${Date.now().toString(36)}`,
          kind: "plot",
          at: Date.now(),
          status: "done",
          payload: {
            text: r.text,
            event: r.event,
            place: r.place,
            imageQuery: r.imageQuery,
            mood: r.mood,
          },
        });
        if (r.pcAction?.action) enqueuePcAction(r.pcAction.action, r.pcAction.args);
      }
      return { ...r, life: life.snapshot() };
    }
    if (p.name === "memory_pipeline") {
      const r = await runMemoryPipeline();
      return { ok: r.ok, ...r, lastSeq: lastPipelineSeq };
    }
    if (p.name === "memory_pipeline_state") {
      return { ok: true, lastSeq: lastPipelineSeq, seen: pipelineSeen.size, last: pipelineLast };
    }
    if (p.name === "merge_record") {
      return mergeRecord(p.args?.local || null, p.args?.incoming || null, { ownership: p.args?.ownership });
    }
    if (p.name === "merge_batch") {
      const map = new Map(Object.entries(p.args?.local || {}));
      const out = mergeBatch(map, p.args?.incoming || [], { ownership: p.args?.ownership });
      return { ok: true, results: out, local: Object.fromEntries(map) };
    }
    if (p.name === "merge_cleanup") {
      return { ok: true, records: cleanupTombstones(p.args?.records || [], { now: Date.now(), ttlMs: p.args?.ttlMs }) };
    }
    if (p.name === "mood_apply") {
      const r = applyGuidedMood({
        source: p.args?.source || "user",
        reason: p.args?.reason || "手动引导",
        deltas: p.args?.deltas || null,
        setpoint: p.args?.setpoint || null,
        ttlMs: p.args?.ttlMs || 0,
      });
      return { ok: r.ok, ...r, life: life.snapshot() };
    }
    if (p.name === "mood_policy") {
      return { ok: true, stats: moodPolicy.stats(), log: moodPolicy.log() };
    }
    if (p.name === "mood_policy_reset") {
      moodPolicy.reset();
      return { ok: true };
    }
    if (p.name === "doctor_check") {
      const r = await doctor.check();
      patch({ doctor: { status: r.issues.length ? "issues" : "ok", lastCheck: Date.now(), issues: r.issues, diagnosis: r.diagnosis } });
      return { ok: true, ...r, state: doctor.state };
    }
    if (p.name === "doctor_state") {
      return { ok: true, state: doctor.state };
    }
    if (p.name === "doctor_safe_mode") {
      await doctorApply(p.args?.on ? "enter_safe_mode" : "exit_safe_mode", {});
      doctor.setSafeMode(!!p.args?.on);
      return { ok: true, safeMode: !!p.args?.on };
    }
    if (p.name === "heap_report") {
      const used = Number(p.args?.used) || 0;
      const limit = Number(p.args?.limit) || 0;
      heapInfo = { used, limit, ratio: limit > 0 ? used / limit : 0, ts: Date.now() };
      patch({ observe: { stateLog: stateLog.stats(), ledger: ledger.stats(), heap: heapInfo } });
      return { ok: true, heap: heapInfo };
    }
    if (p.name === "observe_state") {
      return { ok: true, stats: stateLog.stats(), events: stateLog.since(p.args?.since || 0) };
    }
    if (p.name === "observe_tasks") {
      return { ok: true, stats: ledger.stats(), tasks: ledger.latest(p.args?.n || 20) };
    }
    if (p.name === "observe_health") {
      patch({ observe: { stateLog: stateLog.stats(), ledger: ledger.stats(), heap: heapInfo } });
      return {
        ok: true,
        health: {
          world: { ...world.state },
          life: life.snapshot(),
          log: eventLog.stats,
          sched: scheduler.stats,
          budget: budget ? budget.stats() : null,
          governor: governorLast,
          stateLog: stateLog.stats(),
          ledger: ledger.stats(),
          heap: heapInfo,
        },
      };
    }
    if (p.name === "observe_clear") {
      await stateLog.clear();
      await ledger.clear();
      return { ok: true, stateLog: stateLog.stats(), ledger: ledger.stats() };
    }
    if (p.name === "behavior_list") {
      patch({ behaviors: { count: behaviors.list().length, custom: behaviors.custom().length, recent: behaviorLog.slice(0, 5) } });
      return { ok: true, behaviors: behaviors.list(), recent: behaviorLog.slice(0, 10) };
    }
    if (p.name === "behavior_register") {
      const r = behaviors.register(p.args?.behavior || {});
      if (r.ok) {
        await kvBackend.put("behavior_pool", behaviors.custom());
        scheduleDigest();
      }
      return r;
    }
    if (p.name === "behavior_remove") {
      const ok = behaviors.remove(p.args?.id);
      if (ok) await kvBackend.put("behavior_pool", behaviors.custom());
      return { ok };
    }
    if (p.name === "behavior_run") {
      const b = behaviors.get(p.args?.id);
      if (!b) return { ok: false, reason: "not_found" };
      return { ok: true, behavior: b.id, result: await runBehavior(b, { reason: "manual" }) };
    }
    if (p.name === "behavior_config") {
      if (p.args?.browseUrl) browseUrl = String(p.args.browseUrl);
      await kvBackend.put("behavior_config", { browseUrl });
      return { ok: true, browseUrl };
    }
    if (p.name === "browse_plan") {
      const r = await browsePlanner.plan({
        threads: wakeRuntime ? wakeRuntime.threads().filter((t) => !t.closedAt).map((t) => t.text) : [],
        recent: netLog,
        mood: life.snapshot().mood,
      });
      return r;
    }
    if (p.name === "net_log") {
      return { ok: true, log: netLog };
    }
    if (p.name === "place_list") {
      return { ok: true, current: currentPlace, places: places.list() };
    }
    if (p.name === "place_add") {
      const r = places.add(p.args?.place || {});
      if (r.ok) {
        await kvBackend.put("places", places.custom());
        await appendEvent("scene:added", { id: r.place.id, name: r.place.name, kind: r.place.kind });
        patch({ places: { current: currentPlace, count: places.list().length } });
        scheduleDigest();
      }
      return r;
    }
    if (p.name === "place_remove") {
      const id = p.args?.id;
      const existed = places.get(id);
      const removed = places.remove(id);
      if (removed) {
        if (currentPlace === id) {
          currentPlace = HOME_ID;
          await kvBackend.put("current_place", currentPlace);
          await appendEvent("travel:return_home", { from: id, reason: "scene_removed" });
        }
        await kvBackend.put("places", places.custom());
        await appendEvent("scene:removed", { id, name: existed?.name || id });
        patch({ places: { current: currentPlace, count: places.list().length } });
        scheduleDigest();
      }
      return { ok: removed, current: currentPlace };
    }
    if (p.name === "travel_plan") {
      return planTravel({ graph: places, from: p.args?.from || currentPlace, to: p.args?.to, minute: life.snapshot().minute });
    }
    if (p.name === "travel_go") {
      const to = p.args?.to;
      const plan = planTravel({ graph: places, from: currentPlace, to, minute: life.snapshot().minute });
      if (!plan.ok) return plan;
      if (plan.minutes === 0) return { ok: true, plan, currentPlace };
      const dest = places.get(to);
      life.advance(plan.minutes);
      patch({ life: life.snapshot() });
      void sampleMood("plot", `去${dest?.name || to}`);
      currentPlace = to;
      await kvBackend.put("current_place", currentPlace);
      await appendEvent("travel:depart", { from: plan.from, to, minutes: plan.minutes });
      await appendEvent("travel:arrive", {
        to,
        minute: life.snapshot().minute,
        crossesNight: plan.crossesNight,
      });
      if (plan.crossesNight) {
        await appendEvent("travel:cross_night", { from: plan.from, to, minutes: plan.minutes });
      }
      if (dest && to !== HOME_ID) {
        sceneRequests.unshift({
          id: `scene-travel-${Date.now().toString(36)}`,
          reason: "travel",
          mapSpec: { kind: dest.kind, name: dest.name, distance: dest.distance, seed: `${to}-${Date.now().toString(36)}` },
          status: "pending",
          createdAt: Date.now(),
        });
        sceneRequests = sceneRequests.slice(0, 20);
        await kvBackend.put("scene_requests", sceneRequests);
      }
      patch({ places: { current: currentPlace, count: places.list().length } });
      scheduleDigest();
      return { ok: true, plan, currentPlace, life: life.snapshot() };
    }
    if (p.name === "place_current") {
      return { ok: true, current: currentPlace, place: places.get(currentPlace) };
    }
    if (p.name === "wake_run") {
      const r = await wakeRuntime.run({ context: p.args?.context || {}, toolEvidence: p.args?.toolEvidence || null });
      if (r.ok) {
        const w = r.wake;
        if (w.outcome === "message" && w.share) post("core:bubble", { text: w.share, ttl: 5000 });
        await appendEvent(`wake:${w.outcome}`, {
          fact: w.fact,
          content: w.content,
          share: w.share,
          residue: w.residue,
          next_wake: r.nextWake,
          seed: r.seed,
        });
        patch({ wakeRuntime: { events: wakeRuntime.state.events.length, threads: r.threadCount, residue: wakeRuntime.residue()?.text || null, nextWakeAt: wakeRuntime.state.nextWakeAt } });
        scheduleDigest();
      }
      return r;
    }
    if (p.name === "wake_event_add") {
      return wakeRuntime.addEvent(p.args || {});
    }
    if (p.name === "wake_events") {
      return { ok: true, events: wakeRuntime.listEvents() };
    }
    if (p.name === "wake_threads") {
      return { ok: true, threads: wakeRuntime.threads() };
    }
    if (p.name === "wake_thread_close") {
      return { ok: await wakeRuntime.closeThread(p.args?.id) };
    }
    if (p.name === "wake_runtime_state") {
      return { ok: true, state: wakeRuntime.state, residue: wakeRuntime.residue() };
    }
    if (p.name === "wake_runtime_clear") {
      await wakeRuntime.clear();
      return { ok: true };
    }
    if (p.name === "wake_tick") {
      const snap = life.snapshot();
      const r = await wake.tick({
        mood: snap.mood,
        present: p.args?.present ?? world.state.display === "present",
        text: p.args?.text || "",
      });
      if (r.kind === "bubble" && r.text) post("core:bubble", { text: r.text, ttl: 4000 });
      let behavior = null;
      if (r.kind !== "silent" && p.args?.behavior !== false) {
        const picked = pickBehavior({
          registry: behaviors,
          now: Date.now(),
          mood: snap.mood,
          recent: behaviorLog,
          network: true,
        });
        if (picked) behavior = { picked: picked.behavior.id, result: await runBehavior(picked.behavior, { reason: "wake" }) };
      }
      await kvBackend.put("wake_state", wake.snapshot());
      await appendEvent(`wake:${r.kind}`, { source: r.source, reason: r.reason, text: r.text });
      patch({ wake: wake.state });
      return { ok: true, ...r, behavior, state: wake.state };
    }
    if (p.name === "wake_interaction") {
      wake.recordInteraction();
      await kvBackend.put("wake_state", wake.snapshot());
      patch({ wake: wake.state });
      return { ok: true, state: wake.state };
    }
    if (p.name === "wake_response") {
      wake.recordResponse(!!p.args?.responded);
      await kvBackend.put("wake_state", wake.snapshot());
      patch({ wake: wake.state });
      return { ok: true, state: wake.state };
    }
    if (p.name === "wake_reset") {
      wake.restore({});
      await kvBackend.put("wake_state", wake.snapshot());
      patch({ wake: wake.state });
      return { ok: true, state: wake.state };
    }
    if (p.name === "wake_state") {
      return { ok: true, state: wake.state, latest: wake.latest(10) };
    }
    if (p.name === "mood_state") {
      return { ok: true, mood: moodView(p.args?.limit || 120) };
    }
    if (p.name === "mood_history") {
      return { ok: true, series: moodSeries.history({ since: p.args?.since || 0, limit: p.args?.limit || 240 }) };
    }
    if (p.name === "mood_clear") {
      const st = await moodSeries.clear();
      return { ok: true, stats: st };
    }
    if (p.name === "governor_check") {
      const r = governor.check();
      governorLast = r;
      patch({ governor: { tier: r.tier, reasons: r.reasons, metrics: r.metrics } });
      return { ok: true, ...r };
    }
    if (p.name === "governor_reset") {
      governor.reset();
      scheduler.setSafeMode(false);
      governorLast = null;
      return { ok: true, tier: governor.tier };
    }
    if (p.name === "digest_get") {
      return { ok: true, digest: await writeDigest() };
    }
    if (p.name === "digest_write") {
      return { ok: true, digest: await writeDigest() };
    }
    if (p.name === "pc_action") {
      return enqueuePcAction(p.args?.action, p.args?.args);
    }
    if (p.name === "pc_actions") {
      return { ok: true, actions: pcActions };
    }
    if (p.name === "agenda_list") {
      return { ok: true, agenda, scenes: sceneRequests };
    }
    if (p.name === "scene_ready") {
      const item = sceneRequests.find((s) => s.id === p.args?.id);
      if (!item) return { ok: false, reason: "not_found" };
      item.status = "ready";
      await kvBackend.put("scene_requests", sceneRequests);
      scheduleDigest();
      return { ok: true, scene: item };
    }
    if (p.name === "outing_check") {
      return await maybeOuting();
    }
    if (p.name === "outing_go") {
      return await maybeOuting({ force: true });
    }
    if (p.name === "outing_state") {
      return { ok: true, outing: outingView() };
    }
    if (p.name === "outing_clear") {
      outing = { lastAt: 0, day: "", count: 0, plan: null, specialDates: outing.specialDates, lastCheckAt: 0 };
      await kvBackend.put("outing_state", outing);
      patch({ outing: outingView() });
      return { ok: true, outing: outingView() };
    }
    if (p.name === "outing_special") {
      outing.specialDates = { ...outing.specialDates, ...(p.args?.dates || {}) };
      await kvBackend.put("outing_state", outing);
      return { ok: true, outing: outingView() };
    }
    if (p.name === "event_pool_refresh") {
      const blocked = degraded("event_pool");
      if (blocked) return blocked;
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
      const blocked = degraded("bg");
      if (blocked) return blocked;
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
      const blocked = degraded("bg");
      if (blocked) return blocked;
      const t0 = Date.now();
      const r = await bgAgent.generate(p.args?.query, { n: p.args?.n, provider: p.args?.provider });
      if (ledger) void ledger.record({ kind: "bg", ok: r.ok, ms: Date.now() - t0, error: r.ok ? null : r.reason });
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
    if (p.name === "sync_flush") {
      const n = await flushEvents();
      return { ok: true, sent: n, sync: sync.stats };
    }
    if (p.name === "sync_state") {
      return { ok: true, sync: sync.stats };
    }
    if (p.name === "assets_manifest") {
      const assets = Array.isArray(p.args?.assets) ? p.args.assets : [];
      const ok = host.sendRaw({ type: "assets:manifest", payload: { assets } });
      return { ok, count: assets.length };
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
