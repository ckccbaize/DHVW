import test from "node:test";
import assert from "node:assert/strict";

import { expressionGate } from "../www/js/core/wake/gate.js";
import { createWakeEngine, nextInterval } from "../www/js/core/wake/engine.js";

const at = (h, m = 0) => new Date(2026, 10, 13, h, m, 0).getTime();

test("gate：静默时段 / 交互窗口 / 最小间隔", () => {
  assert.equal(expressionGate({ now: at(23, 30) }).allow, "silent");
  assert.equal(expressionGate({ now: at(7, 0) }).allow, "silent");
  assert.equal(expressionGate({ now: at(12), lastInteractionAt: at(12) - 30_000 }).reason, "recent_interaction");
  assert.equal(expressionGate({ now: at(12), lastWakeAt: at(12) - 10 * 60_000 }).reason, "min_gap");
});

test("gate：小时/日上限、显现、首日、连续无回应", () => {
  assert.equal(expressionGate({ now: at(12), wakesThisHour: 2 }).reason, "hourly_cap");
  assert.equal(expressionGate({ now: at(12), wakesToday: 8 }).reason, "daily_cap");
  assert.deepEqual(expressionGate({ now: at(12), present: true }), { allow: "silent", reason: "present" });
  assert.equal(expressionGate({ now: at(12), firstDay: true }).allow, "trace");
  assert.equal(expressionGate({ now: at(12), noResponseStreak: 3 }).reason, "no_response_streak");
  assert.equal(expressionGate({ now: at(12) }).allow, "message");
});

test("nextInterval：45–90 分钟，低能量更久", () => {
  for (let i = 0; i < 50; i++) {
    const v = nextInterval({ mood: { energy: 0.5, valence: 0.5 }, random: () => i / 50 });
    assert.ok(v >= 45 && v <= 90, `interval=${v}`);
  }
  const tired = nextInterval({ mood: { energy: 0.1, valence: 0.5 }, random: () => 0.5 });
  const fresh = nextInterval({ mood: { energy: 0.9, valence: 0.5 }, random: () => 0.5 });
  assert.ok(tired > fresh);
});

test("engine：未到点 silent，到点按闸门出 thought/bubble", async () => {
  let t = at(12);
  const eng = createWakeEngine({ now: () => t, random: () => 0.5 });
  const first = await eng.tick({ mood: { energy: 0.5, valence: 0.5 }, text: "醒了一下" });
  assert.equal(first.kind, "thought");
  assert.equal(first.reason, "first_day");
  const notDue = await eng.tick({ mood: {} });
  assert.equal(notDue.kind, "silent");
  assert.equal(notDue.reason, "not_due");

  t += 70 * 60_000;
  const second = await eng.tick({ mood: { energy: 0.5, valence: 0.5 }, text: "又醒了" });
  assert.equal(second.kind, "bubble");
});

test("engine：present 静默；交互后 silent", async () => {
  let t = at(12);
  const eng = createWakeEngine({ now: () => t, random: () => 0.5 });
  const r = await eng.tick({ present: true, text: "x" });
  assert.equal(r.kind, "silent");
  assert.equal(r.reason, "present");

  t += 61 * 60_000;
  eng.recordInteraction(t);
  const r2 = await eng.tick({ text: "y" });
  assert.equal(r2.kind, "silent");
  assert.equal(r2.reason, "recent_interaction");
});

test("engine：PC 时间线优先，失败回落设备档", async () => {
  let t = at(12);
  const pc = createWakeEngine({
    now: () => t,
    fetchImpl: async () => ({ ok: true, json: async () => [{ share: "主机说：下雨了", content: "..." }] }),
    timelineUrl: "/world/timeline",
  });
  const r = await pc.tick({ text: "本地" });
  assert.equal(r.source, "pc");
  assert.equal(r.kind, "bubble");
  assert.equal(r.text, "主机说：下雨了");

  const offline = createWakeEngine({
    now: () => t,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    timelineUrl: "/world/timeline",
    random: () => 0.5,
  });
  const r2 = await offline.tick({ text: "本地" });
  assert.equal(r2.source, "device");
});

test("engine：suspend 期间完全不醒，resume 重新起算", async () => {
  let t = at(12);
  const eng = createWakeEngine({ now: () => t, random: () => 0.5 });
  eng.suspend();
  const r = await eng.tick({ text: "x" });
  assert.equal(r.kind, "silent");
  assert.equal(r.reason, "suspended");
  assert.equal(eng.state.lastWakeAt, 0);
  assert.equal(eng.state.wakesToday, 0);

  t += 5 * 60 * 60_000;
  eng.resume();
  assert.ok(eng.state.nextWakeAt > t);
  const r2 = await eng.tick({ text: "y" });
  assert.equal(r2.reason, "not_due");
});

test("engine：snapshot/restore 保留状态", async () => {
  let t = at(12);
  const a = createWakeEngine({ now: () => t, random: () => 0.5 });
  await a.tick({ text: "x" });
  const snap = a.snapshot();
  const b = createWakeEngine({ now: () => t });
  b.restore(snap);
  assert.equal(b.state.lastWakeAt, snap.lastWakeAt);
  assert.equal(b.state.nextWakeAt, snap.nextWakeAt);
});
