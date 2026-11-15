// LocalRuntime：端侧数据源（Worker + IndexedDB），主机不可达时接管（§10.7.4 ②）。
// 视图只订阅 LifeStore，切换数据源不重建 UI；PathAgent 由主线程持有，位置不重置。

import { selectEvictions } from "../core/assetstore.js";
import { weekdayInfo } from "../core/clock.js";
import { lightFor } from "../core/light.js";
import { createLlmClient } from "../core/llm/client.js";
import { createAgentRegistry } from "../core/agent/registry.js";
import { createLocalMemory } from "../core/memory/local.js";
import { createMemoryPipeline } from "../core/memory/pipeline.js";
import { extractJson } from "../core/agent/json.js";
import { describeMood, moodTone } from "../core/mood/describe.js";
import { buildMoodView } from "../core/mood.js";
import { moodBand } from "../core/machine/life.js";
import { DESTINATIONS } from "../core/life/outing.js";
import { createBrowsePlanner } from "../core/actions/browse.js";
import { normalizeBehaviors, roomForAct, createActRoomMap } from "../core/life/plan.js";

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

function openDb(idbFactory, name = "dhvw", version = 2) {
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
  let lastAgentPos = null;
  let stateSaveTimer = null;
  let stats = { ticks: 0, intents: 0, says: 0, assets: 0, fails: 0 };
  let llm = null;
  let registry = null;
  let localMemory = null;
  let memoryPipeline = null;
  let lastMemoryAt = 0;
  let eventsSinceMemory = 0;
  let lastMemoryDay = -1;
  let lastPlotDay = -1;
  let plotBusy = false;
  let memoryBusy = false;
  let lastSnapshot = null;
  let recentPlots = [];
  let dailyPlots = {};
  let sceneRequests = [];
  let mood = { energy: 0.55, valence: 0.55, social: 0.4, focus: 0.5 };
  let digestSeq = 0;

  const sceneSummary = () => ({
    grid: scene.grid,
    rooms: scene.rooms,
    props: scene.props,
    doors: scene.doors,
    start: scene.start,
    hotspots: scene.hotspots,
    interactions: scene.interactions || null,
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
        const wk = weekdayInfo();
        const day = Math.max(1, Number(msg.day) || 1);
        const week = Math.floor((day - 1) / 7) + 1;
        store.patch({
          clock: { day: msg.day, week, minute: msg.minute, offsetMs: getOffset(), source: "device", ...wk },
          weather: msg.weather,
          phase: msg.phase,
        });
        if (msg.phase !== "sleep" && store.state.sleepView) {
          store.patch({ sleepView: null });
        }
        store.emit("tick", msg);
        void maybePlot(msg);
        // 记忆每天只在夜里归纳一次
        if (msg.phase === "sleep" && lastMemoryDay !== msg.day) {
          lastMemoryDay = msg.day;
          void backend.setKV("last_memory_day", msg.day).catch(() => {});
          void maybeMemory(true);
        }
        maybeForge(msg);
        break;
      }
      case "snapshot": {
        lastSnapshot = msg.snapshot ? { ...msg.snapshot, savedAt: Date.now() } : null;
        if (lastSnapshot) {
          void backend.setKV("life_snapshot", lastSnapshot).catch(() => {});
          scheduleStateSave();
        }
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
        if (ev.kind === "sleep") store.patch({ sleepView: ev.payload?.bed || null });
        if (ev.kind === "wake") store.patch({ sleepView: null });
        persistEvent(ev);
        onEvent(ev);
        break;
      }
      case "summary": {
        onSummary(msg.text);
        break;
      }
      case "mood": {
        mood = { ...mood, ...(msg.mood || {}) };
        backend.setKV("mood", mood).catch(() => {});
        store.patch({ mood: { ...mood }, band: moodBand(mood) });
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
    // 清掉历史重复事实，只保留每个文本的第一条
    const seenText = new Set();
    for (const d of localMemory.all()) {
      const key = String(d.text || "").replace(/\s+/g, "");
      if (seenText.has(key)) await localMemory.remove(d.id);
      else seenText.add(key);
    }
    memoryPipeline = createMemoryPipeline({ llm, registry, localMemory, seen: new Set() });
    postLife({ type: "setMemory", text: memoryText(10) });
    lastMemoryDay = (await backend.getKV("last_memory_day")) ?? -1;
    store.patch({ memory: { count: localMemory.count, terms: localMemory.terms } });
  }

  async function maybeMemory(force = false) {
    if (!memoryPipeline || suspended) return;
    if (memoryBusy) return;
    if (!force && now() - lastMemoryAt < 60000) return;
    memoryBusy = true;
    const [events, writings, browses, plots] = await Promise.all([
      backend.oldestEvents(40),
      backend.getKV("writings"),
      backend.getKV("browse_log"),
      backend.getKV("plots"),
    ]);
    const extra = [];
    for (const w of (writings || []).slice(-10)) extra.push({ kind: "writing", payload: { kind: w.kind, text: w.text }, t_local: w.created_at });
    for (const b of (browses || []).slice(-10)) {
      extra.push({
        kind: "browse",
        payload: { query: b.plan?.query || b.plan?.url, title: b.result?.page?.title || "", text: b.result?.page?.text || "" },
        t_local: b.created_at,
      });
    }
    for (const p of (plots || []).slice(-5)) extra.push({ kind: "plot", payload: { text: p.text, event: p.event }, t_local: p.created_at });
    const allEvents = [...events, ...extra];
    if (allEvents.length < 3) {
      memoryBusy = false;
      return;
    }
    lastMemoryAt = now();
    eventsSinceMemory = 0;
    const res = await memoryPipeline.run(allEvents);
    if (res.ok) {
      if (res.highlight) {
        await localMemory.add({
          id: `highlight-${lastMemoryDay}`,
          text: res.highlight.text,
          tier: "L1",
          t: now(),
          meta: { source: "highlight", reason: res.highlight.reason },
        }).catch(() => {});
        await backend.setKV("memory_highlight", res.highlight).catch(() => {});
      }
      if (res.summary) await backend.setKV("memory_summary", res.summary).catch(() => {});
      store.patch({ memory: { count: localMemory.count, terms: localMemory.terms } });
      await logLlm({
        agent: "memory",
        ok: true,
        prompt: `events=${res.scanned}`,
        response: res.raw || res.facts.map((f) => f.text).join(" | "),
      });
      store.emit("memory", res);
      postLife({ type: "setMemory", text: memoryText(10) });
    } else {
      await logLlm({ agent: "memory", ok: false, response: `${res.reason}: ${res.error || ""}` });
    }
    memoryBusy = false;
  }

  function memoryText(limit = 8) {
    return localMemory ? localMemory.all().slice(-limit).map((d) => d.text).join("\n") : "";
  }

  function parseClock(v, fallback) {
    if (typeof v === "string") {
      const m = v.match(/^(\d{1,2}):(\d{2})$/);
      if (m) return Math.max(0, Math.min(1439, Number(m[1]) * 60 + Number(m[2])));
    }
    if (Number.isFinite(v)) return Math.max(0, Math.min(1439, Number(v)));
    return fallback;
  }

  async function mapPoolText() {
    const custom = (await backend.getKV("places")) || [];
    const pool = [...DESTINATIONS, ...custom].filter((p) => p.id !== "home" && p.id !== "office" && p.kind !== "office");
    return JSON.stringify(pool.map(({ id, name, kind, distance, overnight }) => ({ id, name, kind, distance, overnight: overnight === true })));
  }

  async function placeIdSet() {
    const custom = (await backend.getKV("places")) || [];
    return new Set([...DESTINATIONS.map((d) => d.id), ...custom.map((p) => p.id)]);
  }

  async function allPlaceRecords() {
    const custom = (await backend.getKV("places")) || [];
    return [...DESTINATIONS, ...custom];
  }

  async function addPlaceRecord(place = {}) {
    const id = String(place.id || "").trim();
    if (!id) return { ok: false, error: "缺 id" };
    if (DESTINATIONS.some((p) => p.id === id)) return { ok: true, id, added: false };
    const custom = (await backend.getKV("places")) || [];
    if (custom.some((p) => p.id === id)) return { ok: true, id, added: false };
    custom.push({
      id,
      name: String(place.name || id).slice(0, 20),
      kind: place.kind === "street" ? "street" : "indoor",
      distance: Math.max(0, Math.min(120, Number(place.distance) || 5)),
      overnight: place.overnight === true,
    });
    await backend.setKV("places", custom);
    return { ok: true, id, added: true };
  }

  async function hasLocalScene(placeId) {
    const id = String(placeId || "").trim();
    if (!id || typeof fetch !== "function") return false;
    try {
      const res = await fetch(`assets/scenes/${encodeURIComponent(id)}/${encodeURIComponent(id)}.built.json`, { cache: "no-store" });
      return !!res?.ok;
    } catch {
      return false;
    }
  }

  async function saveSceneRequests() {
    sceneRequests = sceneRequests.slice(0, 20);
    await backend.setKV("scene_requests", sceneRequests).catch(() => {});
  }

  /** 把外部地点排进摘要的 sceneRequests；PC 消费后生成场景包并 scene:ready 推回。 */
  async function enqueueSceneRequest(placeId, { reason = "plan", day = 0, description = "" } = {}) {
    const id = String(placeId || "").trim();
    if (!id) return { ok: false, error: "缺 placeId" };
    if (await hasLocalScene(id)) return { ok: true, queued: false, local: true };
    const existing = sceneRequests.find((r) => r.placeId === id && (r.status === "pending" || r.status === "ready"));
    if (existing) return { ok: true, queued: false, request: existing };
    const place = (await allPlaceRecords()).find((p) => p.id === id);
    if (!place) return { ok: false, error: `未知地点 ${id}` };
    const request = {
      id: `scene-${id}-${day || now().toString(36)}`,
      day: day || 0,
      reason,
      mode: "new",
      placeId: id,
      mapSpec: {
        kind: place.kind === "street" ? "street" : "indoor",
        name: place.name || id,
        distance: place.distance,
        description: String(description || "").slice(0, 200),
        seed: `${day || 0}-${id}`,
      },
      description: String(description || "").slice(0, 200),
      travel: true,
      status: "pending",
      createdAt: now(),
    };
    sceneRequests.unshift(request);
    await saveSceneRequests();
    store.emit("scene_request", request);
    return { ok: true, queued: true, request };
  }

  async function ensureSceneRequests(plan, reason = "plan") {
    if (!plan) return;
    const today = lastSnapshot?.day ?? 1;
    const nowMinute = lastSnapshot?.minute ?? 0;
    if (Number.isFinite(plan.forDay) && plan.forDay < today) return;
    const rooms = new Set((scene.rooms || []).map((r) => r.id));
    const places = await allPlaceRecords();
    const seen = new Set();
    for (const b of plan.behaviors || []) {
      if (!b?.place || rooms.has(b.place) || seen.has(b.place)) continue;
      if (plan.forDay === today && Number.isFinite(b.minute) && b.minute <= nowMinute) continue;
      if (!places.some((p) => p.id === b.place)) continue;
      seen.add(b.place);
      await enqueueSceneRequest(b.place, {
        reason,
        day: plan.forDay || plan.day || 0,
        description: b.why || plan.text || "",
      });
    }
  }

  async function applySceneReady(p = {}) {
    const sceneId = String(p.sceneId || p.job || "").trim();
    const name = String(p.name || "").trim();
    const req = sceneRequests.find((r) => r.status === "pending" && (
      (p.placeId && r.placeId === p.placeId) ||
      (name && r.mapSpec?.name === name)
    ));
    if (!req) return null;
    req.status = "ready";
    req.sceneId = sceneId;
    req.readyAt = now();
    await saveSceneRequests();
    await addPlaceRecord({
      id: req.placeId,
      name: req.mapSpec?.name || req.placeId,
      kind: req.mapSpec?.kind,
      distance: req.mapSpec?.distance,
    });
    return req;
  }

  async function loadFileState() {
    try {
      const res = await fetch("/__state", { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  function scheduleStateSave() {
    if (stateSaveTimer) return;
    stateSaveTimer = setTimeout(() => {
      stateSaveTimer = null;
      void saveFileState();
    }, 500);
  }

  async function saveFileState() {
    if (!lastSnapshot && !lastAgentPos) return;
    const payload = {
      v: 1,
      savedAt: Date.now(),
      life: lastSnapshot,
      agent: lastAgentPos,
    };
    try {
      await fetch("/__state", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    } catch {}
  }

  function mapSummary() {
    const rooms = (scene.rooms || []).map((r) => `${r.id}:${r.name || ""}`).join("、");
    const props = (scene.props || []).map((p) => p.id).slice(0, 40).join("、");
    return `房间：${rooms}；家具：${props}`;
  }

  async function generateDesires(tick, behaviors) {
    const prompt = `她的记忆：\n${memoryText(10) || "暂无"}\n\n最近行为：\n${behaviors || "暂无"}\n\n当前心情：${describeMood(mood)}\n时间：第${tick.day}天 ${Math.floor(tick.minute / 60)}:${String(Math.floor(tick.minute % 60)).padStart(2, "0")}\n\n以角色第一人称写出 3 条此刻最真实的愿望，每条 10-30 字，不要解释。只输出 JSON：{"desires":["...","...","..."]}`;
    const t0 = now();
    try {
      const res = await llm.complete({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 220,
        temperature: 0.8,
        json: true,
        cls: "work",
        kind: "desire",
      });
      const obj = extractJson(res.text);
      const desires = Array.isArray(obj?.desires)
        ? obj.desires.map((d) => String(d).trim()).filter(Boolean).slice(0, 3)
        : [];
      await appendKv("desires", { id: `d-${now()}`, day: tick.day, desires, created_at: now() }, 20);
      await logLlm({ agent: "desire", ok: true, ms: now() - t0, prompt, response: res.text });
      return desires;
    } catch (err) {
      await logLlm({ agent: "desire", ok: false, ms: now() - t0, prompt, response: err.message });
      return [];
    }
  }

  async function maybePlot(tick, force = false) {
    if (!llm || !registry || suspended) return;
    if (!force && tick.phase !== "sleep") return;
    if (!force && lastPlotDay === tick.day) return;
    if (plotBusy) return;
    plotBusy = true;
    lastPlotDay = tick.day;
    const hh = String(Math.floor(tick.minute / 60)).padStart(2, "0");
    const mm = String(Math.floor(tick.minute % 60)).padStart(2, "0");
    const evs = await backend.oldestEvents(80).catch(() => []);
    const recentBehaviors = evs
      .filter((e) => e.kind === "act")
      .slice(-10)
      .map((e) => `${Math.floor((e.payload?.minute || 0) / 60)}:${String((e.payload?.minute || 0) % 60).padStart(2, "0")} ${e.payload?.act}@${e.payload?.room}`)
      .join("\n");
    const desires = await generateDesires(tick, recentBehaviors);
    const prompt = registry.render("plot", {
      now: `第${tick.day}天 ${hh}:${mm}`,
      period: tick.phase,
      place: tick.room || scene.start,
      input: `为明天安排完整的一天；明天 ${String(Math.floor((tick.sleepAt || 1380) / 60)).padStart(2, "0")}:${String((tick.sleepAt || 1380) % 60).padStart(2, "0")} 睡、${String(Math.floor((tick.wakeAt || 420) / 60)).padStart(2, "0")}:${String((tick.wakeAt || 420) % 60).padStart(2, "0")} 醒`,
      mood: describeMood(mood),
      recent: JSON.stringify(recentPlots.slice(-5)),
      memory: memoryText(10) || "暂无",
      desires: JSON.stringify(desires),
      behaviors: recentBehaviors || "暂无",
      history: JSON.stringify(
        Object.values(dailyPlots)
          .sort((a, b) => b.forDay - a.forDay)
          .slice(0, 3)
          .map((d) => ({ day: d.forDay, text: d.text, behaviors: (d.behaviors || []).map((b) => b.act) })),
      ),
      map: mapSummary(),
      map_pool: await mapPoolText(),
    });
    const t0 = now();
    try {
      const res = await llm.complete({
        messages: [{ role: "user", content: prompt }],
        maxTokens: 900,
        temperature: 0.7,
        json: true,
        cls: "work",
        kind: "plot",
      });
      const obj = extractJson(res.text);
      const text = String(obj?.text || "").trim();
      if (!text) throw new Error("空剧情");
      const rooms = new Set((scene.rooms || []).map((r) => r.id));
      const places = await placeIdSet();
      const actRooms = createActRoomMap(scene.hotspots || []);
      const requestedPlace = rooms.has(obj?.place) ? obj.place : tick.room || scene.start;
      const planAct = String(obj?.act || "").trim();
      const actPlace = planAct ? roomForAct(actRooms, planAct, requestedPlace) : null;
      const place = actPlace || requestedPlace;
      const sleepAt = parseClock(obj?.sleepAt, 22 * 60);
      const wakeAt = parseClock(obj?.wakeAt, 8 * 60);
      const normalized = normalizeBehaviors(
        (obj?.behaviors || []).map((b) => ({ ...b, minute: parseClock(b?.time, -1) })),
        { rooms, places, hotspots: scene.hotspots || [], fallbackPlace: place },
      );
      let writeCount = 0;
      const behaviors = normalized
        .filter((b) => (b.act === "write" ? writeCount++ < 1 : true))
        .slice(0, 12);
      const sudden = obj?.sudden && obj.sudden.enabled
        ? {
            minute: parseClock(obj.sudden.time, 15 * 60),
            text: String(obj.sudden.text || "").trim(),
          }
        : null;
      const item = {
        id: `p-${now()}`,
        text,
        event: obj?.event || "",
        place,
        mood: obj?.mood || {},
        act: actPlace ? planAct : null,
        sleepAt,
        wakeAt,
        behaviors,
        sudden,
        desires,
        forDay: tick.day + 1,
        day: tick.day,
        minute: tick.minute,
        created_at: now(),
      };
      recentPlots.push(text);
      if (recentPlots.length > 20) recentPlots.shift();
      dailyPlots[item.forDay] = item;
      await ensureSceneRequests(item, "plan");
      await appendKv("plots", item, 50);
      await backend.setKV("daily_plots", dailyPlots).catch(() => {});
      await backend.setKV("last_plot_day", lastPlotDay).catch(() => {});
      if (sudden) await appendKv("sudden_events", { ...sudden, day: item.forDay, created_at: now() }, 50);
      await applyMood(item.mood);
      if (localMemory) {
        await localMemory.add({ id: `plot-${tick.day}`, text, tier: "L1", t: now(), meta: { source: "plot" } }).catch(() => {});
      }
      postLife({
        type: "setPlan",
        plan: {
          day: item.forDay,
          place,
          act: item.act,
          text,
          sleepAt,
          wakeAt,
          behaviors,
          sudden,
        },
      });
      await logLlm({ agent: "plot", ok: true, ms: now() - t0, prompt, response: res.text });
      store.emit("plot_event", item);
      if (tick.phase !== "sleep") onSay(text, 4200);
    } catch (err) {
      await logLlm({ agent: "plot", ok: false, ms: now() - t0, prompt, response: err.message });
    } finally {
      plotBusy = false;
    }
  }

  async function applyMood(deltas = {}) {
    const dims = ["energy", "valence", "social", "focus"];
    for (const k of dims) {
      if (deltas[k] === undefined) continue;
      const cur = Number.isFinite(Number(mood[k])) ? Number(mood[k]) : 0.5;
      mood[k] = Math.max(0, Math.min(1, cur + Number(deltas[k] || 0)));
    }
    await backend.setKV("mood", mood).catch(() => {});
    store.patch({ mood: { ...mood } });
    postLife({ type: "setMood", mood: { ...mood } });
  }

  async function maybeBrowse() {
    if (!llm || !registry) return;
    const t0 = now();
    const planner = createBrowsePlanner({ llm, registry });
    const plan = await planner.plan({ threads: memoryText(6).split("\n").filter(Boolean), recent: [], mood });
    if (!plan.ok) {
      await logLlm({ agent: "browse", ok: false, ms: now() - t0, response: plan.reason });
      return;
    }
    let result = null;
    const query = plan.query || plan.topic || plan.url || "";
    if (query) {
      const res = await fetch(`/__search?q=${encodeURIComponent(query)}&n=5`, { cache: "no-store" });
      result = res.ok ? await res.json() : { error: `http_${res.status}` };
      const first = result?.results?.find((r) => r.url);
      if (first) {
        try {
          const page = await fetch(`/__fetch?url=${encodeURIComponent(first.url)}`, { cache: "no-store" });
          if (page.ok) {
            const data = await page.json();
            result.page = { url: first.url, title: data.title || first.title || "", text: String(data.text || "").slice(0, 1200) };
          }
        } catch {}
      }
    }
    const item = { id: `browse-${now()}`, plan, result, created_at: now() };
    await appendKv("browse_log", item, 20);
    await logLlm({
      agent: "browse",
      ok: true,
      ms: now() - t0,
      prompt: plan.query || plan.url || plan.topic,
      response: plan.raw || JSON.stringify(result?.page || result?.results?.slice(0, 3) || result || {}),
    });
    store.emit("browse", item);
  }

  async function generateWriting(ctx) {
    if (!llm || !registry) return;
    const kind = ctx.kind === "weekly" ? "weekly" : (Math.random() < 0.5 ? "diary" : "novel");
    const todayPlot = dailyPlots[ctx.day]?.text || dailyPlots[ctx.day + 1]?.text || "";
    const clock = `${String(Math.floor(ctx.minute / 60)).padStart(2, "0")}:${String(Math.floor(ctx.minute % 60)).padStart(2, "0")}`;
    const wk = ctx.weekdayName ? { weekday: ctx.weekday, weekdayName: ctx.weekdayName } : weekdayInfo();
    let recentDiaries = "暂无";
    if (kind === "weekly" && backend) {
      const prev = ((await backend.getKV("writings")) || [])
        .filter((w) => w && w.kind === "diary" && w.text)
        .slice(-7)
        .map((w) => w.text.slice(0, 80));
      if (prev.length) recentDiaries = prev.join("；");
    }
    const vars = {
      day: ctx.day,
      weekday: wk.weekdayName,
      clock,
      room: ctx.room,
      mood: describeMood(mood),
      tone: moodTone(mood),
      memory: memoryText(kind === "weekly" ? 10 : 6) || "暂无",
      plot: todayPlot || "无特别事件",
      recent_diaries: recentDiaries,
    };
    const promptName = kind === "weekly" ? "writing-weekly" : (kind === "diary" ? "writing-diary" : "writing-novel");
    const t0 = now();
    let prompt = "";
    let text = "";
    let reason = "";
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        prompt = registry.render(promptName, vars);
        if (attempt > 1) prompt += `\n\n上一稿不合格：${reason}。请重写，严格满足要求。`;
        const res = await llm.complete({
          messages: [{ role: "user", content: prompt }],
          maxTokens: kind === "weekly" ? 650 : 500,
          temperature: kind === "novel" ? 0.7 : 0.8,
          cls: "work",
          kind: "writing",
        });
        text = String(res.text || "").trim();
        if (!text) { reason = "空文本"; continue; }
        if ((kind === "diary" || kind === "weekly") && !/我/.test(text)) {
          reason = kind === "weekly" ? "周记必须使用第一人称「我」" : "日记必须使用第一人称「我」";
          continue;
        }
        if (kind === "novel" && /她写道|笔尖|笔记本|划掉|继续写|写小说|小说片段/.test(text)) {
          reason = "小说正文不能写写作过程";
          continue;
        }
        if (text.length < 60) { reason = "内容过短，需要完整的一件事"; continue; }
        reason = "";
        break;
      }
      if (reason) throw new Error(reason);
      const item = {
        id: `w-${now()}`,
        kind,
        text,
        day: ctx.day,
        weekday: wk.weekday,
        weekdayName: wk.weekdayName,
        minute: ctx.minute,
        room: ctx.room,
        created_at: now(),
      };
      await appendKv("writings", item, 50);
      if ((kind === "diary" || kind === "weekly") && localMemory) {
        const prefix = kind === "weekly" ? `${wk.weekdayName}周记：` : `${wk.weekdayName}日记：`;
        const excerpt = text.replace(/\s+/g, " ").slice(0, 100);
        await localMemory.add({
          id: `writing-${item.id}`,
          text: `${prefix}${excerpt}`,
          tier: kind === "weekly" ? "L3" : "L2",
          t: now(),
          meta: { source: kind, weekday: wk.weekday },
        }).catch(() => {});
        store.patch({ memory: { count: localMemory.count, terms: localMemory.terms } });
        void maybeMemory(true);
      }
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
    // 剧情机活跃期也跑（低频），背景/场景只在息屏/无互动时跑
    const idle = activity !== "active";
    const interval = idle ? forgeIntervalMs : Math.max(forgeIntervalMs, 120000);
    const t = now();
    if (t - lastForgeAt < interval) return;
    const order = idle ? ["plot", "bg"] : ["plot"];
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
        lifeWorker = new WorkerImpl(new URL(`../../workers/life.worker.js?v=${Date.now()}`, import.meta.url), { type: "module" });
        lifeWorker.onmessage = (e) => handleLife(e.data);
        forgeWorker = new WorkerImpl(new URL(`../../workers/forge.worker.js?v=${Date.now()}`, import.meta.url), { type: "module" });
        forgeWorker.onmessage = (e) => handleForge(e.data);
      }

      const day = await backend.getKV("day").catch(() => undefined);
      const minute = await backend.getKV("minute").catch(() => undefined);
      lastSnapshot = (await backend.getKV("life_snapshot").catch(() => undefined)) || null;
      lastAgentPos = (await backend.getKV("agent_pos").catch(() => undefined)) || null;
      const fileState = await loadFileState();
      if (fileState?.life && (!lastSnapshot || (fileState.savedAt || 0) > (lastSnapshot.savedAt || 0))) {
        lastSnapshot = fileState.life;
      }
      if (fileState?.agent && (!lastAgentPos || (fileState.savedAt || 0) > (lastAgentPos.savedAt || 0))) {
        lastAgentPos = fileState.agent;
      }
      const snapDay = lastSnapshot?.day;
      const snapMinute = lastSnapshot?.minute;
      const useSnapshot = !!lastSnapshot && (
        day == null ||
        snapDay > day ||
        (snapDay === day && (minute == null || snapMinute >= minute))
      );
      const startDay = useSnapshot ? snapDay : day ?? 1;
      const startMinute = useSnapshot ? snapMinute : minute ?? config.life?.startMinute ?? 8 * 60;
      const startSnapshot = lastSnapshot
        ? (useSnapshot ? lastSnapshot : { ...lastSnapshot, day: startDay, minute: startMinute })
        : null;
      lastPlotDay = (await backend.getKV("last_plot_day")) ?? -1;
      dailyPlots = (await backend.getKV("daily_plots")) || {};
      sceneRequests = (await backend.getKV("scene_requests")) || [];
      // 丢掉过去日期的 pending，避免补请求旧计划；同一地点只保留一条 pending/ready。
      const currentDay = lastSnapshot?.day ?? 1;
      const seenRequests = new Set();
      const keptRequests = [];
      for (const r of sceneRequests) {
        if (!r || !r.placeId) continue;
        const day = Number.isFinite(r.day) ? r.day : Number(String(r.id || "").match(/-(\d+)$/)?.[1]);
        if (r.status === "pending" && Number.isFinite(day) && day < currentDay) continue;
        if (r.status === "pending" && await hasLocalScene(r.placeId)) continue;
        if (r.status === "pending" || r.status === "ready") {
          if (seenRequests.has(r.placeId)) continue;
          seenRequests.add(r.placeId);
        }
        keptRequests.push(r);
      }
      sceneRequests = keptRequests;
      await backend.setKV("scene_requests", sceneRequests).catch(() => {});
      const storedPlots = (await backend.getKV("plots")) || [];
      const roomSet = new Set((scene.rooms || []).map((r) => r.id));
      const placeSet = await placeIdSet();
      const actRooms = createActRoomMap(scene.hotspots || []);
      const fixPlan = (p) => {
        if (!p) return p;
        const actPlace = p.act ? roomForAct(actRooms, p.act, p.place) : null;
        if (p.act && !actPlace) p.act = null;
        if (actPlace) p.place = actPlace;
        p.behaviors = normalizeBehaviors(p.behaviors || [], {
          rooms: roomSet,
          places: placeSet,
          hotspots: scene.hotspots || [],
          fallbackPlace: p.place || scene.start,
        });
        return p;
      };
      for (const p of Object.values(dailyPlots)) fixPlan(p);
      for (const p of storedPlots) fixPlan(p);
      for (const p of Object.values(dailyPlots)) await ensureSceneRequests(p, "plan");
      await backend.setKV("daily_plots", dailyPlots).catch(() => {});
      await backend.setKV("plots", storedPlots).catch(() => {});
      mood = (await backend.getKV("mood")) || mood;
      store.patch({ mood: { ...mood } });

      postLife({
        type: "init",
        scene: sceneSummary(),
        day: startDay,
        minute: startMinute,
        snapshot: startSnapshot,
        timeScale: config.life?.timeScale ?? 1,
        tickMs: config.life?.tickMs ?? 1000,
        roamMin: config.life?.roamMin ?? 30,
        thoughtMin: config.life?.thoughtMin ?? 240,
        llm: config.llm || null,
      });
      postLife({ type: "setMood", mood: { ...mood } });
      const plan = dailyPlots[startDay];
      if (plan && !lastSnapshot?.plan) {
        postLife({
          type: "setPlan",
          plan: {
            day: plan.forDay,
            place: plan.place,
            act: plan.act,
            text: plan.text,
            sleepAt: plan.sleepAt,
            wakeAt: plan.wakeAt,
            behaviors: plan.behaviors || [],
            sudden: plan.sudden || null,
          },
        });
      }
      postForge({
        type: "init",
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
    async getAgentPos() {
      return lastAgentPos || (await backend.getKV("agent_pos").catch(() => null));
    },
    async persistAgentPos(pos) {
      lastAgentPos = { ...pos, savedAt: Date.now() };
      await backend.setKV("agent_pos", lastAgentPos).catch(() => {});
      scheduleStateSave();
    },
    async persistClock(day, minute) {
      await backend.setKV("day", day).catch(() => {});
      await backend.setKV("minute", minute).catch(() => {});
      if (lastSnapshot) {
        lastSnapshot = { ...lastSnapshot, day, minute, savedAt: Date.now() };
        await backend.setKV("life_snapshot", lastSnapshot).catch(() => {});
        scheduleStateSave();
      }
    },
    setSpeed(value) {
      const v = Math.max(0.5, Math.min(30, Number(value) || 1));
      postLife({ type: "setSpeed", timeScale: v });
    },
    trigger(kind, act) {
      if (kind === "memory") {
        void maybeMemory(true);
        return;
      }
      if (kind === "browse") {
        void maybeBrowse();
        return;
      }
      if (kind === "plot") {
        void maybePlot(lastTick || { day: 1, minute: 0, phase: "morning", room: scene.start }, true);
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
    async getPlots() {
      return (await backend.getKV("plots")) || [];
    },
    async getBrowseLog() {
      return (await backend.getKV("browse_log")) || [];
    },
    async getEvents(n = 80) {
      const rows = await backend.oldestEvents(400);
      return rows.slice(-n);
    },
    async getDailyPlots() {
      return dailyPlots;
    },
    async getMood() {
      return { ...mood };
    },
    async setLlmConfig(payload = {}) {
      const next = { ...(config.llm || {}) };
      for (const key of ["baseUrl", "apiKey", "model", "timeoutMs", "maxAttempts", "retryBaseMs", "reasoningEffort"]) {
        if (payload[key] !== undefined) next[key] = payload[key];
      }
      if (next.baseUrl && String(next.baseUrl).includes("codex.mintcat.work") && !next.reasoningEffort) {
        next.reasoningEffort = "none";
      }
      config.llm = next;
      try {
        localStorage.setItem("dhvw_llm", JSON.stringify({ baseUrl: next.baseUrl || "", apiKey: next.apiKey || "", model: next.model || "" }));
      } catch {}
      if (next.baseUrl && next.model && !llm) await setupBrain();
      store.emit("llm_config", { baseUrl: next.baseUrl || "", model: next.model || "", hasKey: !!next.apiKey });
      return { ok: true, baseUrl: next.baseUrl || "", model: next.model || "", hasKey: !!next.apiKey };
    },
    async ingestFacts(facts = []) {
      const accepted = [];
      const merged = [];
      const rejected = [];
      if (!localMemory) {
        for (const f of facts) rejected.push({ id: String(f?.id || ""), reason: "memory_not_ready" });
        return { accepted, merged, rejected };
      }
      const byId = new Map(localMemory.all().map((d) => [d.id, d]));
      const byText = new Map(localMemory.all().map((d) => [String(d.text || "").replace(/\s+/g, ""), d]));
      for (const f of facts) {
        const text = String(f?.text || "").trim();
        const id = String(f?.id || "").trim();
        if (!text) {
          rejected.push({ id, reason: "empty_text" });
          continue;
        }
        const key = text.replace(/\s+/g, "");
        const hit = (id && byId.get(id)) || byText.get(key);
        if (hit) {
          merged.push(hit.id);
          continue;
        }
        const doc = {
          id: id || `pc-${key.slice(0, 12)}`,
          text,
          tier: f?.tier || "L2",
          t: Number(f?.t) || now(),
          meta: { source: "pc", conf: f?.conf },
        };
        await localMemory.add(doc);
        byId.set(doc.id, doc);
        byText.set(key, doc);
        accepted.push(doc.id);
      }
      if (accepted.length || merged.length) {
        postLife({ type: "setMemory", text: memoryText(10) });
        store.patch({ memory: { count: localMemory.count, terms: localMemory.terms } });
      }
      return { accepted, merged, rejected };
    },
    async addPlace(place = {}) {
      return await addPlaceRecord(place);
    },
    async requestScene(placeId, reason = "travel", extra = {}) {
      return await enqueueSceneRequest(placeId, { reason, ...extra });
    },
    async markSceneReady(payload = {}) {
      return await applySceneReady(payload);
    },
    async getSceneRequests() {
      return sceneRequests.map((r) => ({ ...r }));
    },
    async buildDigest(extra = {}) {
      const snap = lastSnapshot || {};
      const events = await backend.oldestEvents(20).catch(() => []);
      const plan = dailyPlots[snap.day] || null;
      const custom = (await backend.getKV("places")) || [];
      const wk = weekdayInfo();
      const band = moodBand(mood);
      const dayNum = Math.max(1, Number(snap.day ?? 1) || 1);
      const week = Math.floor((dayNum - 1) / 7) + 1;
      return {
        v: 1,
        ts: now(),
        seq: ++digestSeq,
        clock: {
          day: snap.day ?? 1,
          week,
          minute: Math.round(snap.minute ?? 0),
          phase: snap.phase || "morning",
          ...wk,
        },
        world: {
          tier: store.state.tier,
          conn: store.state.conn,
          display: store.state.display,
          scene: scene.name || scene.id || "home",
          phase: snap.phase || "morning",
          weather: store.state.weather || "clear",
          ...(extra.world || {}),
        },
        life: snap,
        agenda: (plan?.behaviors || []).map((b, i) => ({
          id: `plan-${i}`,
          kind: "plot",
          at: b.minute,
          status: "planned",
          payload: b,
        })),
        sceneRequests: sceneRequests.filter((r) => r.status === "pending"),
        pcActions: [],
        recentEvents: events.slice(-20),
        budget: null,
        eventPool: null,
        outing: null,
        lastPlot: plan,
        mood: buildMoodView({
          now: now(),
          minute: Math.round(snap.minute ?? 0),
          mood,
          band,
          series: [],
          moodLog: [],
        }),
        places: [...DESTINATIONS, ...custom].map(({ id, name, kind, distance }) => ({ id, name, kind, distance })),
      };
    },
    moodState() {
      const snap = lastSnapshot || {};
      return buildMoodView({
        now: now(),
        minute: Math.round(snap.minute ?? 0),
        mood,
        band: moodBand(mood),
        series: [],
        moodLog: [],
      });
    },
    getSnapshot() {
      return lastSnapshot;
    },
    /** 整份设备存档：life/agent + 地点/心情/日程/产出，供 PC 备份。 */
    async exportSave() {
      if (!lastSnapshot || !lastAgentPos) return null;
      const [places, writings, plots, moodNow] = await Promise.all([
        backend.getKV("places").catch(() => []),
        backend.getKV("writings").catch(() => []),
        backend.getKV("plots").catch(() => []),
        Promise.resolve({ ...mood }),
      ]);
      return {
        v: 1,
        savedAt: Date.now(),
        life: lastSnapshot,
        agent: lastAgentPos,
        places: Array.isArray(places) ? places : [],
        writings: Array.isArray(writings) ? writings : [],
        plots: Array.isArray(plots) ? plots : [],
        dailyPlots: { ...dailyPlots },
        mood: moodNow,
      };
    },
    /** PC 下发恢复：先落 IndexedDB + 文件存档，由调用方 reload 页面。 */
    async importSave(save) {
      if (!save || typeof save !== "object") throw new Error("存档不是对象");
      const life = save.life;
      const agent = save.agent;
      if (!life || typeof life !== "object" || !Number.isFinite(Number(life.day)) || !Number.isFinite(Number(life.minute))) {
        throw new Error("存档缺少 life.day/minute");
      }
      if (!agent || typeof agent !== "object" || !Number.isFinite(Number(agent.gx)) || !Number.isFinite(Number(agent.gy))) {
        throw new Error("存档缺少 agent.gx/gy");
      }
      const stamp = Date.now();
      lastSnapshot = { ...life, day: Number(life.day), minute: Number(life.minute), savedAt: stamp };
      lastAgentPos = { ...agent, savedAt: stamp };
      await backend.setKV("life_snapshot", lastSnapshot);
      await backend.setKV("agent_pos", lastAgentPos);
      await backend.setKV("day", lastSnapshot.day);
      await backend.setKV("minute", lastSnapshot.minute);
      if (Array.isArray(save.places)) await backend.setKV("places", save.places);
      if (Array.isArray(save.writings)) await backend.setKV("writings", save.writings);
      if (Array.isArray(save.plots)) await backend.setKV("plots", save.plots);
      if (save.dailyPlots && typeof save.dailyPlots === "object") {
        dailyPlots = { ...save.dailyPlots };
        await backend.setKV("daily_plots", dailyPlots);
      }
      if (save.mood && typeof save.mood === "object") {
        mood = { ...mood, ...save.mood };
        await backend.setKV("mood", mood);
        store.patch({ mood: { ...mood } });
      }
      await saveFileState();
      return {
        ok: true,
        day: lastSnapshot.day,
        minute: lastSnapshot.minute,
        scene: lastAgentPos.scene || scene.name || scene.id || "home",
      };
    },
    setQuota(bytes) {
      quota = bytes;
      enforceQuota();
    },
  };
}
