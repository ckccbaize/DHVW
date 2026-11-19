import test from "node:test";
import assert from "node:assert/strict";

import {
  PHASES,
  PHASE_ROOM,
  PHASE_ACTS,
  MOOD_BASE,
  moodBand,
  applyMoodEvent,
  decayMood,
  moodFit,
  timeFit,
  noveltyPenalty,
  scoreHotspot,
  pickHotspot,
  createLifeRuntime,
} from "../www/js/core/machine/life.js";
import { phaseOf } from "../www/js/core/clock.js";

const rng0 = () => 0;

test("时段覆盖 7 段且都有房间/动作", () => {
  assert.equal(PHASES.length, 7);
  for (const p of PHASES) {
    assert.ok(PHASE_ROOM[p], `${p} 缺房间`);
    assert.ok(Array.isArray(PHASE_ACTS[p]) && PHASE_ACTS[p].length, `${p} 缺动作`);
  }
  for (let m = 0; m < 1440; m += 30) assert.ok(PHASES.includes(phaseOf(m)));
});

test("心情分档：tired/excited/low/happy/calm", () => {
  assert.equal(moodBand({ energy: 0.2, valence: 0.5 }), "tired");
  assert.equal(moodBand({ energy: 0.8, valence: 0.8 }), "excited");
  assert.equal(moodBand({ energy: 0.5, valence: 0.2 }), "low");
  assert.equal(moodBand({ energy: 0.6, valence: 0.8 }), "happy");
  assert.equal(moodBand({ ...MOOD_BASE }), "calm");
});

test("心情事件：截断到 0–1，忽略未知维度", () => {
  assert.equal(applyMoodEvent({}, { valence: 2 }).valence, 1);
  assert.equal(applyMoodEvent({}, { valence: -2 }).valence, 0);
  const m = applyMoodEvent({}, { nope: 1 });
  assert.equal(m.nope, undefined);
});

test("心情衰减：向基线靠拢", () => {
  const high = decayMood({ energy: 1 }, 60);
  assert.ok(high.energy < 1 && high.energy > MOOD_BASE.energy);
  const low = decayMood({ energy: 0 }, 60);
  assert.ok(low.energy > 0 && low.energy < MOOD_BASE.energy);
  assert.deepEqual(decayMood({}, 0), { ...MOOD_BASE });
});

test("moodFit：疲惫时偏好休息，兴奋时偏好社交", () => {
  assert.ok(moodFit("tired", "sleep") > moodFit("tired", "play"));
  assert.ok(moodFit("excited", "play") > moodFit("excited", "rest"));
  assert.equal(moodFit("calm", "unknown_act"), 0);
});

test("timeFit：时段内动作加分", () => {
  assert.equal(timeFit("sleep", "sleep"), 0.6);
  assert.equal(timeFit("sleep", "read"), 0);
});

test("noveltyPenalty：120 分钟内重复扣分", () => {
  assert.equal(noveltyPenalty([{ act: "read", minute: 100 }], "read", 150), -0.5);
  assert.equal(noveltyPenalty([{ act: "read", minute: 100 }], "read", 300), 0);
  assert.equal(noveltyPenalty([], "read", 300), 0);
});

test("scoreHotspot：近的比远的分数高；时段匹配加分", () => {
  const base = { mood: MOOD_BASE, phase: "morning", minute: 540, recentActs: [], rng: rng0, maxDist: 30 };
  const near = scoreHotspot({ ...base, hotspot: { x: 5, y: 5, act: "read" }, from: { x: 5, y: 5 } });
  const far = scoreHotspot({ ...base, hotspot: { x: 25, y: 5, act: "read" }, from: { x: 5, y: 5 } });
  assert.ok(near > far);
  const offPhase = scoreHotspot({ ...base, hotspot: { x: 5, y: 5, act: "sleep" }, from: { x: 5, y: 5 } });
  assert.ok(near > offPhase);
});

test("pickHotspot：空列表返回 null；rng=0 取最高分", () => {
  assert.equal(pickHotspot([], {}), null);
  const spots = [
    { x: 1, y: 1, act: "sleep" },
    { x: 1, y: 2, act: "read" },
    { x: 1, y: 3, act: "play" },
  ];
  const chosen = pickHotspot(spots, {
    mood: MOOD_BASE,
    phase: "morning",
    minute: 540,
    from: { x: 1, y: 1 },
    recentActs: [],
    rng: rng0,
  });
  assert.ok(spots.includes(chosen));
  assert.equal(chosen.act, "read"); // morning 偏好 read，且距离相同
});

test("runtime：推进时间、跨天、心情衰减", () => {
  const rt = createLifeRuntime({ minute: 480, mood: { ...MOOD_BASE, valence: 1 } });
  const s = rt.advance(180);
  assert.equal(s.minute, 660);
  assert.equal(s.phase, "noon");
  assert.ok(s.mood.valence < 1);
  rt.setMinute(60);
  assert.equal(rt.minute, 60);
  assert.equal(rt.phase, "sleep");
});

test("runtime：noteAct 影响后续选择", () => {
  const rt = createLifeRuntime({ minute: 540 });
  rt.noteAct("read");
  const spots = [
    { x: 1, y: 1, act: "read" },
    { x: 1, y: 1, act: "water" },
  ];
  const chosen = rt.pick(spots, { x: 1, y: 1 }, rng0);
  assert.equal(chosen.act, "water"); // read 被新颖度惩罚，water 同为上午动作
});

test("runtime：外部引导心情带 source/reason 归因", () => {
  const rt = createLifeRuntime({ minute: 600 });
  rt.applyMood({ valence: 0.2 }, { source: "wake", reason: "梦到旧事" });
  const snap = rt.snapshot();
  assert.equal(snap.moodLog.length, 1);
  assert.equal(snap.moodLog[0].source, "wake");
  assert.equal(snap.moodLog[0].reason, "梦到旧事");
  assert.ok(snap.moodLog[0].after.valence > snap.moodLog[0].before.valence);
  // 非法 source 归到 system
  rt.applyMood({ valence: -0.1 }, { source: "hacker" });
  assert.equal(rt.snapshot().moodLog[1].source, "system");
  // 日志上限 50
  for (let i = 0; i < 60; i++) rt.applyMood({ valence: 0.01 }, { source: "plot" });
  assert.ok(rt.snapshot().moodLog.length <= 5); // snapshot 只带最近 5 条
});

test("runtime：reset 清空", () => {
  const rt = createLifeRuntime({ minute: 600 });
  rt.noteAct("read");
  rt.applyMood({ valence: 0.2 }, { source: "wake" });
  rt.reset({ minute: 480 });
  assert.equal(rt.minute, 480);
  assert.equal(rt.snapshot().recent.length, 0);
  assert.equal(rt.snapshot().moodLog.length, 0);
  assert.deepEqual(rt.mood, { ...MOOD_BASE });
});
