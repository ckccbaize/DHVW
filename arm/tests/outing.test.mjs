import test from "node:test";
import assert from "node:assert/strict";

import {
  boredomScore,
  dateKey,
  planOuting,
  pickDestination,
  specialDateFor,
  DESTINATIONS,
} from "../www/js/core/life/outing.js";

const at = (y, m, d, h) => new Date(y, m - 1, d, h, 0, 0).getTime();

test("boredomScore：低心情/久不出门更高", () => {
  const calm = boredomScore({ mood: { valence: 0.55, energy: 0.55, social: 0.4 } });
  const low = boredomScore({ mood: { valence: 0.15, energy: 0.15, social: 0.1 } });
  const long = boredomScore({ mood: { valence: 0.55, energy: 0.55, social: 0.4 }, minutesSinceOuting: 3 * 1440 });
  assert.ok(low > calm);
  assert.ok(long > calm);
  assert.ok(boredomScore({ mood: {}, sameActCount: 10 }) <= 1);
});

test("dateKey / specialDateFor", () => {
  assert.equal(dateKey(at(2026, 12, 25, 15)), "12-25");
  assert.equal(specialDateFor(at(2026, 12, 25, 15)).name, "圣诞");
  assert.equal(specialDateFor(at(2026, 11, 12, 15)), null);
  assert.equal(specialDateFor(at(2026, 11, 12, 15), { "11-12": { name: "生日", kinds: ["indoor"] } }).name, "生日");
});

test("planOuting：夜间不出门、每日上限", () => {
  const night = planOuting({ now: at(2026, 11, 12, 3), mood: {}, random: () => 0 });
  assert.equal(night.go, false);
  assert.equal(night.reason, "night");
  const capped = planOuting({ now: at(2026, 11, 12, 15), outingsToday: 2, random: () => 0 });
  assert.equal(capped.reason, "daily_limit");
});

test("planOuting：无聊保底触发", () => {
  const r = planOuting({
    now: at(2026, 11, 12, 15),
    mood: { valence: 0.1, energy: 0.1, social: 0.1 },
    sameActCount: 6,
    random: () => 0.99,
  });
  assert.equal(r.go, true);
  assert.equal(r.reason, "boredom_floor");
  assert.ok(r.destination);
});

test("planOuting：3 天没出门保底", () => {
  const r = planOuting({
    now: at(2026, 11, 12, 15),
    mood: { valence: 0.8, energy: 0.8, social: 0.8 },
    lastOutingAt: at(2026, 11, 8, 15),
    random: () => 0.99,
  });
  assert.equal(r.go, true);
  assert.equal(r.reason, "boredom_floor");
});

test("planOuting：特殊日期提高概率并偏好目的地", () => {
  const r = planOuting({
    now: at(2026, 12, 25, 15),
    mood: { valence: 0.55, energy: 0.55, social: 0.4 },
    random: () => 0,
  });
  assert.equal(r.go, true);
  assert.equal(r.reason, "special_date");
  assert.ok(["indoor", "street"].includes(r.destination.kind));
});

test("planOuting：普通日随机触发 / 不触发", () => {
  const recent = at(2026, 11, 12, 14);
  const go = planOuting({ now: at(2026, 11, 12, 15), mood: {}, lastOutingAt: recent, random: () => 0 });
  assert.equal(go.go, true);
  assert.equal(go.reason, "random");
  const no = planOuting({ now: at(2026, 11, 12, 15), mood: {}, lastOutingAt: recent, random: () => 0.99 });
  assert.equal(no.go, false);
  assert.equal(no.reason, "not_now");
});

test("pickDestination：低社交偏好安静，高社交偏好热闹", () => {
  const quiet = pickDestination({ mood: { social: 0.1, energy: 0.8 }, random: () => 0.99 });
  assert.equal(quiet.kind, "indoor");
  const social = pickDestination({ mood: { social: 0.9, energy: 0.8 }, random: () => 0.3 });
  assert.equal(social.kind, "street");
  assert.ok(DESTINATIONS.every((d) => ["indoor", "street"].includes(d.kind)));
});
