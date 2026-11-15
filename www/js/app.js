// 设备端启动与模式控制（M11-T1 设备侧口径 / PROJECT-PLAN §10.3）。
// 显示态：总观 ⇄ 显现；连接态：up/down；世界档位：idle/host/edge。

import { spawnPoint, bfsPath, isWalkable } from "./core/grid.js";
import { createAgent, moveTo, step, applyChecksum, placeAt } from "./core/pathagent.js";
import { createStore } from "./core/lifestore.js";
import { createClock } from "./core/clock.js";
import { lightFor } from "./core/light.js";
import { pickAsset } from "./core/assetstore.js";
import { createRemoteRuntime } from "./runtime/remote.js";
import { createLocalRuntime } from "./runtime/local.js";
import { createOverview } from "./view/overview.js";
import { createPresent } from "./view/present.js";
import { createHud } from "./view/hud.js";
import { createSwitch, createSwitchSource } from "./view/switch.js";
import { loadScene } from "./view/scene-loader.js";
import { createPerfOverlay } from "./view/perf-overlay.js";
import { normalizePresentUrl, probePresent } from "./view/present-host.js";
import { createBlockTransition } from "./view/transition.js";

const DEFAULTS = {
  host: { wsUrl: "", probeUrl: "", ttsUrl: "" },
  life: { timeScale: 1, tickMs: 1000, roamMin: 30 },
  assetQuotaBytes: 500 * 1024 * 1024,
  display: { backToOverviewMs: 90000, hostLostGraceMs: 10000, hysteresisMs: 20000 },
  present: { url: "" },
  scene: "home",
  forgeIntervalMs: 45000,
  llm: { baseUrl: "", apiKey: "", model: "" },
};

const $ = (sel) => document.querySelector(sel);
const HOST_KEY = "dhvw_host";

/** 从 WS 地址推导 HTTP 探活地址：网关走 /orchestrator/health，直连走 /health。 */
function probeUrlFor(wsUrl) {
  try {
    const u = new URL(wsUrl);
    u.protocol = u.protocol === "wss:" ? "https:" : "http:";
    u.pathname = u.pathname.startsWith("/ws/orchestrator") ? "/orchestrator/health" : "/health";
    return u.toString();
  } catch {
    return "";
  }
}

function readSavedHost() {
  try {
    const saved = JSON.parse(localStorage.getItem(HOST_KEY) || "null");
    if (saved && typeof saved.wsUrl === "string" && saved.wsUrl) return saved;
  } catch {
    /* 旧数据损坏时忽略 */
  }
  return null;
}

async function loadConfig() {
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const raw = await res.json();
    const hostParam = new URLSearchParams(location.search).get("host");
    if (hostParam) {
      raw.host = { ...(raw.host || {}), wsUrl: hostParam, probeUrl: probeUrlFor(hostParam) };
      try {
        localStorage.setItem(HOST_KEY, JSON.stringify(raw.host));
      } catch {
        /* 隐私模式/配额满时只影响本次连接 */
      }
    } else if (!raw.host?.wsUrl) {
      // kiosk 固定打开 127.0.0.1:8080，不带 ?host=；用上次配对地址续连。
      const savedHost = readSavedHost();
      if (savedHost) raw.host = { ...(raw.host || {}), ...savedHost, probeUrl: savedHost.probeUrl || probeUrlFor(savedHost.wsUrl) };
    }
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem("dhvw_llm") || "null");
    } catch {
      saved = null;
    }
    const speed = Number(localStorage.getItem("dhvw_speed") || "0");
    const life = { ...DEFAULTS.life, ...(raw.life || {}) };
    if (speed > 0) life.timeScale = Math.max(0.5, Math.min(30, speed));
    let auto = null;
    if (!saved && !(raw.llm?.baseUrl && raw.llm?.model)) {
      try {
        const res = await fetch("/__llm/config", { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data?.ok) {
            auto = { baseUrl: data.baseUrl || "", apiKey: data.apiKey || "", model: data.model || "" };
            if (String(auto.baseUrl).includes("codex.mintcat.work")) auto.reasoningEffort = "none";
          }
        }
      } catch {
        auto = null;
      }
    }
    return {
      ...DEFAULTS,
      ...raw,
      host: { ...DEFAULTS.host, ...(raw.host || {}) },
      life,
      display: { ...DEFAULTS.display, ...(raw.display || {}) },
      present: { ...DEFAULTS.present, ...(raw.present || {}) },
      llm: { ...DEFAULTS.llm, ...(raw.llm || {}), ...(auto || {}), ...(saved || {}) },
      scene: raw.scene || DEFAULTS.scene,
    };
  } catch {
    return DEFAULTS;
  }
}


