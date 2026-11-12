import test from "node:test";
import assert from "node:assert/strict";

import { generatePlot, plotGate, fnv1a, mulberry32, hourWord } from "../www/js/forge/grammar.js";

const baseCtx = {
  seed: "s1",
  day: 3,
  minute: 9 * 60 + 42,
  phase: "morning",
  weather: "rain",
  room: "study",
  act: "read",
};

test("文法：同种子同文本（确定性）", () => {
  const a = generatePlot({ ...baseCtx });
  const b = generatePlot({ ...baseCtx });
  assert.equal(a.text, b.text);
  assert.equal(a.ok, true);
  const c = generatePlot({ ...baseCtx, minute: 10 * 60 });
  assert.notEqual(a.text, c.text);
});

test("文法：产出通过闸门（30–80 字 + 时间锚点）", () => {
  const rooms = ["bedroom", "living", "bathroom", "balcony"];
  const acts = ["sleep", "read", "cook", "water", "watch", "work", "bath"];
  const phases = ["morning", "noon", "afternoon", "evening", "night", "sleep", "wake"];
  const weathers = ["clear", "cloudy", "rain", "snow"];
  let ok = 0;
  const total = 200;
  for (let i = 0; i < total; i++) {
    const r = generatePlot({
      seed: `s${i}`,
      day: 1 + (i % 7),
      minute: (i * 37) % 1440,
      phase: phases[i % phases.length],
      weather: weathers[i % weathers.length],
      room: rooms[i % rooms.length],
      act: acts[i % acts.length],
    });
    if (r.ok) ok += 1;
    const len = [...r.text].length;
    assert.ok(len >= 30 && len <= 80, `长度越界 ${len}: ${r.text}`);
    assert.match(r.text, /(第\d+天|凌晨|清早|上午|中午|下午|傍晚|晚上|深夜|夜里)/);
  }
  assert.equal(ok, total);
});

test("文法：24h 去重（recent 命中则换一条）", () => {
  const first = generatePlot({ ...baseCtx });
  const second = generatePlot({ ...baseCtx, recent: [first.text] });
  assert.notEqual(second.text, first.text);
  assert.equal(second.ok, true);
});

test("plotGate：空/过短/过长/无锚点/重复", () => {
  assert.equal(plotGate("").ok, false);
  assert.match(plotGate("上午09:00，她在书房。").reason, /^too_short:/);
  assert.equal(plotGate("上午09:00，" + "她".repeat(80)).reason.startsWith("too_long"), true);
  assert.equal(plotGate("她在书房坐了一会儿，什么也没做，只是歇着，时间慢慢过去了一点点。").reason, "no_time_anchor");
  const ok = "上午09:42，她在书房翻了几页书，心里有点空。时间又往前走了一点。";
  assert.equal(plotGate(ok).ok, true);
  assert.equal(plotGate(ok, new Set([ok])).reason, "duplicate");
});

test("hourWord：不产生矛盾时间词", () => {
  assert.equal(hourWord(0), "凌晨");
  assert.equal(hourWord(6), "清早");
  assert.equal(hourWord(9), "上午");
  assert.equal(hourWord(12), "中午");
  assert.equal(hourWord(15), "下午");
  assert.equal(hourWord(18), "傍晚");
  assert.equal(hourWord(21), "晚上");
  assert.equal(hourWord(23), "深夜");
});

test("PRNG：同种子同序列，分布不退化", () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.deepEqual(seqA, seqB);
  assert.ok(new Set(seqA).size > 5);
  assert.equal(fnv1a("abc"), fnv1a("abc"));
  assert.notEqual(fnv1a("abc"), fnv1a("abd"));
});
