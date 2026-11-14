// LocalRuntime：端侧数据源（Worker + IndexedDB），主机不可达时接管（§10.7.4 ②）。
// 视图只订阅 LifeStore，切换数据源不重建 UI；PathAgent 由主线程持有，位置不重置。

import { selectEvictions } from "../core/assetstore.js";
import { lightFor } from "../core/light.js";
import { createLlmClient } from "../core/llm/client.js";
import { createAgentRegistry } from "../core/agent/registry.js";
import { createLocalMemory } from "../core/memory/local.js";
import { createMemoryPipeline } from "../core/memory/pipeline.js";
import { extractJson } from "../core/agent/json.js";
import { describeMood, moodTone } from "../core/mood/describe.js";
import { generateMap } from "../core/agent/subs/map.js";
import { createBrowsePlanner } from "../core/actions/browse.js";
import { normalizeBehaviors, roomForAct, createActRoomMap } from "../core/life/plan.js";
import { buildScene } from "../forge/scene.js";

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
  let mood = { energy: 0, valence: 0, social: 0, focus: 0 };

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
        if (msg.phase === "sleep") {
          if (!store.state.sleepView) {
            const bed = (scene.props || []).find((p) => p.id === "bed");
            store.patch({ sleepView: bed ? { x: bed.x, y: bed.y, w: bed.w || 1, h: bed.h || 1, facing: bed.facing || "S" } : null });
          }
        } else if (store.state.sleepView) {
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
        lastSnapshot = msg.snapshot || null;
        if (lastSnapshot) void backend.setKV("life_snapshot", lastSnapshot).catch(() => {});
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
      const actRooms = createActRoomMap(scene.hotspots || []);
      const requestedPlace = rooms.has(obj?.place) ? obj.place : tick.room || scene.start;
      const planAct = String(obj?.act || "").trim();
      const actPlace = planAct ? roomForAct(actRooms, planAct, requestedPlace) : null;
      const place = actPlace || requestedPlace;
      const sleepAt = parseClock(obj?.sleepAt, 22 * 60);
      const wakeAt = parseClock(obj?.wakeAt, 8 * 60);
      const normalized = normalizeBehaviors(
        (obj?.behaviors || []).map((b) => ({ ...b, minute: parseClock(b?.time, -1) })),
        { rooms, hotspots: scene.hotspots || [], fallbackPlace: place },
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
      const sceneSpec = typeof obj?.scene === "string"
        ? { dsl: obj.scene }
        : obj?.scene && typeof obj.scene === "object"
          ? (obj.scene.dsl
              ? { dsl: String(obj.scene.dsl) }
              : obj.scene.kind
                ? {
                    kind: String(obj.scene.kind),
                    name: String(obj.scene.name || obj.scene.kind),
                    program: Array.isArray(obj.scene.program) ? obj.scene.program : undefined,
                  }
                : null)
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
        scene: sceneSpec,
        forDay: tick.day + 1,
        day: tick.day,
        minute: tick.minute,
        created_at: now(),
      };
      recentPlots.push(text);
      if (recentPlots.length > 20) recentPlots.shift();
      dailyPlots[item.forDay] = item;
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
      if (sceneSpec) void maybeMap(sceneSpec);
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
      mood[k] = Math.max(-1, Math.min(1, (mood[k] || 0) + Number(deltas[k] || 0)));
    }
    await backend.setKV("mood", mood).catch(() => {});
    store.patch({ mood: { ...mood } });
    postLife({ type: "setMood", mood: { ...mood } });
  }

  const MAP_NAMES = {
    home: "家",
    office: "办公室",
    cafe: "咖啡馆",
    bookstore: "书店",
    library: "图书馆",
    restaurant: "餐厅",
    bar: "酒吧",
    market: "集市",
    shop: "商店",
    cinema: "电影院",
    gym: "健身房",
    clinic: "诊所",
    gallery: "画廊",
    workshop: "工坊",
    park: "公园",
    nature: "公园",
    quiet: "书店",
    social: "咖啡馆",
    lively: "集市",
    errand: "商店",
  };

  async function maybeMap(kindOrSpec = "home") {
    const mapSpec = typeof kindOrSpec === "string"
      ? (kindOrSpec.includes("/") ? { dsl: kindOrSpec } : { kind: kindOrSpec, name: MAP_NAMES[kindOrSpec] || kindOrSpec })
      : kindOrSpec || { kind: "home", name: "家" };
    const kind = mapSpec.kind || "home";
    const t0 = now();
    const r = generateMap({
      mapSpec,
      seed: `${lastTick?.day || 1}-${Math.floor(lastTick?.minute || 0)}-${now()}`,
      w: 24,
      h: 16,
    });
    if (!r.ok) {
      await logLlm({ agent: "map", ok: false, ms: now() - t0, response: r.reason });
      return;
    }
    const baked = buildScene(r.scene.spec);
    const item = {
      id: `map-${now()}`,
      ...r.scene,
      image: baked.image.data,
      imageW: baked.image.w,
      imageH: baked.image.h,
      built: baked.built,
      created_at: now(),
    };
    await appendKv("generated_maps", item, 5);
    await logLlm({
      agent: "map",
      ok: true,
      ms: now() - t0,
      prompt: `generateMap ${mapSpec.dsl || `${mapSpec.kind || kind} / ${mapSpec.name || ""}`}`,
      response: `${item.rooms.length} 房间 / ${item.props.length} 家具 / ${item.w}×${item.h}`,
    });
    store.emit("map_generated", item);
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
    if (!llm) return;
    const kind = Math.random() < 0.5 ? "diary" : "novel";
    const todayPlot = dailyPlots[ctx.day]?.text || dailyPlots[ctx.day + 1]?.text || "";
    const prompt =
      kind === "diary"
        ? `写一篇角色日记，第一人称，120-200 字。时间：第${ctx.day}天 ${Math.floor(ctx.minute / 60)}:${String(Math.floor(ctx.minute % 60)).padStart(2, "0")}，地点：${ctx.room}。她现在${describeMood(mood)}；${moodTone(mood)}。她记得：${memoryText(6) || "暂无"}。今天发生的剧情：${todayPlot || "无特别事件"}。日记里要自然提到这件事。只输出正文。`
        : `写一段角色正在创作的小说片段，第三人称，150-250 字。时间：第${ctx.day}天，地点：${ctx.room}。她现在${describeMood(mood)}；${moodTone(mood)}。她记得：${memoryText(6) || "暂无"}。今天发生的剧情：${todayPlot || "无特别事件"}。只输出正文。`;
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
      await logLlm({ agent: "writing", ok: true, ms: now() - t0, prompt, response: res.text });
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
    const order = idle ? ["plot", "bg", "scene"] : ["plot"];
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
      lastSnapshot = (await backend.getKV("life_snapshot").catch(() => undefined)) || null;
      lastPlotDay = (await backend.getKV("last_plot_day")) ?? -1;
      dailyPlots = (await backend.getKV("daily_plots")) || {};
      const storedPlots = (await backend.getKV("plots")) || [];
      const roomSet = new Set((scene.rooms || []).map((r) => r.id));
      const actRooms = createActRoomMap(scene.hotspots || []);
      const fixPlan = (p) => {
        if (!p) return p;
        const actPlace = p.act ? roomForAct(actRooms, p.act, p.place) : null;
        if (p.act && !actPlace) p.act = null;
        if (actPlace) p.place = actPlace;
        p.behaviors = normalizeBehaviors(p.behaviors || [], {
          rooms: roomSet,
          hotspots: scene.hotspots || [],
          fallbackPlace: p.place || scene.start,
        });
        return p;
      };
      for (const p of Object.values(dailyPlots)) fixPlan(p);
      for (const p of storedPlots) fixPlan(p);
      await backend.setKV("daily_plots", dailyPlots).catch(() => {});
      await backend.setKV("plots", storedPlots).catch(() => {});
      mood = (await backend.getKV("mood")) || mood;
      store.patch({ mood: { ...mood } });

      postLife({
        type: "init",
        scene: sceneSummary(),
        day: lastSnapshot?.day ?? day ?? 1,
        minute: lastSnapshot?.minute ?? minute ?? config.life?.startMinute ?? 8 * 60,
        snapshot: lastSnapshot,
        timeScale: config.life?.timeScale ?? 1,
        tickMs: config.life?.tickMs ?? 1000,
        roamMin: config.life?.roamMin ?? 30,
        thoughtMin: config.life?.thoughtMin ?? 240,
        llm: config.llm || null,
      });
      postLife({ type: "setMood", mood: { ...mood } });
      const plan = dailyPlots[lastSnapshot?.day ?? day ?? 1];
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
    setSpeed(value) {
      const v = Math.max(0.5, Math.min(30, Number(value) || 1));
      postLife({ type: "setSpeed", timeScale: v });
    },
    trigger(kind, act) {
      if (kind === "memory") {
        void maybeMemory(true);
        return;
      }
      if (kind === "map") {
        void maybeMap(act || "home");
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
    async getMaps() {
      return (await backend.getKV("generated_maps")) || [];
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
    setQuota(bytes) {
      quota = bytes;
      enforceQuota();
    },
  };
}
