// 唤醒机双档（W21）：PC 档拉时间线；离线走设备档（定时 + 心情 + 闸门）。
// 完整严格 JSON / 三结局 / 租约在 W26。

import { expressionGate } from "./gate.js";

const MIN_MIN = 45;
const MAX_MIN = 90;

/** 下一次醒来的间隔：低能量更久，高愉悦更短，带抖动。 */
export function nextInterval({ mood = {}, random = Math.random } = {}) {
  const energy = Number(mood.energy ?? 0.55);
  const valence = Number(mood.valence ?? 0.55);
  let base = 60 + (0.55 - energy) * 60 - (valence - 0.55) * 30;
  base = Math.min(MAX_MIN, Math.max(MIN_MIN, base));
  const jitter = (random() - 0.5) * 20;
  return Math.round(Math.min(MAX_MIN, Math.max(MIN_MIN, base + jitter)));
}

export function createWakeEngine({
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  timelineUrl = "",
  gateCfg = undefined,
  random = Math.random,
} = {}) {
  let lastWakeAt = 0;
  let lastInteractionAt = 0;
  let nextWakeAt = 0;
  let wakesToday = 0;
  let dayKey = "";
  let hourKey = "";
  let wakesThisHour = 0;
  let noResponseStreak = 0;
  let firstDay = true;
  let suspended = false;
  const history = [];

  function roll(ts) {
    const d = new Date(ts);
    const dk = d.toDateString();
    const hk = `${dk} ${d.getHours()}`;
    if (dk !== dayKey) {
      dayKey = dk;
      wakesToday = 0;
    }
    if (hk !== hourKey) {
      hourKey = hk;
      wakesThisHour = 0;
    }
  }

  async function pullTimeline() {
    if (!timelineUrl || !fetchImpl) return null;
    try {
      const res = await fetchImpl(timelineUrl, { cache: "no-store" });
      if (!res.ok) return null;
      const data = await res.json();
      const items = Array.isArray(data) ? data : data?.items || data?.timeline || [];
      return items.length ? items[0] : null;
    } catch {
      return null;
    }
  }

  return {
    suspend() {
      suspended = true;
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      // 退出显现后重新起算，避免补醒连发。
      nextWakeAt = now() + nextInterval({ random }) * 60_000;
    },
    get suspended() {
      return suspended;
    },
    setTimelineUrl(url) {
      timelineUrl = url || "";
    },
    get state() {
      return { lastWakeAt, nextWakeAt, wakesToday, wakesThisHour, noResponseStreak, firstDay, suspended };
    },
    recordInteraction(ts = now()) {
      lastInteractionAt = ts;
      noResponseStreak = 0;
    },
    recordResponse(responded, ts = now()) {
      if (responded) noResponseStreak = 0;
      else noResponseStreak += 1;
      if (ts) lastInteractionAt = ts;
    },
    restore(snap = {}) {
      lastWakeAt = snap.lastWakeAt || 0;
      nextWakeAt = snap.nextWakeAt || 0;
      wakesToday = snap.wakesToday || 0;
      wakesThisHour = snap.wakesThisHour || 0;
      noResponseStreak = snap.noResponseStreak || 0;
      firstDay = snap.firstDay !== false;
      suspended = !!snap.suspended;
      dayKey = snap.dayKey || "";
      hourKey = snap.hourKey || "";
    },
    snapshot() {
      return { lastWakeAt, nextWakeAt, wakesToday, wakesThisHour, noResponseStreak, firstDay, dayKey, hourKey, suspended };
    },
    /** 主动醒一次；返回 {source, kind, reason, text?}。 */
    async tick({ mood = {}, present = false, text = "" } = {}) {
      const ts = now();
      if (suspended || present) {
        return { source: "device", kind: "silent", reason: suspended ? "suspended" : "present" };
      }
      roll(ts);

      const pc = await pullTimeline();
      if (pc) {
        lastWakeAt = ts;
        wakesToday += 1;
        wakesThisHour += 1;
        nextWakeAt = ts + nextInterval({ mood, random }) * 60_000;
        const kind = pc.share ? "bubble" : pc.content ? "thought" : "silent";
        const rec = { source: "pc", kind, reason: "timeline", text: pc.share || pc.content || "", item: pc };
        history.push(rec);
        return rec;
      }

      if (nextWakeAt && ts < nextWakeAt) return { source: "device", kind: "silent", reason: "not_due" };

      const gate = expressionGate(
        {
          now: ts,
          lastWakeAt,
          lastInteractionAt,
          wakesThisHour,
          wakesToday,
          noResponseStreak,
          present,
          firstDay,
        },
        gateCfg,
      );
      lastWakeAt = ts;
      wakesToday += 1;
      wakesThisHour += 1;
      nextWakeAt = ts + nextInterval({ mood, random }) * 60_000;
      firstDay = false;

      const kind = gate.allow === "message" ? "bubble" : gate.allow === "trace" ? "thought" : "silent";
      const rec = { source: "device", kind, reason: gate.reason, text: kind === "silent" ? "" : text };
      history.push(rec);
      return rec;
    },
    latest(n = 10) {
      return history.slice(-n);
    },
  };
}
