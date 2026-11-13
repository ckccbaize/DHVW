import test from "node:test";
import assert from "node:assert/strict";

import { createRemoteRuntime } from "../www/js/runtime/remote.js";
import { createLocalRuntime } from "../www/js/runtime/local.js";
import { createStore } from "../www/js/core/lifestore.js";
import { parseIntGrid } from "../www/js/core/grid.js";

// ---------------- RemoteRuntime ----------------

class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.instances.push(this);
  }
  send(s) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.onclose && this.onclose();
  }
  open() {
    this.readyState = 1;
    this.onopen && this.onopen();
  }
  msg(obj) {
    this.onmessage && this.onmessage({ data: JSON.stringify(obj) });
  }
}

function manualTimers() {
  const intervals = [];
  return {
    setIntervalImpl: (fn) => {
      intervals.push(fn);
      return intervals.length;
    },
    clearIntervalImpl: () => {},
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
    tick: () => intervals.forEach((fn) => fn()),
  };
}

test("RemoteRuntime：无主机地址 → 直接 down，不建连", () => {
  const conns = [];
  const rt = createRemoteRuntime({ url: "", onConn: (c) => conns.push(c), WSImpl: FakeWS });
  FakeWS.instances = [];
  rt.start();
  assert.equal(rt.conn, "down");
  assert.deepEqual(conns, ["down"]);
  assert.equal(FakeWS.instances.length, 0);
  rt.stop();
});

test("RemoteRuntime：WS 打开 → up，发 hello；心跳超时 → down", () => {
  FakeWS.instances = [];
  const conns = [];
  const msgs = [];
  let now = 1_000_000;
  const timers = manualTimers();
  const rt = createRemoteRuntime({
    url: "ws://host:8877/dhvw",
    heartbeatMs: 5000,
    timeoutMs: 60000,
    onConn: (c) => conns.push(c),
    onMessage: (m) => msgs.push(m),
    WSImpl: FakeWS,
    now: () => now,
    ...timers,
  });
  rt.start();
  const ws = FakeWS.instances[0];
  assert.ok(ws, "应创建 WS");
  ws.open();
  assert.equal(rt.conn, "up");
  assert.equal(ws.sent[0].type, "hello");

  ws.msg({ type: "state:overview", payload: { work_tier: "host" } });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].payload.work_tier, "host");

  // 未超时：心跳只发不判死
  now += 5000;
  timers.tick();
  assert.equal(rt.conn, "up");
  assert.equal(ws.sent.filter((m) => m.type === "heartbeat").length, 1);

  // 超时：判不可达
  now += 70000;
  timers.tick();
  assert.equal(rt.conn, "down");
  rt.stop();
});

test("RemoteRuntime：send 只在 open 状态生效", () => {
  FakeWS.instances = [];
  const rt = createRemoteRuntime({ url: "ws://h/x", WSImpl: FakeWS, ...manualTimers() });
  rt.start();
  const ws = FakeWS.instances[0];
  assert.equal(rt.send({ type: "ping" }), false);
  ws.open();
  assert.equal(rt.send({ type: "ping" }), true);
  rt.stop();
});

// ---------------- LocalRuntime ----------------

class FakeWorker {
  static instances = [];
  constructor(url) {
    this.url = String(url);
    this.posted = [];
    FakeWorker.instances.push(this);
  }
  postMessage(m) {
    this.posted.push(m);
  }
  terminate() {}
  emit(m) {
    this.onmessage && this.onmessage({ data: m });
  }
  has(type) {
    return this.posted.some((m) => m.type === type);
  }
  last(type) {
    return [...this.posted].reverse().find((m) => m.type === type);
  }
}

const scene = {
  grid: { ...parseIntGrid(["1111", "1001", "1001", "1111"]), cell: 16 },
  rooms: [{ id: "living", rect: [1, 1, 2, 2] }],
  props: [],
  doors: [],
  start: "living",
  hotspots: [{ x: 1, y: 1, act: "rest", room: "living" }],
  image2xUrl: "assets/scenes/home/home@2x.png",
};

