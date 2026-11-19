// 远程生活控制台快照：PC 通过编排器 WS 发 console:snapshot，设备在这里读
// IndexedDB / localStorage 后回传。只在设备本机执行，PC 不直接读设备存储。

const DB_NAME = "dhvw";
const DB_VERSION = 2;
const LLM_KEY = "dhvw_llm";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("events")) {
        const st = db.createObjectStore("events", { keyPath: "uuid" });
        st.createIndex("t", "t_corrected");
      }
      if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets", { keyPath: "id" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getKV(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv", "readonly").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result ? req.result.v : undefined);
    req.onerror = () => reject(req.error);
  });
}

function getAll(db, store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readOverride() {
  try {
    return JSON.parse(localStorage.getItem(LLM_KEY) || "null");
  } catch {
    return null;
  }
}

async function readLlm() {
  let base = {};
  let auto = null;
  try {
    base = await fetch("config.json", { cache: "no-store" }).then((r) => r.json());
  } catch {}
  try {
    const res = await fetch("/__llm/config", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (data?.ok) auto = data;
    }
  } catch {}
  const saved = readOverride();
  const cfg = { ...(base.llm || {}), ...(auto || {}), ...(saved || {}) };
  return {
    baseUrl: String(cfg.baseUrl || ""),
    model: String(cfg.model || ""),
    source: saved ? "本机覆盖" : auto ? `本机 apikey：${auto.source || ""}` : "config.json",
  };
}

/** 收集 PC 控制台需要的数据；字段与 debug-life.html 保持一致。 */
export async function collectConsoleSnapshot() {
  const db = await openDb();
  const [
    llmLog,
    memory,
    writings,
    plots,
    sceneRequests,
    dailyPlots,
    mood,
    browses,
    desires,
    sudden,
    highlight,
    summary,
    events,
    llm,
    state,
    qq,
  ] = await Promise.all([
    getKV(db, "llm_log"),
    getKV(db, "memory_docs"),
    getKV(db, "writings"),
    getKV(db, "plots"),
    getKV(db, "scene_requests"),
    getKV(db, "daily_plots"),
    getKV(db, "mood"),
    getKV(db, "browse_log"),
    getKV(db, "desires"),
    getKV(db, "sudden_events"),
    getKV(db, "memory_highlight"),
    getKV(db, "memory_summary"),
    getAll(db, "events"),
    readLlm(),
    fetch("/__state", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch("/__qq/health", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  db.close();
  const ev = (events || []).slice().sort((a, b) => (a.t_corrected || 0) - (b.t_corrected || 0));
  return {
    ts: Date.now(),
    life: state?.life || null,
    qq: qq || null,
    speed: Number(localStorage.getItem("dhvw_speed") || "1"),
    llm,
    llmLog: (llmLog || []).slice(-80),
    memory: memory || [],
    writings: writings || [],
    plots: plots || [],
    sceneRequests: sceneRequests || [],
    dailyPlots: dailyPlots || {},
    mood: mood || null,
    browses: browses || [],
    desires: desires || [],
    sudden: sudden || [],
    highlight: highlight || null,
    summary: String(summary || ""),
    events: ev.slice(-120),
  };
}
