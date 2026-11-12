import test from "node:test";
import assert from "node:assert/strict";

import { createBudgetLedger } from "../www/js/core/llm/budget.js";
import { createMemoryKvBackend } from "../www/js/core/kv.js";

const T = new Date(2026, 10, 12, 10, 0, 0).getTime(); // 2026-11-12 本地

test("记录：按 class/kind 累计 tokens 与调用数", async () => {
  const b = createBudgetLedger({ backend: createMemoryKvBackend(), now: () => T });
  await b.init();
  b.record({ cls: "character", kind: "wake", usage: { prompt_tokens: 100, completion_tokens: 20 }, ts: T });
  b.record({ cls: "character", kind: "wake", usage: { prompt_tokens: 100, completion_tokens: 30 }, ts: T });
  b.record({ cls: "work", kind: "plot", usage: { prompt_tokens: 50, completion_tokens: 40 }, ts: T });
  b.record({ cls: "work", kind: "plot", usage: null, ok: false, ts: T });

  const s = b.stats();
  assert.equal(s.day, "2026-11-12");
  assert.equal(s.calls, 4);
  assert.equal(s.ok, 3);
  assert.equal(s.failed, 1);
  assert.equal(s.inTokens, 250);
  assert.equal(s.outTokens, 90);
  assert.equal(s.byClass.character.outTokens, 50);
  assert.equal(s.byClass.work.calls, 2);
  assert.equal(s.byKind.plot.failed, 1);
});

test("软告警：超过阈值只置位，不阻止调用", async () => {
  const b = createBudgetLedger({ backend: createMemoryKvBackend(), now: () => T, softLimitOut: 50 });
  await b.init();
  b.record({ cls: "work", kind: "plot", usage: { completion_tokens: 40 }, ts: T });
  assert.equal(b.stats().softAlert, false);
  b.record({ cls: "work", kind: "plot", usage: { completion_tokens: 20 }, ts: T });
  assert.equal(b.stats().softAlert, true);
  // 仍然可以继续记录（不断闸）
  b.record({ cls: "work", kind: "plot", usage: { completion_tokens: 20 }, ts: T });
  assert.equal(b.stats().calls, 3);
});

test("跨天：按本地日期分桶", async () => {
  const b = createBudgetLedger({ backend: createMemoryKvBackend(), now: () => T });
  await b.init();
  b.record({ cls: "work", kind: "plot", usage: { completion_tokens: 10 }, ts: T });
  const next = T + 86400000;
  b.record({ cls: "work", kind: "plot", usage: { completion_tokens: 20 }, ts: next });
  assert.equal(b.stats("2026-11-12").outTokens, 10);
  assert.equal(b.stats("2026-11-13").outTokens, 20);
});

test("持久化：重启后恢复", async () => {
  const backend = createMemoryKvBackend();
  const b1 = createBudgetLedger({ backend, now: () => T });
  await b1.init();
  b1.record({ cls: "work", kind: "plot", usage: { completion_tokens: 12 }, ts: T });
  await new Promise((r) => setTimeout(r, 5));

  const b2 = createBudgetLedger({ backend, now: () => T });
  await b2.init();
  assert.equal(b2.stats().outTokens, 12);
});

test("reset：只清当天", async () => {
  const b = createBudgetLedger({ backend: createMemoryKvBackend(), now: () => T });
  await b.init();
  b.record({ cls: "work", kind: "plot", usage: { completion_tokens: 10 }, ts: T });
  b.record({ cls: "work", kind: "plot", usage: { completion_tokens: 20 }, ts: T + 86400000 });
  await b.reset("2026-11-12");
  assert.equal(b.stats("2026-11-12").calls, 0);
  assert.equal(b.stats("2026-11-13").calls, 1);
});

test("history：按天返回最近 N 天总量", async () => {
  const b = createBudgetLedger({ backend: createMemoryKvBackend(), now: () => T });
  await b.init();
  b.record({ cls: "work", kind: "plot", usage: { completion_tokens: 10 }, ts: T });
  const h = b.history(2);
  assert.equal(h.length, 2);
  assert.equal(h[0].outTokens, 0); // 昨天
  assert.equal(h[1].outTokens, 10); // 今天
});

test("默认软告警阈值 50k", async () => {
  const b = createBudgetLedger({ backend: createMemoryKvBackend(), now: () => T });
  await b.init();
  assert.equal(b.stats().softLimitOut, 50000);
});

test("setSoftLimit：只改阈值", async () => {
  const b = createBudgetLedger({ backend: createMemoryKvBackend(), now: () => T });
  await b.init();
  assert.equal(b.setSoftLimit(100), 100);
  assert.equal(b.stats().softLimitOut, 100);
});