function makeLocal(overrides = {}) {
  FakeWorker.instances = [];
  const store = createStore({ clock: null, assets: { scene: 0, plot: 0, bg: 0 } });
  const seen = { intents: [], says: [], events: [], assets: [], summaries: [] };
  let now = 10_000_000;
  const local = createLocalRuntime({
    store,
    scene,
    config: { life: { minutesPerSecond: 1, tickMs: 1000 } },
    WorkerImpl: FakeWorker,
    idbFactory: undefined,
    now: () => now,
    getOffset: () => 5000,
    onIntent: (m) => seen.intents.push(m),
    onSay: (t) => seen.says.push(t),
    onEvent: (e) => seen.events.push(e),
    onAsset: (a) => seen.assets.push(a),
    onSummary: (t) => seen.summaries.push(t),
    ...overrides,
  });
  return { local, store, seen, setNow: (v) => (now = v), getNow: () => now };
}

test("LocalRuntime：start 初始化两个 Worker，tick 更新时钟", async () => {
  const { local, store, setNow } = makeLocal();
  await local.start();
  const life = FakeWorker.instances.find((w) => w.url.includes("life.worker"));
  const forge = FakeWorker.instances.find((w) => w.url.includes("forge.worker"));
  assert.ok(life && forge, "应创建 life/forge 两个 Worker");
  assert.equal(life.last("init").scene.grid.w, 4);
  assert.equal(forge.last("init").homeUrl.includes("home@2x.png"), true);

  life.emit({ type: "tick", day: 2, minute: 600, phase: "noon", weather: "rain", room: "living" });
  assert.deepEqual(store.state.clock, { day: 2, minute: 600, offsetMs: 5000, source: "device" });
  assert.equal(store.state.phase, "noon");
  local.stop();
});

test("LocalRuntime：intent/say 转发，事件补 t_corrected 并入缓冲", async () => {
  const { local, seen } = makeLocal();
  await local.start();
  const life = FakeWorker.instances.find((w) => w.url.includes("life.worker"));

  life.emit({ type: "intent", x: 2, y: 2, act: "rest", room: "living" });
  assert.equal(seen.intents.length, 1);

  life.emit({ type: "say", text: "把窗开了一条缝。", ttl: 2600 });
  assert.deepEqual(seen.says, ["把窗开了一条缝。"]);

  life.emit({ type: "event", ev: { uuid: "u1", src: "device", t_local: 1000, kind: "enter", payload: {} } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.events[0].t_corrected, 6000);
  const drained = await local.drainEvents(10);
  assert.equal(drained.length, 1);
  assert.equal(drained[0].uuid, "u1");
  local.stop();
});

test("LocalRuntime：资产落库并计数，配额淘汰 edge", async () => {
  const { local, store, seen } = makeLocal();
  await local.start();
  const forge = FakeWorker.instances.find((w) => w.url.includes("forge.worker"));

  forge.emit({
    type: "asset",
    asset: { id: "bg-1", kind: "bg", tier: "edge", origin: "forge-procedural", seed: 1, size: 100, created_at: 1, blob: new Blob(["x"]) },
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.state.assets.bg, 1);
  assert.equal(seen.assets.length, 1);
  assert.equal((await local.listAssets()).length, 1);

  local.setQuota(10); // 立刻淘汰
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await local.listAssets()).length, 0);
  assert.equal(store.state.assets.bg, 0);
  local.stop();
});

test("LocalRuntime：端侧档产资产，活跃期只产剧情", async () => {
  const { local, setNow } = makeLocal();
  await local.start();
  const forge = FakeWorker.instances.find((w) => w.url.includes("forge.worker"));
  const life = FakeWorker.instances.find((w) => w.url.includes("life.worker"));

  const tick = { type: "tick", day: 1, minute: 600, phase: "noon", weather: "clear", room: "living" };

  // 活跃期：只产剧情
  local.setTier("edge");
  life.emit(tick);
  assert.equal(forge.has("enqueue"), true);
  assert.equal(forge.last("enqueue").kind, "plot");

  // 空闲期：继续产
  local.setActivity("idle");
  setNow(20_000_000);
  life.emit(tick);
  assert.equal(forge.posted.filter((m) => m.type === "enqueue").length, 2);
  const enq = forge.last("enqueue");
  assert.ok(["plot", "bg", "scene"].includes(enq.kind));
  assert.equal(enq.ctx.light, "day");

  // 主机档：不产
  local.setTier("idle");
  setNow(40_000_000);
  life.emit(tick);
  assert.equal(forge.posted.filter((m) => m.type === "enqueue").length, 2);
  local.stop();
});

test("LocalRuntime：suspend/resume 传给两个 Worker", async () => {
  const { local } = makeLocal();
  await local.start();
  local.suspend();
  local.resume();
  for (const w of FakeWorker.instances) {
    assert.equal(w.has("suspend"), true);
    assert.equal(w.has("resume"), true);
  }
  local.stop();
});
