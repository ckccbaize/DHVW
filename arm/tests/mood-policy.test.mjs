import test from "node:test";
import assert from "node:assert/strict";

import { createMoodPolicy, MOOD_PRIORITY } from "../www/js/core/mood/policy.js";

function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("优先级：doctor 的 TTL 内设定阻止 plot 覆盖", () => {
  const c = clock();
  const p = createMoodPolicy({ now: c.now, rateMax: 10 });
  assert.equal(p.apply({ source: "doctor", reason: "安全模式", setpoint: { social: 0.1 }, ttlMs: 60_000 }).ok, true);
  const r = p.apply({ source: "plot", reason: "剧情低落", deltas: { valence: -0.2 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "lower_priority");
  assert.deepEqual(p.resolve().setpoint, { social: 0.1 });
});

test("TTL 过期后低优先级可写入", () => {
  const c = clock();
  const p = createMoodPolicy({ now: c.now, rateMax: 10 });
  p.apply({ source: "wake", reason: "醒来", deltas: { valence: 0.1 }, ttlMs: 1000 });
  c.advance(1500);
  const r = p.apply({ source: "plot", reason: "剧情", deltas: { valence: -0.1 } });
  assert.equal(r.ok, true);
  assert.equal(p.active().length, 1);
});

test("setpoint 必须带 TTL", () => {
  const p = createMoodPolicy();
  assert.equal(p.apply({ source: "plot", reason: "x", setpoint: { valence: 0.2 } }).reason, "setpoint_needs_ttl");
});

test("限频：同 source 10 分钟 ≤3 次", () => {
  const c = clock();
  const p = createMoodPolicy({ now: c.now, rateMax: 3 });
  for (let i = 0; i < 3; i++) assert.equal(p.apply({ source: "plot", reason: `r${i}`, deltas: { valence: 0.01 } }).ok, true);
  assert.equal(p.apply({ source: "plot", reason: "r4", deltas: { valence: 0.01 } }).reason, "rate_limited");
  c.advance(10 * 60_000 + 1);
  assert.equal(p.apply({ source: "plot", reason: "r5", deltas: { valence: 0.01 } }).ok, true);
});

test("bias 叠加与日志", () => {
  const p = createMoodPolicy({ rateMax: 10 });
  p.apply({ source: "wake", reason: "a", deltas: { valence: 0.1 } });
  p.apply({ source: "plot", reason: "b", deltas: { valence: -0.05, focus: 0.02 } });
  const r = p.resolve();
  assert.equal(r.bias.valence, 0.05);
  assert.equal(r.bias.focus, 0.02);
  assert.equal(p.log().length, 2);
  assert.equal(MOOD_PRIORITY.doctor > MOOD_PRIORITY.user, true);
});

test("reset 清空", () => {
  const p = createMoodPolicy();
  p.apply({ source: "plot", reason: "x", deltas: { valence: 0.1 } });
  p.reset();
  assert.equal(p.stats().effects, 0);
  assert.equal(p.log().length, 0);
});
