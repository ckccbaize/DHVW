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
import { createRemoteMemory } from "./core/memory/remote.js";
import { createQqBridge, createQqWorldAdapter } from "./runtime/qq-bridge.js";
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
  display: { backToOverviewMs: 0, hostLostGraceMs: 10000, hysteresisMs: 20000 },
  present: { url: "" },
  scene: "home",
  forgeIntervalMs: 45000,
  llm: { baseUrl: "", apiKey: "", model: "", reasoningEffort: "none" },
  qqBot: { enabled: false, bridgeWsUrl: "ws://127.0.0.1:8088/qq/ws", proactive: true },
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
            auto = {
              baseUrl: data.baseUrl || "",
              apiKey: data.apiKey || "",
              model: data.model || "",
              reasoningEffort: data.reasoningEffort || "none",
            };
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
      qqBot: { ...DEFAULTS.qqBot, ...(raw.qqBot || {}) },
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
  const ids = new Set();
  try {
    const res = await fetch("manifest.json", { cache: "no-store" });
    if (res.ok) {
      const manifest = await res.json();
      for (const file of manifest.files || []) {
        const m = /^assets\/scenes\/([^/]+)\/\1\.built\.json$/.exec(String(file.path || ""));
        if (m && m[1] !== "office") ids.add(m[1]);
      }
    }
  } catch {}
  try {
    const cache = await caches.open("dhvw-scenes-v1");
    for (const req of await cache.keys()) {
      const m = /\/assets\/scenes\/([^/]+)\/\1\.built\.json$/.exec(new URL(req.url).pathname);
      if (m && m[1] !== "office") ids.add(m[1]);
    }
  } catch {}
  return ids.size;
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
  const hostPresentInfo = { olvtPort: 0, gatewayPort: 0, presentUrl: "" };
  let overview = createOverview({ canvas: $("#scene"), scene, store });
  let awayPlace = null;
  let awayAct = null;
  let placeToken = 0;
  let queuedHomeIntent = null;
  let homePos = null;
  const EXTERNAL_ACT_ALIASES = {
    read: ["read_here", "browse_stacks", "skim_periodicals"],
    read_here: ["read", "browse_stacks"],
    sit: ["sit_chair", "sit_window", "rest_armchair"],
    rest: ["rest_armchair", "sit_chair"],
    write: ["long_table_work", "study_session"],
    study: ["study_session", "long_table_work"],
    browse: ["browse_stacks", "skim_periodicals"],
  };
  function externalHotspot(nextScene, act) {
    const hotspots = nextScene.hotspots || [];
    const exact = hotspots.find((h) => h.act === act);
    if (exact) return exact;
    for (const alias of EXTERNAL_ACT_ALIASES[act] || []) {
      const hit = hotspots.find((h) => h.act === alias);
      if (hit) return hit;
    }
    return null;
  }
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
  document.addEventListener("visibilitychange", () => {
    // 页面挂起期间 rAF 不走，恢复后不能把“没动”误判成卡住并拉黑目标点。
    walkStuck = { px: null, py: null, since: 0 };
  });
  let refusedCount = 0;
  let lastEvent = null;
  let lastLocalMotionAt = 0;
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
      if (ev.kind === "interaction_end" || ev.kind === "act" || ev.kind === "enter") lastLocalMotionAt = performance.now();
      if (store.state.conn === "up") void flushEvents();
      if (ev.kind === "travel" && ev.payload?.to) {
        awayPlace = ev.payload.to;
        awayAct = ev.payload.act || null;
        queuedHomeIntent = null;
        void enterPlace(awayPlace, awayAct);
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

  const remoteMemory = createRemoteMemory({
    send: (m) => remote.send(m),
    timeoutMs: 350,
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

  function withArmParam(url) {
    if (!url) return url;
    try {
      const parsed = new URL(url);
      if (!parsed.searchParams.has("arm")) parsed.searchParams.set("arm", "1");
      return parsed.href;
    } catch {
      return url;
    }
  }

  function resolvePresentUrl() {
    const explicit = normalizePresentUrl(
      cfg.present?.url || cfg.host?.presentUrl || hostPresentInfo.presentUrl || "",
    );
    if (explicit) return withArmParam(explicit);
    const raw = cfg.host?.wsUrl || cfg.host?.probeUrl || "";
    if (!raw) return null;
    try {
      const u = new URL(raw);
      const httpProto = u.protocol === "wss:" || u.protocol === "https:" ? "https:" : "http:";
      if (/\/ws\//.test(u.pathname)) {
        const token = u.searchParams.get("token") || "";
        const q = token ? `?token=${encodeURIComponent(token)}&arm=1` : "?arm=1";
        return normalizePresentUrl(`${httpProto}//${u.host}/olvt/${q}`);
      }
      if (hostPresentInfo.olvtPort > 0) {
        return normalizePresentUrl(`${httpProto}//${u.hostname}:${hostPresentInfo.olvtPort}/?arm=1`);
      }
    } catch {
      return null;
    }
    return null;
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
      const coverPromise = transition.cover("正在唤醒显现服务…", 520);
      remote.send({ type: "world:stop" });
      remote.send({ type: "present:request", payload: { t: Date.now() } });

      const presentUrl = resolvePresentUrl();
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
      setPresentModeActive(true);
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
        setPresentModeActive(false);
        local.resume();
        remote.send({ type: "world:resume" });
        await transition.reveal(320);
        return;
      }
      store.patch({ display: "present" });
      displayChangedAt = performance.now();
      presentOpenedAt = displayChangedAt;
      store.emit("state", { display: "present", reason: "open" });
      await transition.reveal(460);
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
      setPresentModeActive(false);
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

  async function cacheSceneAssets(p, aliasId = "") {
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
    const targets = [...new Set([sceneId, String(aliasId || "").trim()].filter(Boolean))];
    for (const file of files) {
      const rel = String(file?.path || "").trim();
      if (!rel || rel.includes("..")) return false;
      const res = await fetch(assetUrl(rel), { cache: "no-store" });
      if (!res.ok) return false;
      const aliasBuilt = aliasId && rel.endsWith(".built.json") ? res.clone() : null;
      for (let i = 0; i < targets.length; i += 1) {
        await cache.put(`assets/scenes/${targets[i]}/${rel}`, i === targets.length - 1 ? res : res.clone());
      }
      // loadScene(placeId) 固定找 <placeId>.built.json；场景包文件名是 job id，需要别名副本。
      if (aliasBuilt) await cache.put(`assets/scenes/${aliasId}/${aliasId}.built.json`, aliasBuilt);
    }
    return true;
  }

  function clockIsForward(c) {
    if (!c || !Number.isFinite(c.day) || !Number.isFinite(c.minute)) return false;
    const cur = store.state.clock;
    if (!cur || !Number.isFinite(cur.day) || !Number.isFinite(cur.minute)) return true;
    return c.day > cur.day || (c.day === cur.day && c.minute > cur.minute);
  }

  let setQqBotBoost = () => {};
  let applyRemoteQqConfig = async () => {};
  let triggerRemoteQqRebind = async () => {};
  let pendingRemoteBoost = null;

  function handleRemoteMessage(msg) {
    const p = msg.payload || {};
    switch (msg.type) {
      case "hello": {
        if (Number.isFinite(p.t_server)) clock.setOffsetFromServer(p.t_server);
        if (p.world_tier) setTier(p.world_tier);
        if (p.agent) store.patch({ agentCard: p.agent });
        if (Number(p.olvt_port) > 0) hostPresentInfo.olvtPort = Number(p.olvt_port);
        if (Number(p.gateway_port) > 0) hostPresentInfo.gatewayPort = Number(p.gateway_port);
        if (p.present_url) hostPresentInfo.presentUrl = String(p.present_url);
        if (typeof p.boost === "boolean") {
          pendingRemoteBoost = p.boost;
          void setQqBotBoost(p.boost, { persist: true });
        }
        break;
      }
      case "state:overview": {
        const checksumScene = p.scene || p.world?.scene || null;
        const sameScene = !checksumScene || checksumScene === (scene.name || scene.id);
        const cx = Number(p.pos_checksum?.x);
        const cy = Number(p.pos_checksum?.y);
        if (sameScene && Number.isInteger(cx) && Number.isInteger(cy) && isWalkable(scene.grid, cx, cy)
          && agent.state === "idle" && performance.now() - lastLocalMotionAt > 5000) {
          const snapped = applyChecksum(agent, cx, cy);
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
      case "boost:config": {
        const enabled = Boolean(p.enabled);
        pendingRemoteBoost = enabled;
        void setQqBotBoost(enabled, { persist: true });
        break;
      }
      case "qqbot:config": {
        void applyRemoteQqConfig(p);
        break;
      }
      case "qqbot:rebind": {
        void triggerRemoteQqRebind();
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
      case "memory:result": {
        remoteMemory.handle(p);
        break;
      }
      case "scene:ready": {
        void (async () => {
          const req = await local.findSceneRequest(p).catch(() => null);
          const alias = String(req?.placeId || p.placeId || "").trim();
          const cached = await cacheSceneAssets(p, alias).catch((err) => {
            console.warn("[remote] 场景资源缓存失败", p.sceneId || p.job, err);
            return false;
          });
          if (!cached) {
            // 资源没落进 Cache Storage 就不能把请求标成 ready，否则会出现“已推送但没场景”。
            store.emit("scene_ready_failed", { ...p, placeId: alias || undefined, reason: "cache_failed" });
            return;
          }
          const ready = await local.markSceneReady(p).catch(() => null);
          const id = String(ready?.placeId || alias || p.sceneId || p.job || p.id || "").trim();
          if (!id) return;
          await local.addPlace({
            id,
            name: p.name || id,
            kind: p.kind === "street" ? "street" : "indoor",
            distance: p.distance,
            overnight: p.overnight === true,
          });
          store.patch({ sceneCount: await countScenePackages() });
          store.emit("scene_ready", { ...p, cached, placeId: id });
          if (awayPlace && (awayPlace === id || awayPlace === p.placeId || awayPlace === p.name || awayPlace === String(p.sceneId || ""))) {
            void enterPlace(awayPlace, awayAct);
          }
        })();
        break;
      }
      case "display:set": {
        if (Number(p.olvt_port) > 0) hostPresentInfo.olvtPort = Number(p.olvt_port);
        if (Number(p.gateway_port) > 0) hostPresentInfo.gatewayPort = Number(p.gateway_port);
        if (p.present_url) hostPresentInfo.presentUrl = String(p.present_url);
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

  async function enterPlace(name, act = null) {
    if (!name || name === (scene.name || scene.id)) return;
    if (!homePos) homePos = { gx: agent.gx, gy: agent.gy, px: agent.px, py: agent.py, dir: { ...agent.dir } };
    const token = ++placeToken;
    try {
      const next = await loadScene(name);
      if (token !== placeToken || awayPlace !== name) return;
      const nextOverview = createOverview({ canvas: $("#scene"), scene: next, store });
      await nextOverview.load();
      if (token !== placeToken || awayPlace !== name) return;
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
      // 外部场景也要执行计划里的动作：进门后走到对应热点，而不是只停在出生点。
      if (act) {
        const hot = externalHotspot(scene, act);
        if (hot) {
          const path = bfsPath(scene.grid, agent.gx, agent.gy, hot.x, hot.y);
          if (path && path.length) {
            moveTo(agent, path, { act });
            pendingArrival = { room: hot.room || name, act };
          } else if (path) {
            agent.state = "act";
            agent.act = act;
            agent.actTtl = 2;
          }
        }
      }
    } catch (err) {
      if (token !== placeToken) return;
      console.warn("[scene] 进入失败", name, err);
      const queued = await local.requestScene(name, "travel").catch(() => ({ ok: false }));
      // 场景还没生成：保留 awayPlace，等 scene:ready 后自动进入；否则回退到总观。
      if (!queued?.ok || queued.request?.status === "ready") {
        awayPlace = null;
        homePos = null;
      }
      store.emit("travel_failed", {
        place: name,
        error: String(err?.message || err),
        queued: Boolean(queued?.ok && queued.request?.status !== "ready"),
      });
    }
  }

  async function returnHome() {
    if (!awayPlace && scene === homeScene) return;
    const name = homeScene.name || homeScene.id || "home";
    const token = ++placeToken;
    try {
      if (scene !== homeScene) {
        const nextOverview = createOverview({ canvas: $("#scene"), scene: homeScene, store });
        await nextOverview.load();
        if (token !== placeToken) return;
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
      if (queuedHomeIntent) {
        const intent = queuedHomeIntent;
        queuedHomeIntent = null;
        handleIntent(intent);
      }
    } catch (err) {
      console.warn("[scene] 返回失败", name, err);
    } finally {
      if (token === placeToken) {
        awayPlace = null;
        awayAct = null;
        homePos = null;
      }
    }
  }

  function handleIntent(intent) {
    // 返回 home 的收尾是异步的：场景已经切回 home 时，不能再把计划意图丢掉。
    if (awayPlace && scene !== homeScene) {
      queuedHomeIntent = intent;
      return;
    }
    const { x, y, act, room } = intent;
    lastLocalMotionAt = performance.now();
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
  function setPresentModeActive(active) {
    document.body.classList.toggle("present-active", Boolean(active));
    if (active) {
      setDock(false);
      closeConsole();
    }
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
    if (document.body.classList.contains("present-active") || store.state.display === "present") return;
    if (e.target.closest("#dock") || e.target.closest("#consolePanel") || e.target.closest("#switch")) return;
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
    if (agent.state === "walk" || arrived) lastLocalMotionAt = now;
    if (arrived && pendingArrival) {
      local.arrived(pendingArrival.room || roomAt(agent.gx, agent.gy), pendingArrival.act);
      pendingArrival = null;
    }
    // 卡住保护：行走状态但位置长时间不动，取消路径并让 Worker 清 pending
    if (agent.state === "walk" && document.visibilityState === "visible") {
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
      present.tick(now, cfg.display.backToOverviewMs);
      // 主机丢失 >10s 强制回总观（§10.5）
      if (store.state.conn === "down" && hostLostAt && now - hostLostAt > cfg.display.hostLostGraceMs) {
        exitPresent("host_lost");
      }
    }

    // 20s 滞回：切态后不自动回退；仅在显式配置 backToOverviewMs > 0 时按无互动超时回总观
    if (cfg.display.backToOverviewMs > 0 && now - displayChangedAt > cfg.display.hysteresisMs) {
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

  // 可选开启：QQ 单聊多模态互动融合（仅由 PC 端设置/Boost 或 config.json qqBot.enabled 驱动，关闭零开销）
  const qqBoostPill = document.querySelector("#qqBoostPill");
  {
    const staticQqEnabled = cfg.qqBot?.enabled === true;
    const qqAdapter = createQqWorldAdapter({
      remoteMemory,
      getBrain: () => local.getBrainHandles(),
      ingestFacts: (facts) => local.ingestFacts(facts),
      isHostUp: () => store.state.conn === "up",
      sendToHost: (m) => remote.send(m),
      applyMoodDelta: (d) => local.applyMoodDelta(d),
      onBubble: (text, ttl) => overview.say(text, ttl),
      onAction: (act) => local.triggerAct(act),
      onEvent: (kind, payload) => local.recordExternalEvent(kind, payload),
      getEdgeMedia: () => local.getLatestBgDataUrl(),
      isSleeping: () => store.state.phase === "sleep",
    });

    let qqBridge = null;
    let qqSyncTimer = null;
    let qqEventsWired = false;
    let qqActive = false;

    const pushWorldState = () => {
      if (!qqBridge) return;
      qqBridge.send({
        type: "qq:world:state",
        payload: {
          day: store.state.clock?.day || 1,
          minute: store.state.clock?.minute || 480,
          phase: store.state.phase || "morning",
          weather: store.state.weather || "clear",
          place: awayPlace || scene.name || scene.id || "home",
          room: roomAt(agent.gx, agent.gy) || "",
          act: agent.act || agent.state || "idle",
          mood: store.state.mood || {},
          band: store.state.band || "calm",
          display: store.state.display || "overview",
          present: store.state.display === "present",
          recentNote: lastEvent?.payload?.text || lastEvent?.kind || "",
        },
      });
    };
    const pushLlmConfig = () => {
      if (!qqBridge || !cfg.llm) return;
      qqBridge.send({
        type: "qq:llm:config",
        payload: {
          baseUrl: cfg.llm.baseUrl || "",
          apiKey: cfg.llm.apiKey || "",
          model: cfg.llm.model || "",
          reasoningEffort: cfg.llm.reasoningEffort,
        },
      });
    };
    const updateHudPill = () => {
      if (!qqBoostPill) return;
      qqBoostPill.hidden = !qqActive;
      const st = store.state.qqStatus;
      const connected = !!st?.connected;
      qqBoostPill.classList.toggle("live", connected && !!st?.paired);
      qqBoostPill.textContent = connected
        ? st?.paired
          ? "BOOST · QQ在线"
          : "BOOST · 待激活"
        : "BOOST · QQ待连";
    };

    const handleQqStatus = (st) => {
      store.patch({ qqStatus: st });
      updateHudPill();
      if (store.state.conn === "up") remote.send({ type: "qqbot:status", payload: st });
    };

    const ensureQqStarted = async () => {
      if (qqActive) return;
      qqActive = true;
      updateHudPill();
      try {
        await fetch("/__qq/boost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        });
      } catch {}
      if (!qqActive) return;
      if (!qqBridge) {
        qqBridge = createQqBridge({
          url: cfg.qqBot?.bridgeWsUrl || "ws://127.0.0.1:8088/qq/ws",
          onOpen: () => {
            qqBridge.send({ type: "qq:boost:state", payload: { enabled: true } });
            pushLlmConfig();
            pushWorldState();
          },
          onStatus: handleQqStatus,
          onMemoryQuery: (q) => qqAdapter.handleMemoryQuery(q),
          onEdgeMedia: () => qqAdapter.handleEdgeMedia(),
          onFeedback: (fb) => qqAdapter.handleFeedback(fb),
        });
      }
      qqBridge.start();
      qqBridge.send({ type: "qq:boost:state", payload: { enabled: true } });
      if (!qqEventsWired) {
        qqEventsWired = true;
        store.on("llm_config", () => pushLlmConfig());
        store.on("writing", (w) => {
          if (qqActive) qqBridge?.send({ type: "qq:world:event", payload: { id: w.id, kind: "writing", summary: `写完了一篇${w.kind === "weekly" ? "周记" : w.kind === "diary" ? "日记" : "随笔"}`, ts: w.created_at } });
        });
        store.on("browse", (b) => {
          if (qqActive) qqBridge?.send({ type: "qq:world:event", payload: { id: b.id, kind: "browse", summary: b.result?.page?.title || b.plan?.query || "上网逛了一会儿", ts: b.created_at } });
        });
        store.on("asset", (a) => {
          if (qqActive && a.kind === "bg") {
            qqBridge?.send({ type: "qq:world:event", payload: { id: a.id, kind: "bg_ready", summary: "画了一张新的风景小图", ts: a.created_at } });
          }
        });
        store.on("event", (ev) => {
          if (qqActive && (ev.kind === "travel" || ev.kind === "return")) {
            qqBridge?.send({ type: "qq:world:event", payload: { id: ev.uuid, kind: ev.kind, summary: ev.payload?.to ? `去了${ev.payload.to}` : "刚回到家里", ts: ev.t_local } });
          }
        });
      }
      if (!qqSyncTimer) qqSyncTimer = setInterval(pushWorldState, 15_000);
    };

    const stopQq = () => {
      if (!qqActive) return;
      qqActive = false;
      if (qqSyncTimer) {
        clearInterval(qqSyncTimer);
        qqSyncTimer = null;
      }
      if (qqBridge) {
        qqBridge.send({ type: "qq:boost:state", payload: { enabled: false } });
        qqBridge.stop();
      }
      void fetch("/__qq/boost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }).catch(() => {});
      store.patch({ qqStatus: { connected: false } });
      updateHudPill();
    };

    const postQqConfig = async (payload) => {
      try {
        const res = await fetch("/__qq/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          const st = await res.json();
          handleQqStatus(st);
          return st;
        }
      } catch {}
      if (qqBridge?.connected) qqBridge.send({ type: "qq:bot:config", payload });
      return null;
    };

    const postQqRebind = async () => {
      try {
        const res = await fetch("/__qq/rebind", { method: "POST" });
        if (res.ok) {
          const st = await res.json();
          handleQqStatus(st);
          return st;
        }
      } catch {}
      if (qqBridge?.connected) qqBridge.send({ type: "qq:bot:rebind", payload: {} });
      return null;
    };

    applyRemoteQqConfig = async (payload) => {
      if (!payload || typeof payload !== "object") return;
      if (store.state.boost || staticQqEnabled || payload.appId) {
        await ensureQqStarted();
      }
      await postQqConfig({ ...payload, activate: store.state.boost || staticQqEnabled });
    };

    triggerRemoteQqRebind = async () => {
      await setQqBotBoost(true, { persist: true });
      await ensureQqStarted();
      await postQqRebind();
    };

    setQqBotBoost = async (enabled, { persist = false } = {}) => {
      const next = Boolean(enabled);
      store.patch({ boost: next });
      try { localStorage.setItem("dhvw_boost", next ? "1" : "0"); } catch {}
      if (persist) {
        const kv = local.getBrainHandles().backend;
        await kv?.setKV?.("qq_boost_enabled", next).catch(() => {});
      }
      if (next || staticQqEnabled) await ensureQqStarted();
      else stopQq();
    };

    void (async () => {
      const kv = local.getBrainHandles().backend;
      const savedBoost = await kv?.getKV?.("qq_boost_enabled").catch(() => undefined);
      const initial = pendingRemoteBoost !== null ? pendingRemoteBoost : (savedBoost === true || staticQqEnabled);
      await setQqBotBoost(initial);
    })();
  }

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
