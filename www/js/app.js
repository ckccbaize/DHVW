// 设备端启动与模式控制（M11-T1 设备侧口径 / PROJECT-PLAN §10.3）。
// 显示态：总观 ⇄ 显现；连接态：up/down；世界档位：idle/host/edge。

import { spawnPoint, bfsPath, isWalkable } from "./core/grid.js";
import { createAgent, moveTo, step, applyChecksum } from "./core/pathagent.js";
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

const DEFAULTS = {
  host: { wsUrl: "", probeUrl: "", ttsUrl: "" },
  life: { minutesPerSecond: 1, tickMs: 1000 },
  assetQuotaBytes: 500 * 1024 * 1024,
  display: { backToOverviewMs: 90000, hostLostGraceMs: 10000, hysteresisMs: 20000 },
  present: { url: "" },
  scene: "home",
  forgeIntervalMs: 45000,
  llm: { baseUrl: "", apiKey: "", model: "" },
};

const $ = (sel) => document.querySelector(sel);

async function loadConfig() {
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const raw = await res.json();
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem("dhvw_llm") || "null");
    } catch {
      saved = null;
    }
    return {
      ...DEFAULTS,
      ...raw,
      host: { ...DEFAULTS.host, ...(raw.host || {}) },
      life: { ...DEFAULTS.life, ...(raw.life || {}) },
      display: { ...DEFAULTS.display, ...(raw.display || {}) },
      present: { ...DEFAULTS.present, ...(raw.present || {}) },
      llm: { ...DEFAULTS.llm, ...(raw.llm || {}), ...(saved || {}) },
      scene: raw.scene || DEFAULTS.scene,
    };
  } catch {
    return DEFAULTS;
  }
}


