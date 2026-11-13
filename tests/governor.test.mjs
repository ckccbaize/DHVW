import test from "node:test";
import assert from "node:assert/strict";

import {
  allowedAt,
  checkWatchdog,
  classify,
  createGovernor,
  DEFAULT_THRESHOLDS,
} from "../www/js/core/governor.js";

test("classify：P4/P3/P2 水位", () => {
  assert.equal(classify({ heapRatio: 0.3, eventCount: 100 }).tier, "P4");
  assert.equal(classify({ heapRatio: 0.7 }).tier, "P3");
  assert.equal(classify({ heapRatio: 0.9 }).tier, "P2");
  assert.equal(classify({ eventCount: 1300 }).tier, "P3");
  assert.equal(classify({ eventCount: 1900 }).tier, "P2");
  assert.equal(classify({ queue: 25 }).tier, "P3");
  assert.deepEqual(classify({ heapRatio: 0.9 }).reasons, ["heap:0.90"]);
});

test("allowedAt：P3 停背景，P2 只留生活/唤醒", () => {
  assert.equal(allowedAt("P4", "bg"), true);
  assert.equal(allowedAt("P3", "bg"), false);
  assert.equal(allowedAt("P3", "plot"), true);
  assert.equal(allowedAt("P2", "plot"), false);
  assert.equal(allowedAt("P2", "life"), true);
  assert.equal(allowedAt("P2", "wake"), true);
});

test("governor：降级立即、恢复需连续 calm + 余量", () => {
  let metrics = { heapRatio: 0.9, eventCount: 0 };
  const tiers = [];
  const g = createGovernor({
    getMetrics: () => metrics,
    onTier: (t) => tiers.push(t.tier),
    now: () => 1,
  });
  assert.equal(g.check().tier, "P2");
  assert.deepEqual(tiers, ["P2"]);

  metrics = { heapRatio: 0.7 };
  assert.equal(g.check().tier, "P3"); // 降级立即
  assert.deepEqual(tiers, ["P2", "P3"]);

  metrics = { heapRatio: 0.5 };
  assert.equal(g.check().tier, "P3"); // 第 1 次 calm
  assert.equal(g.check().tier, "P4"); // 第 2 次恢复
  assert.deepEqual(tiers, ["P2", "P3", "P4"]);
});

test("governor：内存未留余量不恢复", () => {
  let metrics = { heapRatio: 0.9 };
  const g = createGovernor({ getMetrics: () => metrics });
  g.check(); // P2
  metrics = { heapRatio: 0.6 }; // 高于 0.65-0.08=0.57
  for (let i = 0; i < 5; i++) assert.equal(g.check().tier, "P3");
});

test("checkWatchdog：超时判定", () => {
  assert.equal(checkWatchdog({ lastBeatAt: 1000, now: 2000, timeoutMs: 30000 }).stale, false);
  const r = checkWatchdog({ lastBeatAt: 1000, now: 40000, timeoutMs: 30000 });
  assert.equal(r.stale, true);
  assert.equal(r.age, 39000);
  assert.equal(DEFAULT_THRESHOLDS.heapP2, 0.82);
});
