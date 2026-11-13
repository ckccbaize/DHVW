// LocalRuntime：端侧数据源（Worker + IndexedDB），主机不可达时接管（§10.7.4 ②）。
// 视图只订阅 LifeStore，切换数据源不重建 UI；PathAgent 由主线程持有，位置不重置。

import { selectEvictions } from "../core/assetstore.js";
import { lightFor } from "../core/light.js";
import { createLlmClient } from "../core/llm/client.js";
import { createAgentRegistry } from "../core/agent/registry.js";
import { createLocalMemory } from "../core/memory/local.js";
import { createMemoryPipeline } from "../core/memory/pipeline.js";

const EVENT_CAP = 2000;
const DEFAULT_QUOTA = 500 * 1024 * 1024;

/** 用 kv 存记忆文档，避免 IndexedDB 版本升级。 */
function kvMemoryBackend(backend, key = "memory_docs") {
  let docs = null;
  const load = async () => {
    if (!docs) docs = (await backend.getKV(key)) || [];
    return docs;
  };
  return {
    async put(doc) {
      const list = await load();
      const i = list.findIndex((d) => d.id === doc.id);
      if (i >= 0) list[i] = doc;
      else list.push(doc);
      await backend.setKV(key, list);
      return doc;
    },
    async delete(id) {
      const list = await load();
      docs = list.filter((d) => d.id !== id);
      await backend.setKV(key, docs);
    },
    async getAll() {
      return (await load()).slice();
    },
    async clear() {
      docs = [];
      await backend.setKV(key, []);
    },
  };
}

// ---------------- IndexedDB 后端（无 IDB 时退化为内存，便于测试/排障） ----------------

function openDb(idbFactory, name = "dhvw", version = 1) {
  return new Promise((resolve, reject) => {
    const req = idbFactory.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("events")) {
        const s = db.createObjectStore("events", { keyPath: "uuid" });
        s.createIndex("t", "t_corrected");
      }
      if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

function idbBackend(db) {
  return {
    async addEvent(ev) {
      await wrap(db.transaction("events", "readwrite").objectStore("events").put(ev));
    },
    async eventCount() {
      return wrap(db.transaction("events", "readonly").objectStore("events").count());
    },
    async oldestEvents(n) {
      const out = [];
      const idx = db.transaction("events", "readonly").objectStore("events").index("t");
      await new Promise((resolve, reject) => {
        const req = idx.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur || out.length >= n) return resolve();
          out.push(cur.value);
          cur.continue();
        };
        req.onerror = () => reject(req.error);
      });
      return out;
    },
    async deleteEvents(uuids) {
      if (!uuids.length) return;
      const store = db.transaction("events", "readwrite").objectStore("events");
      await Promise.all(uuids.map((u) => wrap(store.delete(u))));
    },
    async putAsset(meta) {
      await wrap(db.transaction("assets", "readwrite").objectStore("assets").put(meta));
    },
    async listAssets() {
      return wrap(db.transaction("assets", "readonly").objectStore("assets").getAll());
    },
    async deleteAsset(id) {
      await wrap(db.transaction("assets", "readwrite").objectStore("assets").delete(id));
      await wrap(db.transaction("blobs", "readwrite").objectStore("blobs").delete(id));
    },
    async putBlob(id, blob) {
      await wrap(db.transaction("blobs", "readwrite").objectStore("blobs").put({ id, blob }));
    },
    async getBlob(id) {
      const row = await wrap(db.transaction("blobs", "readonly").objectStore("blobs").get(id));
      return row ? row.blob : null;
    },
    async getKV(k) {
      const row = await wrap(db.transaction("kv", "readonly").objectStore("kv").get(k));
      return row ? row.v : undefined;
    },
    async setKV(k, v) {
      await wrap(db.transaction("kv", "readwrite").objectStore("kv").put({ k, v }));
    },
  };
}

function memoryBackend() {
  const events = new Map();
  const assets = new Map();
  const blobs = new Map();
  const kv = new Map();
  return {
    async addEvent(ev) {
      events.set(ev.uuid, ev);
    },
    async eventCount() {
      return events.size;
    },
    async oldestEvents(n) {
      return [...events.values()].sort((a, b) => a.t_corrected - b.t_corrected).slice(0, n);
    },
    async deleteEvents(uuids) {
      for (const u of uuids) events.delete(u);
    },
    async putAsset(meta) {
      assets.set(meta.id, meta);
    },
    async listAssets() {
      return [...assets.values()];
    },
    async deleteAsset(id) {
      assets.delete(id);
      blobs.delete(id);
    },
    async putBlob(id, blob) {
      blobs.set(id, blob);
    },
    async getBlob(id) {
      return blobs.get(id) || null;
    },
    async getKV(k) {
      return kv.get(k);
    },
    async setKV(k, v) {
      kv.set(k, v);
    },
  };
}

