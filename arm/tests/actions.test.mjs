import test from "node:test";
import assert from "node:assert/strict";

import { BUILTIN_BEHAVIORS, createBehaviorRegistry, validateBehavior } from "../www/js/core/actions/registry.js";
import { moodFit, pickBehavior } from "../www/js/core/actions/plan.js";

const at = (h) => new Date(2026, 10, 13, h, 0, 0).getTime();

test("validateBehavior：字段与边界", () => {
  assert.equal(validateBehavior({ id: "walk", name: "散步", kind: "travel", weight: 1, cooldownMin: 30, hours: [9], effects: { valence: 0.1 } }), null);
  assert.equal(validateBehavior({ id: "Bad ID", name: "x", kind: "travel", weight: 1, cooldownMin: 0, hours: [9] }), "bad_id");
  assert.equal(validateBehavior({ id: "a1", name: "x", kind: "travel", weight: 1, cooldownMin: 0, hours: [9] }), "bad_name");
  assert.equal(validateBehavior({ id: "a1", name: "散步", kind: "magic", weight: 1, cooldownMin: 0, hours: [9] }), "bad_kind");
  assert.equal(validateBehavior({ id: "a1", name: "散步", kind: "home", weight: 0, cooldownMin: 0, hours: [9] }), "bad_weight");
  assert.equal(validateBehavior({ id: "a1", name: "散步", kind: "home", weight: 1, cooldownMin: -1, hours: [9] }), "bad_cooldown");
  assert.equal(validateBehavior({ id: "a1", name: "散步", kind: "home", weight: 1, cooldownMin: 0, hours: [24] }), "bad_hours");
  assert.equal(validateBehavior({ id: "a1", name: "散步", kind: "home", weight: 1, cooldownMin: 0, hours: [9], effects: { anger: 0.1 } }), "bad_effect_dim:anger");
  assert.equal(validateBehavior({ id: "a1", name: "散步", kind: "home", weight: 1, cooldownMin: 0, hours: [9], effects: { valence: 0.9 } }), "bad_effect_delta:valence");
});

test("registry：内置 + 自定义 + 不可删内置", () => {
  const reg = createBehaviorRegistry();
  assert.equal(reg.list().length, BUILTIN_BEHAVIORS.length);
  assert.ok(reg.get("outing"));
  const r = reg.register({ id: "walk", name: "散步", kind: "travel", weight: 1, cooldownMin: 30, hours: [9] });
  assert.equal(r.ok, true);
  assert.equal(reg.custom().length, 1);
  assert.equal(reg.remove("outing"), false);
  assert.equal(reg.remove("walk"), true);
  assert.equal(reg.list().length, BUILTIN_BEHAVIORS.length);
});

test("pickBehavior：时段过滤", () => {
  const reg = createBehaviorRegistry();
  const night = pickBehavior({ registry: reg, now: at(3), random: () => 0 });
  assert.equal(night, null);
  const morning = pickBehavior({ registry: reg, now: at(9), random: () => 0 });
  assert.ok(morning.behavior);
});

test("pickBehavior：冷却与联网前置", () => {
  const reg = createBehaviorRegistry();
  const recent = [{ id: "outing", at: at(9) }];
  const r = pickBehavior({ registry: reg, now: at(10), recent, random: () => 0.99 });
  assert.notEqual(r.behavior.id, "outing");

  const noNet = pickBehavior({ registry: reg, now: at(10), network: false, random: () => 0 });
  assert.notEqual(noNet.behavior.id, "browse");
  const withNet = pickBehavior({ registry: reg, now: at(10), network: true, random: () => 0.99 });
  assert.ok(withNet.behavior);
});

test("moodFit：低能量更想休息，低社交更想出门", () => {
  const rest = BUILTIN_BEHAVIORS.find((b) => b.id === "nap");
  const out = BUILTIN_BEHAVIORS.find((b) => b.id === "outing");
  assert.ok(moodFit(rest, { energy: 0.1 }) > moodFit(rest, { energy: 0.9 }));
  assert.ok(moodFit(out, { social: 0.1 }) > moodFit(out, { social: 0.9 }));
});
