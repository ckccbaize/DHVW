import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshotStore, createMemorySnapshotStore, validateSnapshot } from "../www/js/core/snapshot.js";
import { createWorldRuntime } from "../www/js/core/machine/world.js";
import { createLifeRuntime } from "../www/js/core/machine/life.js";

const makeSnap = () => ({
  v: 1,
  ts: 12345,
  lastSeq: 7,
  world: { display: "overview", conn: "up", tier: "host", illegal: 0 },
  life: { minute: 720, phase: "noon", band: "calm", mood: { energy: 0.6, valence: 0.5, social: 0.4, focus: 0.5 }, recent: [{ act: "cook", minute: 700 }], moodLog: [] },
});

test("内存快照存储：save/load/clear", async () => {
  const store = createMemorySnapshotStore();
  assert.equal(await store.load(), null);
  const snap = makeSnap();
  await store.save(snap);
  assert.deepEqual(await store.load(), snap);
  await store.clear();
  assert.equal(await store.load(), null);
});

test("IndexedDB 快照存储：save/load/clear（假 db）", async () => {
  const rows = new Map();
  const req = (fn) => {
    const r = {};
    setTimeout(() => {
      try {
        r.result = fn();
        r.onsuccess && r.onsuccess();
      } catch (e) {
        r.error = e;
        r.onerror && r.onerror();
      }
    }, 0);
    return r;
  };
  const fakeStore = {
    put: (row) => req(() => void rows.set(row.k, row)),
    get: (k) => req(() => rows.get(k)),
    delete: (k) => req(() => void rows.delete(k)),
  };
  const fakeDb = { transaction: () => ({ objectStore: () => fakeStore }) };
  const store = createSnapshotStore(fakeDb);
  const snap = makeSnap();
  await store.save(snap);
  assert.deepEqual(await store.load(), snap);
  await store.clear();
  assert.equal(await store.load(), null);
});

test("validateSnapshot：坏快照返回 null", () => {
  assert.equal(validateSnapshot(null), null);
  assert.equal(validateSnapshot({}), null);
  assert.equal(validateSnapshot({ ...makeSnap(), v: 2 }), null);
  assert.equal(validateSnapshot({ ...makeSnap(), ts: "x" }), null);
  assert.equal(validateSnapshot({ ...makeSnap(), world: null }), null);
  assert.ok(validateSnapshot(makeSnap()));
});

test("恢复：世界状态机从快照回到原态", () => {
  const rt = createWorldRuntime();
  rt.dispatch({ type: "HOST_UP" });
  rt.dispatch({ type: "WORLD_START" });
  const snap = { ...rt.state };
  const rt2 = createWorldRuntime();
  rt2.reset(snap);
  assert.deepEqual(rt2.state, snap);
});

test("恢复：坏世界快照抛错（调用方回退）", () => {
  const rt = createWorldRuntime();
  assert.throws(() => rt.reset({ display: "x", conn: "up", tier: "idle", illegal: 0 }), /display/);
});

test("恢复：生活状态 minute/mood/recent", () => {
  const life = createLifeRuntime({ minute: 480 });
  life.advance(240);
  life.applyMood({ valence: 0.2 }, { source: "wake", reason: "梦" });
  life.noteAct("cook");
  const snap = life.snapshot();

  const life2 = createLifeRuntime();
  life2.restore(snap);
  assert.equal(life2.minute, 720);
  assert.equal(life2.phase, "noon");
  assert.ok(Math.abs(life2.mood.valence - snap.mood.valence) < 1e-9);
  assert.deepEqual(life2.snapshot().recent, snap.recent);
});

test("完整往返：save → load → 两机一致", async () => {
  const store = createMemorySnapshotStore();
  const world = createWorldRuntime();
  const life = createLifeRuntime({ minute: 600 });
  world.dispatch({ type: "HOST_UP" });
  life.advance(120);
  await store.save({ v: 1, ts: 1, lastSeq: 3, world: world.state, life: life.snapshot() });

  const loaded = validateSnapshot(await store.load());
  const world2 = createWorldRuntime();
  const life2 = createLifeRuntime();
  world2.reset(loaded.world);
  life2.restore(loaded.life);
  assert.deepEqual(world2.state, world.state);
  assert.equal(life2.minute, life.minute);
  assert.deepEqual(life2.mood, life.mood);
});
