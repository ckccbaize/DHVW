import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  applyEffects,
  createInteractionRegistry,
  resolveInteraction,
} from "../www/js/core/interactions.js";

const home = JSON.parse(fs.readFileSync(new URL("../www/assets/scenes/home/interactions.json", import.meta.url), "utf8"));

test("registry：家园 interactions 合法并按 prop 建索引", () => {
  const reg = createInteractionRegistry(home);
  assert.equal(reg.ok, true, reg.errors.join(","));
  assert.ok(reg.byProp.get("bed").includes("sleep"));
  assert.ok(reg.byProp.get("stove").includes("cook"));
});

test("resolve：睡觉只在夜间/卧室可选", () => {
  const reg = createInteractionRegistry(home);
  const night = resolveInteraction({
    registry: reg,
    prop: "bed",
    state: { minute: 23 * 60, place: "bedroom", weather: "clear", mood: {}, flags: {} },
  });
  assert.equal(night?.id, "sleep");
  const noon = resolveInteraction({
    registry: reg,
    prop: "bed",
    state: { minute: 12 * 60, place: "bedroom", weather: "clear", mood: {}, flags: {} },
  });
  assert.notEqual(noon?.id, "sleep");
});

test("applyEffects：心情夹紧、时间推进、事件输出", () => {
  const out = applyEffects(
    [
      { kind: "mood", target: "energy", delta: 2 },
      { kind: "advance_time", minutes: 480 },
      { kind: "event", name: "sleep" },
      { kind: "say", text: "晚安" },
    ],
    { minute: 100, mood: { energy: 0.5 }, flags: {} },
  );
  assert.equal(out.state.mood.energy, 1);
  assert.equal(out.state.minute, 580);
  assert.deepEqual(out.events.map((e) => e.kind), ["event", "say"]);
});