/** 随包 NPC：固定随机池，办公室工位与总监座各取一位；使用素材首帧。 */
const NPC_POOL = [
  { id: "npc-1", name: "阿澄", image: "assets/npc/people_1.png" },
  { id: "npc-2", name: "小满", image: "assets/npc/people_2.png" },
  { id: "npc-3", name: "林岚", image: "assets/npc/people_3.png" },
  { id: "npc-4", name: "周野", image: "assets/npc/people_4.png" },
  { id: "npc-5", name: "苏禾", image: "assets/npc/people_5.png" },
  { id: "npc-6", name: "陈默", image: "assets/npc/people_6.png" },
  { id: "npc-7", name: "顾清", image: "assets/npc/people_boss.png" },
];

function npcOrder(seed) {
  const hash = (text) => {
    let h = 2166136261;
    for (const ch of String(text)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    return h >>> 0;
  };
  return [...NPC_POOL].sort((a, b) => hash(`${seed}:${a.id}`) - hash(`${seed}:${b.id}`));
}

function chairForDesk(desk, chairs) {
  return (
    chairs.find((c) => c.x === desk.x && c.y === desk.y + 1) ||
    chairs.find((c) => Math.abs(c.x - desk.x) <= 1 && Math.abs(c.y - desk.y) <= 2) ||
    desk
  );
}

function npcSprite(npc, chair, extra = {}) {
  return {
    x: chair.x,
    y: chair.y,
    dir: { x: 0, y: -1 },
    act: "idle",
    sheet: "assets/npc/npc_sheet.json",
    image: npc.image,
    npc: npc.id,
    label: npc.name,
    ...extra,
  };
}

/** 外层办公室：6 个工位 + 总监座，全部是坐着的随包 NPC。 */
function buildOfficeSprites(scene) {
  const desks = (scene.props || []).filter((p) => p.id === "desk_modern");
  const chairs = (scene.props || []).filter((p) => p.id === "office_chair");
  const order = npcOrder(scene.name || scene.id || "office");
  const sprites = desks.slice(0, 6).map((desk, i) =>
    npcSprite(order[i % order.length], chairForDesk(desk, chairs)),
  );
  const directorDesk = (scene.props || []).find((p) => p.id === "workdesk");
  if (directorDesk) {
    sprites.push(
      npcSprite(order[6], chairForDesk(directorDesk, chairs), {
        director: true,
        label: "总监",
      }),
    );
  }
  return sprites;
}

async function countScenePackages() {
  try {
    const res = await fetch("manifest.json", { cache: "no-store" });
    if (!res.ok) return 0;
    const manifest = await res.json();
    const ids = new Set();
    for (const file of manifest.files || []) {
      const m = /^assets\/scenes\/([^/]+)\/\1\.built\.json$/.exec(String(file.path || ""));
      if (m && m[1] !== "office") ids.add(m[1]);
    }
    return ids.size;
  } catch {
    return 0;
  }
}

async function boot() {
  const cfg = await loadConfig();
  const sceneParam = new URLSearchParams(location.search).get("scene") || cfg.scene || "home";
  let scene = await loadScene(sceneParam);
  const homeScene = scene;
  const outerScene = await loadScene("office");

  const [sx, sy] = spawnPoint(scene);
  const agent = createAgent(sx, sy);
  const clock = createClock({ day: 1, minute: cfg.life?.startMinute ?? 8 * 60 });

  const store = createStore({
    display: "overview",
    conn: "down",
    tier: "idle",
    light: "day",
    phase: "morning",
    weather: "clear",
    clock: { day: 1, minute: 8 * 60, offsetMs: 0, source: "device" },
    agent,
    agentCard: null,
    assets: { scene: 0, plot: 0, bg: 0 },
    sceneCount: 0,
    stats: { fps: 0 },
  });

  store.patch({ sceneCount: await countScenePackages() });
  const root = $("#app");
  const transition = createBlockTransition({
    root: $("#blockTransition"),
    canvas: $("#blockTransitionCanvas"),
    label: $("#blockTransitionLabel"),
  });
  let presentOpening = false;
  let presentCancelled = false;
  let presentExiting = false;
  let overview = createOverview({ canvas: $("#scene"), scene, store });
  let awayPlace = null;
  let homePos = null;
  const officeSprites = buildOfficeSprites(outerScene);
  const outerOverview = createOverview({
    canvas: $("#sceneOuter"),
    scene: outerScene,
    store,
    sprites: officeSprites,
    showAgent: false,
  });
  await Promise.all([overview.load(), outerOverview.load()]);

  const present = createPresent({
    root: $("#present"),
    store,
    onExit: (reason) => exitPresent(reason),
  });

  const hud = createHud({ root, store });
  if (new URLSearchParams(location.search).get("perf") === "1") {
    createPerfOverlay({ getFps: () => overview.fps });
  }

  let activeView = "inner";
  let displayChangedAt = 0;
  let presentOpenedAt = 0;
  let hostLostAt = 0;
  let lastInput = performance.now();
  let activity = "active";
  let pendingArrival = null;
  let walkStuck = { px: null, py: null, since: 0 };
  let refusedCount = 0;
  let lastEvent = null;
  let pendingEvents = [];
  let batchInFlight = false;
  const bgUrls = new Map();

  const local = createLocalRuntime({
    store,
    scene,
    config: cfg,
    forgeIntervalMs: cfg.forgeIntervalMs,
    getOffset: () => clock.offsetMs,
    onIntent: (msg) => handleIntent(msg),
    onSay: (text, ttl) => {
      if (store.state.phase === "sleep") return;
      overview.say(text, ttl);
      store.emit("say", { text });
    },
    onEvent: (ev) => {
      lastEvent = ev;
      if (store.state.conn === "up") void flushEvents();
      if (ev.kind === "travel" && ev.payload?.to) {
        awayPlace = ev.payload.to;
        void enterPlace(awayPlace);
      } else if (ev.kind === "return") {
        void returnHome();
      }
      store.emit("event", ev);
    },
    onAsset: (meta) => handleAsset(meta),
    onSummary: (text) => {
      if (store.state.phase !== "sleep") overview.say(text, 6000);
    },
    onQueue: (q) => store.emit("queue", q),
  });

  const remote = createRemoteRuntime({
    url: cfg.host.wsUrl,
    probeUrl: cfg.host.probeUrl,
    onMessage: (msg) => handleRemoteMessage(msg),
    onConn: (next, info) => handleConn(next, info),
    log: (m) => console.info("[remote]", m),
  });

  // ---------- 显示态 ----------

  function refusePresent() {
    refusedCount += 1;
    overview.say("主机不在，我听不见", 3000);
    store.emit("refused", { count: refusedCount, at: performance.now() });
  }

  function onSwitchRequest(next) {
    if (!next) {
      if (presentOpening) {
        presentCancelled = true;
        return true;
      }
      if (store.state.display === "present") void exitPresent("switch");
      return true;
    }
    if (store.state.display === "present" || presentOpening) return true;
    // 闸门 1（硬）：主机可达。不可达一律不进入，只出气泡（A15）
    if (store.state.conn !== "up") {
      refusePresent();
      return false;
    }
    void openPresent();
    return true;
  }

  async function probeTts() {
    if (!cfg.host.ttsUrl) return false;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 300);
      const res = await fetch(cfg.host.ttsUrl, { signal: ac.signal, cache: "no-store" });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function bestBackground() {
    const edge = pickAsset(await local.listAssets(), "bg");
    if (!edge) return null;
    if (bgUrls.has(edge.id)) return bgUrls.get(edge.id);
    const blob = await local.getAssetBlob(edge.id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    bgUrls.set(edge.id, url);
    return url;
  }

  async function waitForPresentReady(presentUrl, maxWaitMs = 45000) {
    const start = Date.now();
    let updatedHint = false;
    while (!presentCancelled && store.state.conn === "up") {
      const probe = await probePresent(presentUrl, { timeoutMs: 2000 });
      if (probe.ok) return probe;
      const elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) return probe;
      if (!updatedHint && elapsed >= 3000) {
        updatedHint = true;
        transition.setText("正在等待 OLVT 引擎就绪…");
      }
      await new Promise((r) => setTimeout(r, 800));
    }
    return { ok: false, reason: presentCancelled ? "cancelled" : "host_lost" };
  }

  async function openPresent() {
    if (store.state.display === "present" || presentOpening) return;
    presentOpening = true;
    presentCancelled = false;
    try {
      const coverPromise = transition.cover("正在唤醒显现服务…", 420);
      remote.send({ type: "world:stop" });
      remote.send({ type: "present:request", payload: { t: Date.now() } });

      const presentUrl = normalizePresentUrl(cfg.present?.url || cfg.host?.presentUrl || "");
      const [tts, bg] = await Promise.all([probeTts(), bestBackground(), coverPromise]);
      if (presentCancelled || store.state.conn !== "up") {
        remote.send({ type: "world:resume" });
        await transition.reveal(320);
        if (store.state.conn !== "up") overview.say("主机断开了，先留在总观", 3000);
        return;
      }

      if (presentUrl) {
        const probe = await waitForPresentReady(presentUrl, 45000);
        if (presentCancelled) {
          remote.send({ type: "world:resume" });
          await transition.reveal(320);
          return;
        }
        if (!probe.ok) {
          remote.send({ type: "world:resume" });
          await transition.reveal(320);
          overview.say(store.state.conn !== "up" ? "主机断开了，先留在总观" : "显现服务启动超时，先留在总观", 3000);
          return;
        }
      }

      transition.setText("正在加载显现面板…");
      local.suspend();
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const guard = setTimeout(done, 12000);
        present.open({
          backgroundUrl: bg,
          iframeUrl: presentUrl || "",
          live2d: false,
          tts,
          timeoutMs: 20000,
          onReady: () => {
            clearTimeout(guard);
            done();
          },
        });
      });
      if (presentCancelled) {
        present.close();
        local.resume();
        remote.send({ type: "world:resume" });
        await transition.reveal(320);
        return;
      }
      store.patch({ display: "present" });
      displayChangedAt = performance.now();
      presentOpenedAt = displayChangedAt;
      store.emit("state", { display: "present", reason: "open" });
      await transition.reveal(400);
    } finally {
      presentOpening = false;
    }
  }

  async function exitPresent(reason) {
    if (presentOpening) {
      presentCancelled = true;
      return;
    }
    if (store.state.display !== "present" || presentExiting) return;
    presentExiting = true;
    try {
      const isError = reason === "host_lost" || reason === "iframe_timeout" || reason === "iframe_error" || reason === "deny";
      if (isError) {
        transition.abort();
      } else {
        await transition.cover("正在返回总观…", 320);
      }
      present.close();
      store.patch({ display: "overview" });
      displayChangedAt = performance.now();
      presentOpenedAt = 0;
      local.resume();
      if (store.state.tier === "edge") local.setTier("edge");
      remote.send({ type: "world:resume" });
      if (reason === "host_lost") overview.say("主机断开了，我先回去", 3000);
      if (reason === "iframe_timeout" || reason === "iframe_error") overview.say("显现页加载失败，先回总观", 3000);
      store.emit("state", { display: "overview", reason });
      if (!isError) await transition.reveal(360);
    } finally {
      presentExiting = false;
    }
  }

  // ---------- 世界档位 ----------

  function setTier(next) {
    if (store.state.tier === next) return;
    store.patch({ tier: next });
    local.setTier(next);
    store.emit("state", { tier: next });
  }

  function handleConn(next, info) {
    const was = store.state.conn;
    store.patch({ conn: next });
    if (next === "down") {
      batchInFlight = false;
      pendingEvents = [];
      hostLostAt = performance.now();
      setTier("edge");
      if (was === "up") overview.say("主机断开了，我先自己过", 2600);
    } else {
      hostLostAt = 0;
      setTier("idle");
      local.resume();
      void flushEvents();
      if (was === "down") overview.say("主机回来了", 2200);
    }
    store.emit("state", { conn: next, reason: info && info.reason });
  }

  async function flushEvents() {
    if (store.state.conn !== "up" || batchInFlight) return;
    const events = await local.drainEvents(200);
    if (!events.length) return;
    const ok = remote.send({ type: "events:batch", payload: { events } });
    if (ok) {
      pendingEvents = events;
      batchInFlight = true;
    }
  }

  async function sendDigest() {
    if (store.state.conn !== "up") return;
    try {
      const digest = await local.buildDigest({ world: { pos_checksum: { x: agent.gx, y: agent.gy } } });
      remote.send({ type: "world:digest", payload: { digest } });
    } catch (err) {
      console.warn("[remote] digest 生成失败", err);
    }
  }

  function sendMood() {
    if (store.state.conn !== "up") return;
    remote.send({ type: "mood:state", payload: local.moodState() });
  }

  async function cacheSceneAssets(p) {
    const sceneId = String(p.sceneId || p.job || "").trim();
    const raw = cfg.host.wsUrl || cfg.host.probeUrl || "";
    const viaGateway = /\/ws\//.test(raw);
    const basePath = String((viaGateway && p.gatewayBasePath) || p.basePath || "").trim();
    if (!sceneId || !basePath || typeof caches === "undefined") return false;
    if (!raw) return false;
    let origin = "";
    let token = "";
    try {
      const u = new URL(raw);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      origin = u.origin;
      token = u.searchParams.get("token") || "";
    } catch {
      return false;
    }
    const base = new URL(basePath.replace(/\/$/, "") + "/", origin);
    const assetUrl = (rel) => {
      const u = new URL(rel, base);
      if (token) u.searchParams.set("token", token);
      return u;
    };
    const manifestRes = await fetch(assetUrl("manifest.json"), { cache: "no-store" });
    if (!manifestRes.ok) return false;
    const manifest = await manifestRes.json();
    const files = Array.isArray(manifest?.files) ? manifest.files : [];
    if (!files.length) return false;
    const cache = await caches.open("dhvw-scenes-v1");
    for (const file of files) {
      const rel = String(file?.path || "").trim();
      if (!rel || rel.includes("..")) return false;
      const res = await fetch(assetUrl(rel), { cache: "no-store" });
      if (!res.ok) return false;
      await cache.put(`assets/scenes/${sceneId}/${rel}`, res);
    }
    return true;
  }

  function clockIsForward(c) {
    if (!c || !Number.isFinite(c.day) || !Number.isFinite(c.minute)) return false;
    const cur = store.state.clock;
    if (!cur || !Number.isFinite(cur.day) || !Number.isFinite(cur.minute)) return true;
    return c.day > cur.day || (c.day === cur.day && c.minute > cur.minute);
  }

  function handleRemoteMessage(msg) {
    const p = msg.payload || {};
    switch (msg.type) {
      case "hello": {
        if (Number.isFinite(p.t_server)) clock.setOffsetFromServer(p.t_server);
        if (p.world_tier) setTier(p.world_tier);
        if (p.agent) store.patch({ agentCard: p.agent });
        break;
      }
      case "state:overview": {
        if (p.pos_checksum) {
          const snapped = applyChecksum(agent, p.pos_checksum.x, p.pos_checksum.y);
          if (snapped) store.emit("checksum", { snapped: true });
        }
        if (p.work_tier) setTier(p.work_tier);
        if (p.clock && clockIsForward(p.clock)) {
          clock.setForward(p.clock.day, p.clock.minute);
          local.syncClock(p.clock.day, p.clock.minute);
        }
        if (p.agent) store.patch({ agentCard: p.agent });
        break;
      }
      case "moveTo": {
        if (Array.isArray(p.path) && p.path.length) {
          moveTo(agent, p.path, { act: p.act || null });
          pendingArrival = { room: p.room || null, act: p.act || null };
        }
        break;
      }
      case "say": {
        overview.say(p.text, p.ttl || 2600);
        if (present.isOpen) present.say(p.text);
        break;
      }
      case "state:export": {
        void local.exportSave().then((save) => {
          if (!save) return;
          remote.send({ type: "state:save", payload: { save, reason: p.reason || "request" } });
        }).catch((err) => console.warn("[state] 导出失败", err));
        break;
      }
      case "state:restore": {
        if (!p.save) break;
        void local.importSave(p.save).then((res) => {
          remote.send({ type: "state:restore:ack", payload: { id: p.id || "", ...res } });
          setTimeout(() => {
            const url = new URL(location.href);
            if (res.scene && res.scene !== (scene.name || scene.id)) url.searchParams.set("scene", res.scene);
            location.replace(url.toString());
          }, 250);
        }).catch((err) => {
          remote.send({ type: "state:restore:ack", payload: { id: p.id || "", ok: false, error: err.message } });
          console.warn("[state] 恢复失败", err);
        });
        break;
      }
      case "tier": {
        setTier(p.value);
        break;
      }
      case "switchScene": {
        // 单场景资源包：不切图，只记日志（多场景待 M6-T11 模板集）
        store.emit("switchScene", p);
        break;
      }
      case "llm:config": {
        void local.setLlmConfig(p);
        break;
      }
      case "digest:get": {
        void sendDigest();
        break;
      }
      case "mood:get": {
        sendMood();
        break;
      }
      case "events:ack": {
        if (pendingEvents.length) {
          const done = pendingEvents;
          pendingEvents = [];
          batchInFlight = false;
          void local.markSynced(done.map((e) => e.uuid)).then(() => flushEvents());
        }
        break;
      }
      case "memory:facts": {
        void local.ingestFacts(Array.isArray(p.facts) ? p.facts : []).then((result) => {
          remote.send({ type: "facts:ack", payload: result, replyTo: msg.id });
        });
        break;
      }
      case "scene:ready": {
        void cacheSceneAssets(p).catch((err) => {
          console.warn("[remote] 场景资源缓存失败", p.sceneId || p.job, err);
          return false;
        }).then((cached) => {
          const id = String(p.sceneId || p.job || p.id || "").trim();
          if (!id) return;
          void local.addPlace({
            id,
            name: p.name || id,
            kind: p.kind === "street" ? "street" : "indoor",
            distance: p.distance,
            overnight: p.overnight === true,
          }).then((added) => {
            if (added?.added) store.patch({ sceneCount: (store.state.sceneCount || 0) + 1 });
          });
          store.emit("scene_ready", { ...p, cached });
        });
        break;
      }
      case "display:set": {
        if (p.state === "present") void onSwitchRequest(true);
        else if (p.state === "overview") void onSwitchRequest(false);
        break;
      }
      case "present:grant": {
        store.emit("present_grant", p);
        break;
      }
      case "present:deny": {
        exitPresent("deny");
        overview.say(p.reason || "主机现在不方便", 3000);
        break;
      }
      default:
        break;
    }
  }

  // ---------- 移动 ----------

  function cancelMovement() {
    agent.path = [];
    agent.state = "idle";
    agent.act = null;
    pendingArrival = null;
  }

  async function enterPlace(name) {
    if (!name || name === (scene.name || scene.id)) return;
    if (!homePos) homePos = { gx: agent.gx, gy: agent.gy, px: agent.px, py: agent.py, dir: { ...agent.dir } };
    try {
      const next = await loadScene(name);
      const nextOverview = createOverview({ canvas: $("#scene"), scene: next, store });
      await nextOverview.load();
      scene = next;
      overview = nextOverview;
      const [x, y] = spawnPoint(next);
      placeAt(agent, x, y);
      agent.path = [];
      agent.state = "idle";
      agent.act = null;
      agent.actTtl = 0;
      pendingArrival = null;
      store.patch({ scene: name });
      if (window.__dhvw) window.__dhvw.scene = scene;
    } catch (err) {
      console.warn("[scene] 进入失败", name, err);
      awayPlace = null;
      homePos = null;
      store.emit("travel_failed", { place: name, error: String(err?.message || err) });
    }
  }

  async function returnHome() {
    if (!awayPlace && scene === homeScene) return;
    const name = homeScene.name || homeScene.id || "home";
    try {
      if (scene !== homeScene) {
        const nextOverview = createOverview({ canvas: $("#scene"), scene: homeScene, store });
        await nextOverview.load();
        scene = homeScene;
        overview = nextOverview;
      }
      const pos = homePos || { gx: spawnPoint(homeScene)[0], gy: spawnPoint(homeScene)[1], px: null, py: null, dir: { x: 0, y: 1 } };
      placeAt(agent, pos.gx, pos.gy, pos.dir);
      if (Number.isFinite(pos.px) && Number.isFinite(pos.py)) {
        agent.px = pos.px;
        agent.py = pos.py;
      }
      agent.path = [];
      agent.state = "idle";
      agent.act = null;
      agent.actTtl = 0;
      pendingArrival = null;
      store.patch({ scene: name });
      if (window.__dhvw) window.__dhvw.scene = scene;
    } catch (err) {
      console.warn("[scene] 返回失败", name, err);
    } finally {
      awayPlace = null;
      homePos = null;
    }
  }

  function handleIntent({ x, y, act, room }) {
    if (awayPlace) return;
    const path = bfsPath(scene.grid, agent.gx, agent.gy, x, y);
    if (path === null) {
      // 新意图不可达时必须取消旧路径，否则旧路径到达会把房间/动作写错
      cancelMovement();
      local.intentFailed();
      return;
    }
    if (path.length === 0) {
      cancelMovement();
      local.arrived(room, act);
      return;
    }
    moveTo(agent, path, { act });
    pendingArrival = { room, act };
  }

  function roomAt(x, y) {
    for (const r of scene.rooms) {
      const [rx, ry, rw, rh] = r.rect;
      if (x >= rx && y >= ry && x < rx + rw && y < ry + rh) return r.id;
    }
    return null;
  }

  // ---------- 端侧资产 ----------

  function handleAsset(meta) {
    if (meta.kind === "bg" && present.isOpen && !present.usingIframe) {
      void bestBackground().then((url) => {
        if (url) present.open({ backgroundUrl: url, live2d: false, tts: false });
      });
    }
    if (meta.kind === "plot" && meta.text) {
      // 端侧剧情是"她写下的东西"，不是台词：只提示一句，全文留给她自己看
      store.emit("plot", meta);
      if (store.state.phase !== "sleep") overview.say("写了一段小东西。", 2200);
    }
  }

  // ---------- 交互 / 活跃度 ----------

  const markInput = () => {
    lastInput = performance.now();
    if (activity !== "active") {
      activity = "active";
      local.setActivity("active");
      document.body.classList.remove("asleep");
    }
  };
  for (const ev of ["pointerdown", "pointermove", "keydown", "wheel"]) {
    window.addEventListener(ev, markInput, { passive: true });
  }

  function activityTick(now) {
    const idle = now - lastInput;
    const level = idle > 600000 ? "asleep" : idle > 60000 ? "idle" : "active";
    if (level === activity) return;
    activity = level;
    local.setActivity(level);
    document.body.classList.toggle("asleep", level === "asleep");
    if (level === "asleep") local.requestSummary();
  }

  // ---------- 开关 ----------

  const sw = createSwitch({
    el: $("#switch"),
    knob: $("#switchKnob"),
    isOn: false,
    onRequest: (next) => onSwitchRequest(next),
  });
  createSwitchSource({
    kind: cfg.display.switchSource || "virtual",
    onChange: (on) => sw.request(on),
  });

  // ---------- 菜单 ----------

  const dock = $("#dock");
  const consolePanel = $("#consolePanel");

  function openConsole() {
    consolePanel.hidden = false;
  }
  function closeConsole() {
    consolePanel.hidden = true;
  }

  function hitOfficeSprite(clientX, clientY) {
    if (activeView !== "outer") return null;
    const canvas = $("#sceneOuter");
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const gx = ((clientX - rect.left) / rect.width) * outerScene.grid.w;
    const gy = ((clientY - rect.top) / rect.height) * outerScene.grid.h;
    let best = null;
    let bestD = 1.4;
    for (const sp of officeSprites) {
      const d = Math.hypot(gx - (sp.x + 0.5), gy - (sp.y + 0.5));
      if (d < bestD) {
        bestD = d;
        best = sp;
      }
    }
    return best;
  }

  function setDock(open) {
    dock.classList.toggle("open", open);
    dock.setAttribute("aria-hidden", open ? "false" : "true");
    document.body.classList.toggle("ui-open", open);
  }
  function setView(next) {
    activeView = next === "outer" ? "outer" : "inner";
    $("#scene").hidden = activeView !== "inner";
    $("#sceneOuter").hidden = activeView !== "outer";
    $("#btnViewInner").classList.toggle("active", activeView === "inner");
    $("#btnViewOuter").classList.toggle("active", activeView === "outer");
  }
  $("#btnViewInner").addEventListener("click", () => setView("inner"));
  $("#btnViewOuter").addEventListener("click", () => setView("outer"));
  $("#btnCloseConsole").addEventListener("click", closeConsole);

  // 触摸招出 UI；鼠标点击不触发任何角色行为
  const stage = $("#stage");
  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest("#dock") || e.target.closest("#consolePanel")) return;
    // 外层点击小人：总监打开生活控制台；其他 NPC 只唤出 dock。
    const sprite = hitOfficeSprite(e.clientX, e.clientY);
    if (sprite) {
      if (sprite.director) openConsole();
      else setDock(true);
      return;
    }
    // 其他位置鼠标/触摸只唤出 UI，不移动角色
    setDock(!dock.classList.contains("open"));
  });

  // ---------- 主循环 ----------

  let last = performance.now();
  let lastPosSave = 0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;

    const arrived = step(agent, dt);
    if (arrived && pendingArrival) {
      local.arrived(pendingArrival.room || roomAt(agent.gx, agent.gy), pendingArrival.act);
      pendingArrival = null;
    }
    // 卡住保护：行走状态但位置长时间不动，取消路径并让 Worker 清 pending
    if (agent.state === "walk") {
      const moved = walkStuck.px == null || Math.abs(agent.px - walkStuck.px) + Math.abs(agent.py - walkStuck.py) > 0.01;
      if (moved) walkStuck = { px: agent.px, py: agent.py, since: now };
      else if (now - walkStuck.since > 1500) {
        cancelMovement();
        local.intentFailed();
        walkStuck = { px: null, py: null, since: 0 };
      }
    } else {
      walkStuck = { px: null, py: null, since: 0 };
    }

    if (!awayPlace && now - lastPosSave > 1000) {
      lastPosSave = now;
      void local.persistAgentPos({
        scene: scene.name || scene.id,
        gx: agent.gx,
        gy: agent.gy,
        px: agent.px,
        py: agent.py,
        dir: agent.dir,
        room: roomAt(agent.gx, agent.gy),
      });
    }

    const view = activeView === "outer" ? outerOverview : overview;
    view.draw(now);
    hud.setFps(view.fps);
    activityTick(now);

    if (present.isOpen) {
      present.tick(now);
      // 主机丢失 >10s 强制回总观（§10.5）
      if (store.state.conn === "down" && hostLostAt && now - hostLostAt > cfg.display.hostLostGraceMs) {
        exitPresent("host_lost");
      }
    }

    // 20s 滞回：切态后不自动回退
    if (now - displayChangedAt > cfg.display.hysteresisMs) {
      // 90s 无互动回总观
      if (present.isOpen && present.idleMs > cfg.display.backToOverviewMs) exitPresent("idle");
    }

    requestAnimationFrame(frame);
  }

  // ---------- 启动 ----------

  store.subscribe((state) => hud.render(state));
  hud.render(store.state);

  await local.start();
  const savedPos = await local.getAgentPos();
  if (savedPos && savedPos.scene === (scene.name || scene.id) && Number.isInteger(savedPos.gx) && Number.isInteger(savedPos.gy) && isWalkable(scene.grid, savedPos.gx, savedPos.gy)) {
    placeAt(agent, savedPos.gx, savedPos.gy, savedPos.dir || agent.dir);
  }
  local.resume();
  local.setTier("edge");
  setTier("edge");
  remote.start();
  setInterval(() => {
    if (store.state.conn !== "up") return;
    void sendDigest();
    sendMood();
  }, 5000);
  // 每 5 分钟把整份存档交给 PC 留一份；PC 上线时还会主动 state:export。
  setInterval(() => {
    if (store.state.conn !== "up") return;
    void local.exportSave().then((save) => {
      if (save) remote.send({ type: "state:save", payload: { save, reason: "auto" } });
    }).catch(() => {});
  }, 300000);

  store.patch({ light: lightFor("morning", "clear") });
  store.on("tick", (t) => {
    store.patch({ light: lightFor(t.phase, t.weather) });
  });

  setInterval(() => {
    const c = store.state.clock;
    if (c) void local.persistClock(c.day, c.minute);
    if (store.state.conn === "up") void flushEvents();
  }, 60000);

  requestAnimationFrame(frame);

  // 调试页保存 LLM 配置后，主页面自动重载
  try {
    const ch = new BroadcastChannel("dhvw-debug");
    ch.onmessage = (e) => {
      if (e.data === "llm-updated") location.reload();
      else if (e.data?.type === "trigger") {
        local.trigger(e.data.kind, e.data.act);
        if (e.data.kind === "night") {
          local.trigger("plot");
          local.trigger("memory");
        }
      }
      else if (e.data?.type === "speed") local.setSpeed(e.data.value);
    };
  } catch {}

  // 调试/自动化入口（浏览器实测与验收脚本用）
  window.__dhvw = {
    store,
    agent,
    scene,
    local,
    remote,
    clock,
    config: cfg,
    refused: () => refusedCount,
    requestPresent: () => onSwitchRequest(true),
    exitPresent,
    moveToCell: () => false,
    lastEvent: () => lastEvent,
    isWalkable,
    forceConn: (v) => handleConn(v, { reason: "debug" }),
  };
}

boot().catch((err) => {
  console.error(err);
  const el = document.querySelector("#bootError");
  if (el) {
    el.hidden = false;
    el.textContent = `启动失败：${err.message}`;
  }
});
