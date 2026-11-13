import test from "node:test";
import assert from "node:assert/strict";

import { LINES, pickLine, tickInterval, weatherForDay } from "../www/js/core/life/lines.js";

test("weatherForDay：确定性", () => {
  assert.equal(weatherForDay(1), weatherForDay(1));
  assert.ok(["clear", "cloudy", "rain", "snow"].includes(weatherForDay(3)));
});

test("tickInterval：息屏 60s，其余 1s", () => {
  assert.equal(tickInterval("active"), 1000);
  assert.equal(tickInterval("idle"), 1000);
  assert.equal(tickInterval("asleep"), 60000);
});

test("pickLine：24h 去重", () => {
  const pool = LINES.morning;
  const recent = pool.slice(0, -1).map((text) => ({ text, day: 1, minute: 600 }));
  const r = pickLine({ phase: "morning", weather: "clear", day: 1, minute: 700, recent, random: () => 0.99 });
  assert.equal(r, pool[pool.length - 1]);

  const all = pool.map((text) => ({ text, day: 1, minute: 600 }));
  assert.equal(pickLine({ phase: "morning", weather: "clear", day: 1, minute: 700, recent: all, random: () => 0.9 }), null);
});

test("pickLine：超过 24h 可重复", () => {
  const text = LINES.morning[0];
  const r = pickLine({
    phase: "morning",
    weather: "clear",
    day: 2,
    minute: 700,
    recent: [{ text, day: 1, minute: 600 }],
    random: () => 0,
  });
  assert.ok(r);
});

test("pickLine：天气插句", () => {
  const r = pickLine({ phase: "night", weather: "rain", day: 1, minute: 1300, recent: [], random: () => 0 });
  assert.ok(r);
  assert.ok([...LINES.night, ...LINES.weather.rain].includes(r));
});
