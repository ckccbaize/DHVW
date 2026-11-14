// 剧情日程的地点/动作校验：动作必须在有对应热点的房间执行。
// 纯函数，Node 与浏览器共用。

export const ACT_PROPS = Object.freeze({
  read: ["shelf", "bookshelf"],
  cook: ["counter", "stove", "fridge"],
  write: ["desk", "table", "coffee_table"],
  eat: ["table"],
  watch: ["tv"],
  rest: ["sofa", "armchair", "coffee_table", "nightstand"],
  dress: ["wardrobe", "dresser", "coat_rack"],
  bath: ["bathtub"],
  wash: ["sink"],
  laundry: ["washer"],
  play: ["cat_tree"],
  water: ["plant", "plant_big"],
  light: ["lamp"],
  toilet: ["toilet"],
  sit: ["chair", "stool", "bench"],
  sleep: ["bed"],
});

export function createActRoomMap(hotspots = []) {
  const map = new Map();
  for (const h of hotspots) {
    if (!h.room) continue;
    for (const [act, props] of Object.entries(ACT_PROPS)) {
      if (h.act !== act && !props.includes(h.prop)) continue;
      if (!map.has(act)) map.set(act, new Set());
      map.get(act).add(h.room);
    }
  }
  return map;
}

export function roomForAct(map, act, requested) {
  const valid = map.get(act);
  if (!valid || !valid.size) return null;
  return valid.has(requested) ? requested : [...valid][0];
}

/**
 * 校正 LLM 产出的 behaviors。
 * - act 在场景里没有热点 → 丢弃；
 * - place 不匹配 → 改到该动作的第一个可用房间；
 * - 保留 minute/why，由调用方补时间。
 */
export function normalizeBehaviors(raw, { rooms, hotspots, fallbackPlace } = {}) {
  const roomSet = rooms instanceof Set ? rooms : new Set(rooms || []);
  const map = createActRoomMap(hotspots);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      const act = String(b?.act || "").trim();
      const requested = roomSet.has(b?.place) ? b.place : fallbackPlace;
      const place = roomForAct(map, act, requested);
      if (!act || !place) return null;
      return {
        minute: Number.isFinite(b?.minute) ? b.minute : -1,
        act,
        place,
        why: String(b?.why || "").trim(),
      };
    })
    .filter((b) => b && b.minute >= 0);
}
