import test from "node:test";
import assert from "node:assert/strict";

import { createStateLog, createTaskLedger, summarizeHealth } from "../www/js/core/observe.js";
import { createMemoryKvBackend } from "../www/js/core/kv.js";

test("stateLog：seq 单调、since、上限", async () => {
  const backend = createMemoryKvBackend();
  let t = 1000;
  const log = createStateLog({ backend, cap: 3, now: () => (t += 10) });
  await log.init();
  await log.append({ kind: "world", from: "overview", to: "present" });
  await log.append({ kind: "life", from: "morning", to: "noon" });
  const s = await log.append({ kind: "world", from: "present", to: "overview" });
  assert.equal(s.seq, 3);
  assert.equal(log.stats().count, 3);
  assert.equal(log.since(1010).length, 2);
  await log.append({ kind: "world", from: "a", to: "b" });
  assert.equal(log.stats().count, 3);
  assert.equal(log.latest(1)[0].kind, "world");
});

test("stateLog：持久化恢复", async () => {
  const backend = createMemoryKvBackend();
  const a = createStateLog({ backend });
  await a.init();
  await a.append({ kind: "world", from: "x", to: "y" });
  const b = createStateLog({ backend });
  await b.init();
  assert.equal(b.stats().lastSeq, 1);
  assert.equal(b.latest(1)[0].to, "y");
});

test("taskLedger：成功/失败统计与按类聚合", async () => {
  const backend = createMemoryKvBackend();
  const led = createTaskLedger({ backend, cap: 5 });
  await led.init();
  await led.record({ kind: "plot", ok: true, ms: 120 });
  await led.record({ kind: "plot", ok: false, ms: 40, error: "timeout" });
  await led.record({ kind: "map", ok: true, ms: 8 });
  const s = led.stats();
  assert.equal(s.done, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.byKind.plot.done, 1);
  assert.equal(s.byKind.plot.failed, 1);
  assert.equal(s.byKind.map.lastMs, 8);
  assert.equal(s.last.kind, "map");
});

test("taskLedger：上限与恢复", async () => {
  const backend = createMemoryKvBackend();
  const a = createTaskLedger({ backend, cap: 2 });
  await a.init();
  for (let i = 0; i < 4; i++) await a.record({ kind: "bg", ok: true, ms: i });
  assert.equal(a.stats().count, 2);
  const b = createTaskLedger({ backend, cap: 2 });
  await b.init();
  assert.equal(b.stats().count, 2);
  assert.equal(b.stats().done, 4);
});

test("summarizeHealth：汇总字段", () => {
  const h = summarizeHealth({
    world: { display: "overview", tier: "idle", conn: "up" },
    life: { minute: 480, phase: "morning", band: "calm", mood: { valence: 0.5 } },
    log: { count: 3 },
    sched: { queued: 1 },
    budget: { outTokens: 10 },
    llm: { configured: true },
    governor: { tier: "P4" },
    stateLog: { count: 2 },
    ledger: { done: 1 },
    heap: { ratio: 0.3 },
  });
  assert.equal(h.world.display, "overview");
  assert.equal(h.life.band, "calm");
  assert.equal(h.governor.tier, "P4");
  assert.equal(h.heap.ratio, 0.3);
});
