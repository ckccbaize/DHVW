// 生活状态机（W4）：作息 7 段 → 房间/动作 + 心情四维/五档 + 行为打分。
// 契约：docs/WORLD-CORE-SPEC.md §2.2 / §3。
//
// FUTURE(W33)：心情是**外部可引导**的接口（唤醒机 / 剧情 / 用户 / Doctor）。
// 现在只预留 source/reason 归因与 moodLog；深层管理（优先级、TTL、限频、
// episode/baseline、剧情 setpoint）见 SPEC §3.4 与 DEV-PLAN W33。

import { phaseOf } from "../clock.js";

export const PHASES = ["sleep", "wake", "morning", "noon", "afternoon", "evening", "night"];

/** 时段 → 主要房间（当前家园：living / hall / bedroom / bath / balcony）。 */
export const PHASE_ROOM = {
  sleep: "bedroom",
  wake: "bedroom",
  morning: "living",
  noon: "living",
  afternoon: "living",
  evening: "living",
  night: "bedroom",
};

/** 时段 → 偏好动作（与 interactions.json 的 act id 对齐）。 */
export const PHASE_ACTS = {
  sleep: ["sleep"],
  wake: ["dress", "wash"],
  morning: ["read", "water", "work"],
  noon: ["eat", "cook"],
  afternoon: ["work", "read", "play"],
  evening: ["cook", "watch", "rest"],
  night: ["rest", "read", "sleep"],
};

export const MOOD_BASE = Object.freeze({ energy: 0.55, valence: 0.55, social: 0.4, focus: 0.5 });

/** 心情写入来源（W33 会用于优先级/限频）。 */
export const MOOD_SOURCES = Object.freeze(["system", "wake", "plot", "interaction", "user", "doctor"]);
export const MOOD_DIMENSIONS = Object.keys(MOOD_BASE);
export const MOOD_DECAY_PER_MIN = 0.004;

/** 动作 → 标签（心情/时段匹配用）。 */
export const ACT_TAGS = {
  sleep: ["rest"],
  rest: ["rest"],
  eat: ["food"],
  cook: ["food", "focus"],
  read: ["quiet", "focus"],
  work: ["focus"],
  watch: ["rest", "social"],
  play: ["social"],
  water: ["quiet"],
  dress: ["self"],
  wash: ["self"],
  bath: ["rest"],
  laundry: ["chores"],
  clean: ["chores"],
  travel: ["social"],
};

