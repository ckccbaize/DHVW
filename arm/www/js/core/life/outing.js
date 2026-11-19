// 出门意愿（W14+）：伪随机 + 无聊保底 + 特殊日期目的地。
// 产出 outing 计划，供地图自生成（W16/W31）与状态机消费。

import { MOOD_BASE } from "../machine/life.js";

const DAY = 24 * 60 * 1000;

export const DESTINATIONS = [
  { id: "park", name: "公园", kind: "street", distance: 10, mood: { valence: 0.08, energy: -0.02 } },
  { id: "riverside", name: "江边", kind: "street", distance: 15, mood: { valence: 0.09, social: 0.02 } },
  { id: "hill", name: "小山坡", kind: "street", distance: 25, mood: { valence: 0.1, energy: -0.08 } },
  { id: "bookstore", name: "书店", kind: "indoor", distance: 8, mood: { valence: 0.05, focus: 0.06 } },
  { id: "library", name: "图书馆", kind: "indoor", distance: 9, mood: { focus: 0.08, social: -0.03 } },
  { id: "cafe", name: "咖啡馆", kind: "indoor", distance: 6, mood: { valence: 0.06, social: 0.06 } },
  { id: "market", name: "集市", kind: "street", distance: 7, mood: { valence: 0.07, social: 0.08, energy: -0.03 } },
  { id: "night-market", name: "夜市", kind: "street", distance: 12, mood: { valence: 0.1, social: 0.1, energy: -0.05 } },
  { id: "cinema", name: "电影院", kind: "indoor", distance: 11, mood: { valence: 0.09, social: 0.04 } },
  { id: "convenience", name: "便利店", kind: "indoor", distance: 3, mood: { valence: 0.02 } },
];

/** 公历特殊日期；可用 kv special_dates 覆盖/追加。 */
export const SPECIAL_DATES = {
  "01-01": { name: "元旦", kinds: ["street"], boost: 0.35 },
  "02-14": { name: "情人节", kinds: ["indoor", "street"], boost: 0.4 },
  "05-01": { name: "劳动节", kinds: ["street"], boost: 0.3 },
  "06-01": { name: "儿童节", kinds: ["street"], boost: 0.25 },
  "10-01": { name: "国庆", kinds: ["street"], boost: 0.35 },
  "12-25": { name: "圣诞", kinds: ["indoor", "street"], boost: 0.3 },
};

export function dateKey(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function specialDateFor(ts, extra = {}) {
  const key = dateKey(ts);
  return extra[key] || SPECIAL_DATES[key] || null;
}

/** 0..1：心情越低、越久没出门、重复动作越多，越无聊。 */
export function boredomScore({ mood = {}, minutesSinceOuting = 0, sameActCount = 0 } = {}) {
  const m = { ...MOOD_BASE, ...mood };
  const base =
    (1 - m.valence) * 0.35 +
    (1 - m.energy) * 0.25 +
    (1 - m.social) * 0.25 +
    Math.min(1, Math.max(0, minutesSinceOuting) / (3 * 24 * 60)) * 0.15;
  return Math.min(1, base + Math.min(0.2, Math.max(0, sameActCount) * 0.03));
}

function weightOf(d, mood, special) {
  let w = 1;
  if (special?.kinds?.includes(d.kind)) w *= 3;
  if (mood.energy < 0.4) w *= d.distance <= 12 ? 1.5 : 0.6;
  if (mood.social > 0.6) w *= d.kind === "street" ? 1.6 : 0.8;
  if (mood.social < 0.3) w *= d.kind === "indoor" ? 1.5 : 0.7;
  return w;
}

export function pickDestination({ mood = {}, special = null, random = Math.random } = {}) {
  const m = { ...MOOD_BASE, ...mood };
  const pool = special?.kinds?.length
    ? DESTINATIONS.filter((d) => special.kinds.includes(d.kind)).concat(DESTINATIONS.filter((d) => !special.kinds.includes(d.kind)))
    : DESTINATIONS;
  const weights = pool.map((d) => weightOf(d, m, special));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/**
 * 是否出门。
 * - 0–6 点不出门；
 * - 当天已出门 maxPerDay 次则不再；
 * - 无聊 ≥0.72 或 3 天没出门 → 保底；
 * - 特殊日期显著提高概率并偏好对应目的地。
 */
export function planOuting({
  now = Date.now(),
  mood = {},
  lastOutingAt = 0,
  outingsToday = 0,
  sameActCount = 0,
  maxPerDay = 2,
  specialDates = {},
  random = Math.random,
} = {}) {
  const hour = new Date(now).getHours();
  const minutesSinceOuting = lastOutingAt ? Math.max(0, (now - lastOutingAt) / 60000) : 3 * 24 * 60;
  const boredom = boredomScore({ mood, minutesSinceOuting, sameActCount });
  const special = specialDateFor(now, specialDates);
  const base = { boredom, special, minutesSinceOuting };

  if (hour >= 0 && hour < 6) return { ...base, go: false, reason: "night" };
  if (outingsToday >= maxPerDay) return { ...base, go: false, reason: "daily_limit" };

  const floor = boredom >= 0.72 || minutesSinceOuting >= 3 * 24 * 60;
  if (floor) {
    return {
      ...base,
      go: true,
      reason: special ? "special_date" : "boredom_floor",
      destination: pickDestination({ mood, special, random }),
    };
  }

  const p = 0.02 + boredom * 0.3 + (special ? Number(special.boost) || 0.35 : 0) + (hour >= 18 && hour <= 22 ? 0.03 : 0);
  if (random() < p) {
    return {
      ...base,
      go: true,
      reason: special ? "special_date" : "random",
      destination: pickDestination({ mood, special, random }),
    };
  }
  return { ...base, go: false, reason: "not_now" };
}
