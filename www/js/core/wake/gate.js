// 唤醒表达闸门（W21）：决定这次醒来是 silent / trace / message。
// 规则对齐 WakeTrace 2.1 设备侧映射与 A8 表达闸门。

export const GATE_DEFAULTS = Object.freeze({
  silentFrom: 23, // 23:00
  silentTo: 7.5, // 07:30
  interactionWindowMs: 60_000,
  minGapMs: 45 * 60_000,
  maxPerHour: 2,
  maxPerDay: 8,
  noResponseStreak: 3,
});

export function expressionGate({
  now = Date.now(),
  lastWakeAt = 0,
  lastInteractionAt = 0,
  wakesThisHour = 0,
  wakesToday = 0,
  noResponseStreak = 0,
  present = false,
  firstDay = false,
} = {}, cfg = GATE_DEFAULTS) {
  const d = new Date(now);
  const hour = d.getHours() + d.getMinutes() / 60;
  const silent = hour >= cfg.silentFrom || hour < cfg.silentTo;

  if (present) return { allow: "trace", reason: "present" };
  if (silent) return { allow: "silent", reason: "quiet_hours" };
  if (lastInteractionAt && now - lastInteractionAt < cfg.interactionWindowMs) {
    return { allow: "silent", reason: "recent_interaction" };
  }
  if (lastWakeAt && now - lastWakeAt < cfg.minGapMs) return { allow: "silent", reason: "min_gap" };
  if (wakesThisHour >= cfg.maxPerHour) return { allow: "silent", reason: "hourly_cap" };
  if (wakesToday >= cfg.maxPerDay) return { allow: "silent", reason: "daily_cap" };
  if (firstDay) return { allow: "trace", reason: "first_day" };
  if (noResponseStreak >= cfg.noResponseStreak) return { allow: "trace", reason: "no_response_streak" };
  return { allow: "message", reason: "ok" };
}