const BAND_FIT = {
  tired: { rest: 1.0, quiet: 0.2, social: -0.5, focus: -0.3, food: 0.2, self: 0.1, chores: -0.6 },
  low: { quiet: 0.8, rest: 0.6, social: -0.4, focus: -0.2, food: 0.1, self: 0.2, chores: 0.1 },
  happy: { social: 0.8, quiet: 0.2, rest: 0.2, focus: 0.1, food: 0.3, self: 0.3, chores: 0.2 },
  excited: { social: 1.0, rest: -0.5, quiet: -0.3, focus: 0.2, food: 0.2, self: 0.3, chores: 0.2 },
  calm: { quiet: 0.5, focus: 0.3, rest: 0.2, social: 0.1, food: 0.2, self: 0.2, chores: 0.2 },
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function moodBand(mood) {
  const m = { ...MOOD_BASE, ...mood };
  if (m.energy < 0.3) return "tired";
  if (m.energy > 0.75 && m.valence > 0.7) return "excited";
  if (m.valence < 0.35) return "low";
  if (m.valence > 0.65) return "happy";
  return "calm";
}

/** 事件增量（如做饭 +0.15 valence）；越界截断。 */
export function applyMoodEvent(mood, deltas = {}) {
  const out = { ...MOOD_BASE, ...mood };
  for (const [k, d] of Object.entries(deltas)) {
    if (!MOOD_DIMENSIONS.includes(k)) continue;
    out[k] = clamp01(out[k] + Number(d || 0));
  }
  return out;
}

/** 随时间向基线衰减；minutes 为游戏分钟。 */
export function decayMood(mood, minutes, k = MOOD_DECAY_PER_MIN) {
  const out = { ...MOOD_BASE, ...mood };
  const f = Math.min(1, k * Math.max(0, minutes));
  for (const key of MOOD_DIMENSIONS) {
    out[key] = clamp01(out[key] + (MOOD_BASE[key] - out[key]) * f);
  }
  return out;
}

export function moodFit(band, act) {
  const tags = ACT_TAGS[act] || [];
  const table = BAND_FIT[band] || BAND_FIT.calm;
  let sum = 0;
  for (const t of tags) sum += table[t] || 0;
  return tags.length ? sum / tags.length : 0;
}

export function timeFit(phase, act) {
  return (PHASE_ACTS[phase] || []).includes(act) ? 0.6 : 0;
}

export function noveltyPenalty(recentActs, act, minute, windowMin = 120) {
  if (!Array.isArray(recentActs)) return 0;
  return recentActs.some((r) => r.act === act && minute - r.minute <= windowMin) ? -0.5 : 0;
}

/**
 * 热点打分（§3.3）：
 *  1 + moodFit + timeFit - novelty - distance + noise
 */
export function scoreHotspot({
  hotspot,
  mood,
  phase,
  from,
  minute,
  recentActs = [],
  rng = Math.random,
  maxDist = 30,
}) {
  const band = moodBand(mood);
  const dist = from ? Math.abs(hotspot.x - from.x) + Math.abs(hotspot.y - from.y) : 0;
  return (
    1 +
    moodFit(band, hotspot.act) +
    timeFit(phase, hotspot.act) +
    noveltyPenalty(recentActs, hotspot.act, minute) -
    0.3 * Math.min(1, dist / Math.max(1, maxDist)) +
    0.1 * rng()
  );
}

/** 取 top-3 加权随机；空列表返回 null。 */
export function pickHotspot(hotspots, ctx) {
  if (!Array.isArray(hotspots) || hotspots.length === 0) return null;
  const scored = hotspots.map((h) => ({ h, s: scoreHotspot({ ...ctx, hotspot: h }) }));
  scored.sort((a, b) => b.s - a.s);
  const top = scored.slice(0, 3);
  const min = Math.min(...top.map((x) => x.s));
  const weights = top.map((x) => x.s - min + 0.1);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = (ctx.rng || Math.random)() * total;
  for (let i = 0; i < top.length; i++) {
    r -= weights[i];
    if (r <= 0) return top[i].h;
  }
  return top[top.length - 1].h;
}

/** 运行时：时间推进 + 心情衰减 + 近期动作 + 选点。 */
export function createLifeRuntime({ minute = 8 * 60, mood = MOOD_BASE } = {}) {
  let m = minute;
  let moodState = { ...MOOD_BASE, ...mood };
  const recent = [];
  const moodLog = []; // FUTURE(W33)：外部引导的归因记录

  function advance(minutes) {
    const delta = Math.max(0, Number(minutes) || 0);
    moodState = decayMood(moodState, delta);
    m = (m + delta) % 1440;
    return snapshot();
  }

  function snapshot() {
    return {
      minute: m,
      phase: phaseOf(m),
      band: moodBand(moodState),
      mood: { ...moodState },
      recent: recent.slice(-10),
      moodLog: moodLog.slice(-5),
    };
  }

  return {
    get minute() {
      return m;
    },
    get phase() {
      return phaseOf(m);
    },
    get band() {
      return moodBand(moodState);
    },
    get mood() {
      return { ...moodState };
    },
    snapshot,
    advance,
    setMinute(v) {
      const next = Number(v);
      if (!Number.isFinite(next)) return snapshot();
      const delta = next >= m ? next - m : 1440 - m + next;
      return advance(delta);
    },
    /**
     * 外部引导心情（唤醒机 / 剧情 / 用户 / Doctor）。
     * meta.source 必须来自 MOOD_SOURCES；meta.reason 用于可解释性。
     * FUTURE(W33)：这里会加优先级、TTL、限频与"直接设定"（setpoint）。
     */
    applyMood(deltas, { source = "system", reason = "" } = {}) {
      const before = { ...moodState };
      moodState = applyMoodEvent(moodState, deltas);
      moodLog.push({
        t: m,
        source: MOOD_SOURCES.includes(source) ? source : "system",
        reason,
        deltas: { ...deltas },
        before,
        after: { ...moodState },
      });
      if (moodLog.length > 50) moodLog.shift();
      return snapshot();
    },
    noteAct(act) {
      recent.push({ act, minute: m });
      if (recent.length > 50) recent.shift();
    },
    pick(hotspots, from, rng = Math.random) {
      const chosen = pickHotspot(hotspots, {
        mood: moodState,
        phase: phaseOf(m),
        from,
        minute: m,
        recentActs: recent,
        rng,
      });
      if (chosen) this.noteAct(chosen.act);
      return chosen;
    },
    /** 从快照恢复（W6）：minute/mood/recent/moodLog。 */
    restore(snap = {}) {
      m = Number.isFinite(snap.minute) ? snap.minute : 8 * 60;
      moodState = { ...MOOD_BASE, ...(snap.mood || {}) };
      recent.length = 0;
      for (const r of snap.recent || []) recent.push({ ...r });
      moodLog.length = 0;
      for (const r of snap.moodLog || []) moodLog.push({ ...r });
      return snapshot();
    },
    reset({ minute: nextMinute = 8 * 60, mood: nextMood = MOOD_BASE } = {}) {
      m = nextMinute;
      moodState = { ...MOOD_BASE, ...nextMood };
      recent.length = 0;
      moodLog.length = 0;
      return snapshot();
    },
  };
}
