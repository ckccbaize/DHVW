import test from "node:test";
import assert from "node:assert/strict";

import { buildMoodView, createMoodSeries, MOOD_DIMS, sourceCounts } from "../www/js/core/mood.js";
import { createMemoryKvBackend } from "../www/js/core/kv.js";

const mood = { energy: 0.5, valence: 0.6, social: 0.4, focus: 0.7 };

test("moodSeries：采样、同分钟去重、上限", async () => {
  const backend = createMemoryKvBackend();
  let t = 1000;
  const s = createMoodSeries({ backend, cap: 3, now: () => (t += 10) });
  await s.init();
  await s.sample({ minute: 480, mood, band: "calm", source: "tick" });
  await s.sample({ minute: 480, mood: { ...mood, valence: 0.7 }, band: "calm", source: "tick" });
  assert.equal(s.stats().count, 1);
  assert.equal(s.latest(1)[0].mood.valence, 0.7);

  await s.sample({ minute: 481, mood, band: "calm", source: "tick" });
  await s.sample({ minute: 482, mood, band: "happy", source: "plot" });
  await s.sample({ minute: 483, mood, band: "happy", source: "plot" });
  assert.equal(s.stats().count, 3);
  assert.equal(s.latest(1)[0].minute, 483);
});

test("moodSeries：history since/limit 与持久化", async () => {
  const backend = createMemoryKvBackend();
  let t = 1000;
  const a = createMoodSeries({ backend, now: () => (t += 10) });
  await a.init();
  for (let m = 0; m < 5; m++) await a.sample({ minute: m, mood, band: "calm", source: "tick" });
  assert.equal(a.history({ limit: 2 }).length, 2);
  assert.equal(a.history({ since: 1020 }).length, 3);

  const b = createMoodSeries({ backend });
  await b.init();
  assert.equal(b.stats().count, 5);
});

test("sourceCounts：按来源聚合", () => {
  const counts = sourceCounts([
    { source: "plot" },
    { source: "plot" },
    { source: "tick" },
    { source: "user" },
  ]);
  assert.deepEqual(counts, { plot: 2, tick: 1, user: 1 });
});

test("buildMoodView：PC 可视化载荷", () => {
  const v = buildMoodView({
    now: 123,
    minute: 480,
    mood,
    band: "calm",
    series: Array.from({ length: 5 }, (_, i) => ({ t: i, minute: i, band: "calm", mood })),
    moodLog: [{ source: "plot" }, { source: "plot" }],
    limit: 3,
  });
  assert.equal(v.v, 1);
  assert.equal(v.ts, 123);
  assert.deepEqual(Object.keys(v.dims), [...MOOD_DIMS]);
  assert.equal(v.series.length, 3);
  assert.equal(v.series[2].minute, 4);
  assert.deepEqual(v.sources, { plot: 2 });
});