async function boot() {
  const cfg = await loadConfig();
  const sceneName = new URLSearchParams(location.search).get("scene") || cfg.scene || "home";
  const scene = await loadScene(sceneName);

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
    stats: { fps: 0 },
  });

  const root = $("#app");
  const overview = createOverview({
    canvas: $("#scene"),
    scene,
    store,
    onCharacterClick: () => onSwitchRequest(store.state.display !== "present"),
    onMoveRequest: (x, y) => userMoveTo(x, y),
    onBubble: (text) => overview.say(text, 2600),
  });
  await overview.load();

  const present = createPresent({
    root: $("#present"),
    store,
    onExit: (reason) => exitPresent(reason),
  });

  const hud = createHud({ root, store });
  if (new URLSearchParams(location.search).get("perf") === "1") {
    createPerfOverlay({ getFps: () => overview.fps });
  }

  let displayChangedAt = 0;
  let presentOpenedAt = 0;
  let hostLostAt = 0;
  let lastInput = performance.now();
  let activity = "active";
  let pendingArrival = null;
  let refusedCount = 0;
  let lastEvent = null;
  let forgePaused = false;
  const bgUrls = new Map();

  const local = createLocalRuntime({
    store,
    scene,
    config: cfg,
    forgeIntervalMs: cfg.forgeIntervalMs,
    getOffset: () => clock.offsetMs,
    onIntent: (msg) => handleIntent(msg),
    onSay: (text, ttl) => {
      overview.say(text, ttl);
      store.emit("say", { text });
    },
    onEvent: (ev) => {
      lastEvent = ev;
      store.emit("event", ev);
    },
    onAsset: (meta) => handleAsset(meta),
    onSummary: (text) => overview.say(text, 6000),
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
      if (store.state.display === "present") exitPresent("switch");
      return true;
    }
    if (store.state.display === "present") return true;
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

  async function openPresent() {
    if (store.state.display === "present") return;
    const tts = await probeTts();
    const bg = await bestBackground();
    const presentUrl = normalizePresentUrl(cfg.present?.url || cfg.host?.presentUrl || "");
    if (presentUrl) {
      const probe = await probePresent(presentUrl);
      if (!probe.ok) {
        overview.say("显现页不可用，先留在总观", 3000);
        return;
      }
    }
    local.suspend();
    remote.send({ type: "world:stop" });
    remote.send({ type: "present:request", t: Date.now() });
    present.open({ backgroundUrl: bg, iframeUrl: presentUrl || "", live2d: false, tts });
    store.patch({ display: "present" });
    displayChangedAt = performance.now();
    presentOpenedAt = displayChangedAt;
    store.emit("state", { display: "present", reason: "open" });
  }

  function exitPresent(reason) {
    if (store.state.display !== "present") return;
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
    if (store.state.conn !== "up") return;
    const events = await local.drainEvents(200);
    if (!events.length) return;
    const ok = remote.send({ type: "events:batch", events });
    if (ok) await local.markSynced(events.map((e) => e.uuid));
  }

  function handleRemoteMessage(msg) {
    switch (msg.type) {
      case "hello": {
        if (Number.isFinite(msg.t_server)) clock.setOffsetFromServer(msg.t_server);
        if (msg.world_tier) setTier(msg.world_tier);
        if (msg.agent) store.patch({ agentCard: msg.agent });
        break;
      }
      case "state:overview": {
        if (msg.pos_checksum) {
          const snapped = applyChecksum(agent, msg.pos_checksum.x, msg.pos_checksum.y);
          if (snapped) store.emit("checksum", { snapped: true });
        }
        if (msg.work_tier) setTier(msg.work_tier);
        if (msg.clock) {
          clock.set(msg.clock.day, msg.clock.minute);
          local.syncClock(msg.clock.day, msg.clock.minute);
        }
        if (msg.agent) store.patch({ agentCard: msg.agent });
        break;
      }
      case "moveTo": {
        if (Array.isArray(msg.path) && msg.path.length) {
          moveTo(agent, msg.path, { act: msg.act || null });
          pendingArrival = { room: msg.room || null, act: msg.act || null };
        }
        break;
      }
      case "say": {
        overview.say(msg.text, msg.ttl || 2600);
        if (present.isOpen) present.say(msg.text);
        break;
      }
      case "tier": {
        setTier(msg.value);
        break;
      }
      case "present:deny": {
        exitPresent("deny");
        overview.say(msg.reason || "主机现在不方便", 3000);
        break;
      }
      case "switchScene": {
        // 单场景资源包：不切图，只记日志（多场景待 M6-T11 模板集）
        store.emit("switchScene", msg);
        break;
      }
      default:
        break;
    }
  }

  // ---------- 移动 ----------

  function handleIntent({ x, y, act, room }) {
    const path = bfsPath(scene.grid, agent.gx, agent.gy, x, y);
    if (path === null) {
      local.intentFailed();
      return;
    }
    if (path.length === 0) {
      local.arrived(room, act);
      return;
    }
    moveTo(agent, path, { act });
    pendingArrival = { room, act };
  }

  function userMoveTo(x, y) {
    const path = bfsPath(scene.grid, agent.gx, agent.gy, x, y);
    if (path === null || path.length === 0) {
      overview.say("那边过不去。", 1800);
      return false;
    }
    moveTo(agent, path, { act: null });
    pendingArrival = { room: roomAt(x, y), act: null };
    return true;
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
      overview.say("写了一段小东西。", 2200);
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

  const menu = $("#menu");
  $("#btnPauseForge").addEventListener("click", () => {
    forgePaused = !forgePaused;
    $("#btnPauseForge").textContent = forgePaused ? "恢复端侧生成" : "暂停端侧生成";
    if (forgePaused) local.suspend();
    else local.resume();
  });
  $("#btnReconnect").addEventListener("click", () => {
    remote.stop();
    remote.start();
    overview.say("正在重连主机…", 1800);
  });
  $("#btnCloseMenu").addEventListener("click", () => hud.toggleMenu(false));
  menu.addEventListener("click", (e) => {
    if (e.target === menu) hud.toggleMenu(false);
  });

  // ---------- 主循环 ----------

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.25);
    last = now;

    const arrived = step(agent, dt);
    if (arrived && pendingArrival) {
      local.arrived(pendingArrival.room || roomAt(agent.gx, agent.gy), pendingArrival.act);
      pendingArrival = null;
    }

    overview.draw(now);
    hud.setFps(overview.fps);
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
  local.setTier("edge");
  setTier("edge");
  remote.start();

  store.patch({ light: lightFor("morning", "clear") });
  store.on("tick", (t) => {
    store.patch({ light: lightFor(t.phase, t.weather) });
  });

  setInterval(() => {
    void local.persistClock(clock.day, clock.minute);
    if (store.state.conn === "up") void flushEvents();
  }, 60000);

  requestAnimationFrame(frame);

  // 调试页保存 LLM 配置后，主页面自动重载
  try {
    const ch = new BroadcastChannel("dhvw-debug");
    ch.onmessage = (e) => {
      if (e.data === "llm-updated") location.reload();
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
    moveToCell: userMoveTo,
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
