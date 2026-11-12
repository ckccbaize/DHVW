import test from "node:test";
import assert from "node:assert/strict";

import { createWorld, transition, snapshot, restore, GRAPH } from "../spikes/fsm/world.reducer.js";

const run = (events, init) => {
  let s = createWorld(init);
  for (const e of events) s = transition(s, typeof e === "string" ? { type: e } : e);
  return s;
};

test("reducer：合法迁移", () => {
  let s = run(["HOST_UP"]);
  assert.equal(s.conn, "up");
  s = transition(s, { type: "WORLD_START" });
  assert.equal(s.tier, "host");
  s = transition(s, { type: "WORLD_STOP" });
  assert.equal(s.tier, "idle");
  s = transition(s, { type: "PRESENT_REQUEST" });
  assert.equal(s.display, "present");
  s = transition(s, { type: "PRESENT_EXIT" });
  assert.equal(s.display, "overview");
  assert.equal(s.illegal, 0);
});

test("reducer：主机不可达时拒绝显现，并计数", () => {
  const s = run(["PRESENT_REQUEST"]);
  assert.equal(s.display, "overview");
  assert.equal(s.illegal, 1);
});

test("reducer：显现中丢主机 → 强制回总观", () => {
  const s = run(["HOST_UP", "PRESENT_REQUEST", "HOST_LOST"]);
  assert.equal(s.display, "overview");
  assert.equal(s.conn, "down");
  assert.equal(s.illegal, 0);
});

test("reducer：host 档时丢主机 → 回 idle", () => {
  const s = run(["HOST_UP", "WORLD_START", "HOST_DOWN"]);
  assert.equal(s.tier, "idle");
  assert.equal(s.conn, "down");
});

test("reducer：主机恢复时端侧档自动退出", () => {
  const s = run(["EDGE_START", "HOST_UP"]);
  assert.equal(s.tier, "idle");
  assert.equal(s.conn, "up");
});

test("reducer：非法组合只计数，不抛异常", () => {
  const s = run(["WORLD_START", "WORLD_STOP", "EDGE_START", "PRESENT_EXIT", "NOPE"]);
  assert.equal(s.illegal, 4);
  assert.equal(s.display, "overview");
  assert.equal(s.tier, "edge"); // EDGE_START 合法，其余四条非法
});

test("reducer：TIER_SET 的守卫", () => {
  assert.equal(run([{ type: "TIER_SET", value: "host" }]).illegal, 1);
  assert.equal(run(["HOST_UP", { type: "TIER_SET", value: "host" }]).tier, "host");
  assert.equal(run(["HOST_UP", { type: "TIER_SET", value: "edge" }]).illegal, 1);
  assert.equal(run([{ type: "TIER_SET", value: "edge" }]).tier, "edge");
  assert.equal(run([{ type: "TIER_SET", value: "nope" }]).illegal, 1);
});

test("reducer：快照往返", () => {
  const s = run(["HOST_UP", "WORLD_START"]);
  const json = snapshot(s);
  assert.deepEqual(restore(json), s);
  assert.deepEqual(restore(JSON.parse(json)), s);
});

test("reducer：坏快照被拒绝", () => {
  assert.throws(() => restore("null"), /不是对象/);
  assert.throws(() => restore(JSON.stringify({ ...createWorld(), display: "x" })), /display/);
  assert.throws(() => restore(JSON.stringify({ ...createWorld(), conn: "x" })), /conn/);
  assert.throws(() => restore(JSON.stringify({ ...createWorld(), tier: "x" })), /tier/);
});

test("reducer：GRAPH 覆盖全部事件（可视化用）", () => {
  const events = new Set(GRAPH.transitions.map((t) => t.event));
  for (const e of ["HOST_UP", "HOST_DOWN", "PRESENT_REQUEST", "PRESENT_EXIT", "WORLD_START", "WORLD_STOP", "EDGE_START", "TIER_SET", "TAKEOVER"]) {
    assert.ok(events.has(e), `GRAPH 缺少 ${e}`);
  }
});

test("reducer 与 XState 等价（未安装 xstate 时跳过）", async (t) => {
  let xstate = null;
  try {
    xstate = await import("xstate");
  } catch {
    t.skip("xstate 未安装（npm install）");
    return;
  }
  const { createWorldMachine, normalize } = await import("../spikes/fsm/world.xstate.js");
  const sequences = [
    ["HOST_UP", "WORLD_START", "PRESENT_REQUEST", "WORLD_STOP", "PRESENT_REQUEST", "PRESENT_EXIT", "HOST_DOWN"],
    ["PRESENT_REQUEST", "HOST_UP", "PRESENT_REQUEST", "HOST_DOWN"],
    ["EDGE_START", "HOST_UP", "WORLD_START", "TAKEOVER"],
    ["HOST_UP", "WORLD_START", "TAKEOVER", "PRESENT_REQUEST", "HOST_LOST"],
    ["HOST_UP", "HOST_UP", "WORLD_START", "WORLD_STOP", "WORLD_STOP"],
  ];
  for (const seq of sequences) {
    const a = run(seq);
    const actor = xstate.createActor(createWorldMachine(xstate));
    actor.start();
    for (const e of seq) actor.send({ type: e });
    const b = normalize(actor.getSnapshot());
    actor.stop();
    assert.deepEqual(a, b, `序列不一致: ${seq.join(" → ")}`);
  }
});
