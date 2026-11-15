import test from "node:test";
import assert from "node:assert/strict";
import { WEATHER_STATES, weatherAt, weatherForDay } from "../www/js/core/weather.js";
import { lightFor } from "../www/js/core/light.js";

test("weatherAt：状态合法、可复现、温度风力在范围内", () => {
  const a = weatherAt(1, 0);
  const b = weatherAt(1, 0);
  assert.deepEqual(a, b);
  assert.ok(WEATHER_STATES.includes(a.state));
  assert.ok(a.temp >= 8 && a.temp <= 30);
  assert.ok(a.wind >= 0 && a.wind <= 6);
});

test("weatherAt：一天内天气不变，换天重新随机", () => {
  const day = weatherAt(3, 0);
  assert.deepEqual(weatherAt(3, 12 * 60), day);
  assert.deepEqual(weatherAt(3, 23 * 60 + 59), day);
  assert.equal(weatherForDay(3), day.state);

  const states = new Set();
  for (let d = 1; d <= 30; d += 1) states.add(weatherAt(d).state);
  assert.ok(states.size >= 2);
});

test("lightFor：雾按白天、暴风雨按雨天", () => {
  assert.equal(lightFor("afternoon", "fog"), "day");
  assert.equal(lightFor("afternoon", "storm"), "rain");
});
