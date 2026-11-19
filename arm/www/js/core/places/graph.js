// 地点图（W29）：家 + 可去地点，步行时间由距离推导；支持动态增删。
// 场景包与地图生成由 mapSpec 对接（W16/W31）。

export const HOME_ID = "home";

export function validatePlace(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "not_object";
  if (typeof p.id !== "string" || !/^[a-z][a-z0-9_-]{1,23}$/.test(p.id)) return "bad_id";
  if (typeof p.name !== "string" || p.name.trim().length < 1 || p.name.length > 20) return "bad_name";
  if (!Number.isFinite(p.distance) || p.distance < 0 || p.distance > 120) return "bad_distance";
  if (p.kind !== undefined && typeof p.kind !== "string") return "bad_kind";
  return null;
}

/** 步行时间：距离 × 2 分钟，最少 3 分钟；同地点 0。 */
export function travelMinutes(distance) {
  if (!distance) return 0;
  return Math.max(3, Math.round(distance * 2));
}

export function createPlaceGraph({ places = [], home = { id: HOME_ID, name: "家", kind: "home", distance: 0 } } = {}) {
  const map = new Map();
  map.set(home.id, { ...home, builtin: true });
  for (const p of places) {
    if (validatePlace(p) === null) map.set(p.id, { ...p, builtin: false });
  }

  return {
    get(id) {
      return map.get(id) || null;
    },
    list() {
      return [...map.values()];
    },
    add(place) {
      const reason = validatePlace(place);
      if (reason) return { ok: false, reason };
      if (place.id === HOME_ID) return { ok: false, reason: "home_reserved" };
      map.set(place.id, { ...place, builtin: false });
      return { ok: true, place: map.get(place.id) };
    },
    remove(id) {
      const p = map.get(id);
      if (!p || p.builtin) return false;
      return map.delete(id);
    },
    travel(from, to) {
      const a = map.get(from);
      const b = map.get(to);
      if (!a || !b) return null;
      if (a.id === b.id) return { from, to, minutes: 0 };
      return { from, to, minutes: travelMinutes(b.distance) };
    },
    custom() {
      return [...map.values()].filter((p) => !p.builtin);
    },
  };
}

/** 旅行计划：跨夜判定以游戏分钟是否越过 24:00 为准。 */
export function planTravel({ graph, from, to, minute = 0 } = {}) {
  const t = graph.travel(from, to);
  if (!t) return { ok: false, reason: "unknown_place" };
  const arriveMinute = minute + t.minutes;
  const crossesNight = Math.floor(arriveMinute / 1440) > Math.floor(minute / 1440);
  return {
    ok: true,
    from,
    to,
    minutes: t.minutes,
    departMinute: minute,
    arriveMinute,
    crossesNight,
  };
}