// ---------------- 端侧运行时 ----------------

const FORGE_CAPS = { plot: 8, bg: 4, scene: 6 };

export function createLocalRuntime({
  store,
  scene,
  config = {},
  onIntent = () => {},
  onSay = () => {},
  onEvent = () => {},
  onAsset = () => {},
  onSummary = () => {},
  onQueue = () => {},
  getOffset = () => 0,
  WorkerImpl = globalThis.Worker,
  idbFactory = globalThis.indexedDB,
  now = () => Date.now(),
  forgeIntervalMs = 45000,
} = {}) {
  let backend = null;
  let lifeWorker = null;
  let forgeWorker = null;
  let started = false;
  let suspended = false;
  let tier = "idle";
  let activity = "active";
  let quota = config.assetQuotaBytes || DEFAULT_QUOTA;
  let lastForgeAt = 0;
  let produced = new Map(); // `${day}:${kind}` -> count
  let assets = [];
  let forgeFail = 0;
  let lastTick = null;
  let stats = { ticks: 0, intents: 0, says: 0, assets: 0, fails: 0 };
  let llm = null;
  let registry = null;
  let localMemory = null;
  let memoryPipeline = null;
  let lastMemoryAt = 0;
  let eventsSinceMemory = 0;

  const sceneSummary = () => ({
    grid: scene.grid,
    rooms: scene.rooms,
    props: scene.props,
    doors: scene.doors,
    start: scene.start,
    hotspots: scene.hotspots,
  });

  function postLife(msg) {
    lifeWorker && lifeWorker.postMessage(msg);
  }
  function postForge(msg) {
    forgeWorker && forgeWorker.postMessage(msg);
  }

  function handleLife(msg) {
    switch (msg.type) {
      case "tick": {
        lastTick = msg;
        stats.ticks += 1;
        store.patch({
          clock: { day: msg.day, minute: msg.minute, offsetMs: getOffset(), source: "device" },
          weather: msg.weather,
          phase: msg.phase,
        });
        store.emit("tick", msg);
        maybeForge(msg);
        break;
      }
      case "intent": {
        stats.intents += 1;
        onIntent(msg);
        break;
      }
      case "say": {
        stats.says += 1;
        onSay(msg.text, msg.ttl);
        break;
      }
      case "event": {
        const ev = msg.ev;
        ev.t_corrected = ev.t_local + getOffset();
        persistEvent(ev);
        onEvent(ev);
        break;
      }
      case "summary": {
        onSummary(msg.text);
        break;
      }
      case "llm_call": {
        void logLlm(msg);
        break;
      }
      case "write": {
        void generateWriting(msg);
        break;
      }
      default:
        break;
    }
  }

  async function appendKv(key, item, cap) {
    const list = (await backend.getKV(key)) || [];
    list.push(item);
    if (list.length > cap) list.splice(0, list.length - cap);
    await backend.setKV(key, list);
    return list;
  }

  async function logLlm(entry) {
    if (!backend) return;
    const row = { ...entry, t: now() };
    await appendKv("llm_log", row, 200);
    store.emit("llm", row);
  }

  async function setupBrain() {
    if (!config.llm?.baseUrl || !config.llm?.model) return;
    llm = createLlmClient({
      getProvider: () => config.llm,
      onUsage: () => {},
    });
    registry = createAgentRegistry();
    await registry.load();
    localMemory = createLocalMemory({ backend: kvMemoryBackend(backend) });
    await localMemory.init();
    memoryPipeline = createMemoryPipeline({ llm, registry, localMemory, seen: new Set() });
    store.patch({ memory: { count: localMemory.count, terms: localMemory.terms } });
  }

  async function maybeMemory(force = false) {
    if (!memoryPipeline || suspended) return;
    if (!force && eventsSinceMemory < 20 && now() - lastMemoryAt < 60000) return;
    const events = await backend.oldestEvents(40);
    if (events.length < 3) return;
    lastMemoryAt = now();
    eventsSinceMemory = 0;
    const res = await memoryPipeline.run(events);
    if (res.ok) {
      store.patch({ memory: { count: localMemory.count, terms: localMemory.terms } });
      await logLlm({
        agent: "memory",
        ok: true,
        prompt: `events=${res.scanned}`,
        response: res.facts.map((f) => f.text).join(" | "),
      });
      store.emit("memory", res);
    } else {
      await logLlm({ agent: "memory", ok: false, response: `${res.reason}: ${res.error || ""}` });
    }
  }

  async function generateWriting(ctx) {
    if (!llm) return;
    const kind = Math.random() < 0.5 ? "diary" : "novel";
    const prompt =
      kind === "diary"
        ? `写一篇角色日记，第一人称，120-200 字。时间：第${ctx.day}天 ${Math.floor(ctx.minute / 60)}:${String(Math.floor(ctx.minute % 60)).padStart(2, "0")}，地点：${ctx.room}。只输出正文。`
        : `写一段角色正在创作的小说片段，第三人称，150-250 字。时间：第${ctx.day}天，地点：${ctx.room}。只输出正文。`;
    const t0 = now();
    try {
      const res = await llm.complete({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 400,
        temperature: 0.9,
        cls: "work",
        kind: "writing",
      });
      const text = res.text.trim();
      if (!text) throw new Error("空文本");
      const item = {
        id: `w-${now()}`,
        kind,
        text,
        day: ctx.day,
        minute: ctx.minute,
        room: ctx.room,
        created_at: now(),
      };
      await appendKv("writings", item, 50);
      await logLlm({ agent: "writing", ok: true, ms: now() - t0, prompt, response: text });
      store.emit("writing", item);
    } catch (err) {
      await logLlm({ agent: "writing", ok: false, ms: now() - t0, prompt, response: err.message });
    }
  }

  async function persistEvent(ev) {
    if (!backend) return;
    try {
      await backend.addEvent(ev);
      eventsSinceMemory += 1;
      void maybeMemory();
      const count = await backend.eventCount();
      if (count > EVENT_CAP) {
        const oldest = await backend.oldestEvents(count - EVENT_CAP);
        await backend.deleteEvents(oldest.map((e) => e.uuid));
        store.emit("dropped", { dropped: count - EVENT_CAP });
      }
    } catch (err) {
      console.warn("事件落库失败", err);
    }
  }

  async function handleAsset(asset) {
    stats.assets += 1;
    const meta = {
      id: asset.id,
      kind: asset.kind,
      tier: asset.tier || "edge",
      origin: asset.origin,
      seed: asset.seed,
      created_at: asset.created_at || now(),
      consumed_at: null,
      size: asset.size || 0,
      meta: asset.meta || {},
      text: asset.text || null,
    };
    try {
      if (asset.blob && backend) await backend.putBlob(meta.id, asset.blob);
      if (backend) await backend.putAsset(meta);
    } catch (err) {
      console.warn("资产落库失败", err);
    }
    assets = assets.filter((a) => a.id !== meta.id).concat(meta);
    await enforceQuota();
    store.patch({ assets: countByKind(assets) });
    onAsset(meta);
    store.emit("asset", meta);
  }

  function countByKind(list) {
    const out = { scene: 0, plot: 0, bg: 0 };
    for (const a of list) if (out[a.kind] !== undefined) out[a.kind] += 1;
    return out;
  }

  async function enforceQuota() {
    const evict = selectEvictions(assets, quota);
    if (!evict.length) return;
    const gone = new Set(evict);
    assets = assets.filter((a) => !gone.has(a.id));
    for (const id of evict) {
      try {
        await backend.deleteAsset(id);
      } catch {}
    }
    store.patch({ assets: countByKind(assets) });
    store.emit("evicted", { ids: evict });
  }

  function maybeForge(tick) {
    if (tier !== "edge" || suspended) return;
    // forge 只在无互动/息屏时段跑，绝不抢活跃期（§10.7.3 调度）
    if (activity === "active") return;
    const t = now();
    if (t - lastForgeAt < forgeIntervalMs) return;
    const order = ["plot", "bg", "scene"];
    let kind = null;
    let best = Infinity;
    for (const k of order) {
      const n = produced.get(`${tick.day}:${k}`) || 0;
      if (n >= FORGE_CAPS[k]) continue;
      if (n < best) {
        best = n;
        kind = k;
      }
    }
    if (!kind) return;
    lastForgeAt = t;
    produced.set(`${tick.day}:${kind}`, (produced.get(`${tick.day}:${kind}`) || 0) + 1);
    postForge({
      type: "enqueue",
      kind,
      seed: `${tick.day}-${Math.floor(tick.minute)}-${kind}`,
      ctx: {
        day: tick.day,
        minute: tick.minute,
        phase: tick.phase,
        weather: tick.weather,
        room: tick.room || scene.start,
        act: "rest",
        light: lightFor(tick.phase, tick.weather),
        seed: `${tick.day}-${kind}`,
      },
    });
  }

  function handleForge(msg) {
    switch (msg.type) {
      case "asset":
        handleAsset(msg.asset);
        break;
      case "fail":
        forgeFail += 1;
        stats.fails += 1;
        store.emit("forge_fail", { kind: msg.kind, reason: msg.reason, total: forgeFail });
        break;
      case "queue":
        onQueue(msg);
        break;
      default:
        break;
    }
  }

  return {
    get tier() {
      return tier;
    },
    get stats() {
      return { ...stats, forgeFail, assets: assets.length };
    },
    get lastTick() {
      return lastTick;
    },
    async start() {
      if (started) return;
      started = true;
      backend = idbFactory ? idbBackend(await openDb(idbFactory)) : memoryBackend();
      try {
        assets = await backend.listAssets();
      } catch {
        assets = [];
      }
      store.patch({ assets: countByKind(assets) });
      await setupBrain();

      if (WorkerImpl) {
        lifeWorker = new WorkerImpl(new URL("../../workers/life.worker.js", import.meta.url), { type: "module" });
        lifeWorker.onmessage = (e) => handleLife(e.data);
        forgeWorker = new WorkerImpl(new URL("../../workers/forge.worker.js", import.meta.url), { type: "module" });
        forgeWorker.onmessage = (e) => handleForge(e.data);
      }

      const day = await backend.getKV("day").catch(() => undefined);
      const minute = await backend.getKV("minute").catch(() => undefined);

      postLife({
        type: "init",
        scene: sceneSummary(),
        day: day ?? 1,
        minute: minute ?? config.life?.startMinute ?? 8 * 60,
        minutesPerSecond: config.life?.minutesPerSecond ?? 1,
        tickMs: config.life?.tickMs ?? 1000,
        llm: config.llm || null,
      });
      postForge({
        type: "init",
        scene: { w: scene.grid.w, h: scene.grid.h, cell: scene.grid.cell || 16 },
        homeUrl: scene.image2xUrl ? new URL(scene.image2xUrl, globalThis.location?.href ?? "http://127.0.0.1/").href : null,
        recentPlots: assets.filter((a) => a.kind === "plot" && a.text).map((a) => a.text),
      });
    },
    stop() {
      started = false;
      if (lifeWorker) lifeWorker.terminate();
      if (forgeWorker) forgeWorker.terminate();
      lifeWorker = null;
      forgeWorker = null;
    },
    /** 进显现 / 出端侧档：挂起，队列保留。 */
    suspend() {
      suspended = true;
      postLife({ type: "suspend" });
      postForge({ type: "suspend" });
    },
    resume() {
      suspended = false;
      postLife({ type: "resume" });
      postForge({ type: "resume" });
    },
    /** active | idle | asleep（息屏 1 tick/min）。 */
    setActivity(level) {
      activity = level;
      postLife({ type: "setActivity", level });
    },
    /** 切档：edge 时才开始产资产。 */
    setTier(next) {
      tier = next;
      if (next === "edge") {
        postForge({ type: "resume" });
        lastForgeAt = 0;
      }
    },
    arrived(room, act) {
      postLife({ type: "arrived", room, act });
    },
    intentFailed() {
      postLife({ type: "intentFailed" });
    },
    requestSummary() {
      postLife({ type: "summary" });
    },
    syncClock(day, minute) {
      postLife({ type: "sync", day, minute });
    },
    enqueue(kind, ctx) {
      postForge({ type: "enqueue", kind, seed: now(), ctx });
    },
    /** 回流：取最早 n 条待同步事件。 */
    async drainEvents(n = 200) {
      return backend.oldestEvents(n);
    },
    async markSynced(uuids) {
      await backend.deleteEvents(uuids);
    },
    async listAssets() {
      return assets.slice();
    },
    async getAssetBlob(id) {
      return backend.getBlob(id);
    },
    async persistClock(day, minute) {
      await backend.setKV("day", day).catch(() => {});
      await backend.setKV("minute", minute).catch(() => {});
    },
    trigger(kind, act) {
      if (kind === "memory") {
        void maybeMemory(true);
        return;
      }
      if (kind === "write") {
        void generateWriting({
          day: lastTick?.day ?? 1,
          minute: lastTick?.minute ?? 0,
          room: lastTick?.room || scene.start,
        });
        return;
      }
      postLife({ type: "debug_trigger", kind, act });
    },
    async getMemory() {
      return localMemory ? localMemory.all() : [];
    },
    async getWritings() {
      return (await backend.getKV("writings")) || [];
    },
    async getLlmLog() {
      return (await backend.getKV("llm_log")) || [];
    },
    setQuota(bytes) {
      quota = bytes;
      enforceQuota();
    },
  };
}
