import test from "node:test";
import assert from "node:assert/strict";

import {
  INITIAL,
  createWorld,
  transition,
  snapshot,
  restore,
  createWorldRuntime,
  GRAPH,
} from "../www/js/core/machine/world.js";

const run = (events, init) => {
  let s = createWorld(init);
  for (const e of events) s = transition(s, typeof e === "string" ? { type: e } : e);
  return s;
};

test("初始态与合法迁移", () => {
  assert.deepEqual(createWorld(), INITIAL);
  let s = run(["HOST_UP", "WORLD_START"]);
  assert.equal(s.conn, "up");
  assert.equal(s.tier, "host");
  s = transition(s, { type: "PRESENT_REQUEST" });
  assert.equal(s.display, "overview"); // host 档不能进显现
  assert.equal(s.illegal, 1);
});

test("非法组合只计数", () => {
  const s = run(["PRESENT_REQUEST", "WORLD_STOP", "NOPE"]);
  assert.equal(s.illegal, 3);
});

test("丢主机强制回总观/空闲", () => {
  const s = run(["HOST_UP", "PRESENT_REQUEST", "HOST_LOST"]);
  assert.deepEqual([s.display, s.conn, s.tier], ["overview", "down", "idle"]);
});

test("主机恢复时端侧档退出", () => {
  const s = run(["EDGE_START", "HOST_UP"]);
  assert.deepEqual([s.conn, s.tier], ["up", "idle"]);
});

test("快照往返与坏快照", () => {
  const s = run(["HOST_UP", "WORLD_START"]);
  assert.deepEqual(restore(snapshot(s)), s);
  assert.throws(() => restore("null"), /不是对象/);
  assert.throws(() => restore(JSON.stringify({ ...createWorld(), tier: "x" })), /tier/);
});

test("runtime：记录迁移与计数，no-op 不记录", () => {
  const seen = [];
  const rt = createWorldRuntime({ log: (r) => seen.push(r), now: () => 123 });
  rt.dispatch({ type: "HOST_UP" });
  rt.dispatch({ type: "HOST_UP" }); // no-op
  rt.dispatch({ type: "WORLD_START" });
  rt.dispatch({ type: "PRESENT_REQUEST" }); // illegal
  assert.equal(rt.records.length, 3);
  assert.equal(seen.length, 3);
  assert.equal(rt.records[0].t, 123);
  assert.equal(rt.records[2].illegal, true);
  const counts = rt.counts;
  assert.equal(Object.keys(counts).length, 3);
  assert.ok(Object.keys(counts).some((k) => k.includes("illegal")));
});

test("runtime：reset 清空日志与计数", () => {
  const rt = createWorldRuntime();
  rt.dispatch({ type: "HOST_UP" });
  rt.reset();
  assert.equal(rt.records.length, 0);
  assert.deepEqual(rt.state, createWorld());
  assert.deepEqual(rt.counts, {});
});

test("runtime：日志上限 200", () => {
  const rt = createWorldRuntime();
  for (let i = 0; i < 260; i++) {
    rt.dispatch({ type: i % 2 ? "HOST_UP" : "HOST_DOWN" });
  }
  assert.equal(rt.records.length, 200);
});

test("GRAPH 覆盖全部事件", () => {
  const events = new Set(GRAPH.transitions.map((t) => t.event));
  for (const e of ["HOST_UP", "HOST_DOWN", "PRESENT_REQUEST", "PRESENT_EXIT", "WORLD_START", "WORLD_STOP", "EDGE_START", "TIER_SET", "TAKEOVER"]) {
    assert.ok(events.has(e), `GRAPH 缺少 ${e}`);
  }
});
