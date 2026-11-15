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

/**
 * 选热点：优先 act 完全一致的热点；没有时才按道具回退。
 * 回退时必须返回热点自己的 act，调用方不能用请求的 act 覆盖，
 * 否则会出现“人在桌边、气泡却在吃饭”的错位。
 */
export function chooseHotspot(hotspots = [], act, { room = null, props = null, blocked = null, random = Math.random } = {}) {
  const wanted = props || ACT_PROPS[act] || [];
  const usable = hotspots.filter((h) => {
    if (!h || (room && h.room !== room)) return false;
    if (blocked && blocked.has(`${h.x},${h.y}:${h.act}`)) return false;
    return true;
  });
  const exact = usable.filter((h) => h.act === act);
  if (exact.length) {
    const hot = exact[Math.floor(random() * exact.length) % exact.length];
    return { hot, act: hot.act };
  }
  const fallback = usable.filter((h) => wanted.includes(h.prop));
  if (!fallback.length) return null;
  const hot = fallback[Math.floor(random() * fallback.length) % fallback.length];
  return { hot, act: hot.act };
}

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
 * - place 是外部场景（places 里、但不在 rooms 里）→ 保留，交给状态机旅行；
 * - 保留 minute/why/durationMin/overnight，由调用方消费。
 */
export function normalizeBehaviors(raw, { rooms, hotspots, fallbackPlace, places } = {}) {
  const roomSet = rooms instanceof Set ? rooms : new Set(rooms || []);
  const placeSet = places instanceof Set ? places : new Set(places || []);
  const map = createActRoomMap(hotspots);
  if (!Array.isArray(raw)) return [];
  return raw
    .map((b) => {
      const act = String(b?.act || "").trim();
      const requested = String(b?.place || "").trim();
      const external = requested && !roomSet.has(requested) && placeSet.has(requested);
      const place = external ? requested : roomForAct(map, act, roomSet.has(requested) ? requested : fallbackPlace);
      if (!act || !place) return null;
      const item = {
        minute: Number.isFinite(b?.minute) ? b.minute : -1,
        act,
        place,
        why: String(b?.why || "").trim(),
      };
      if (external) {
        item.durationMin = Math.max(10, Math.min(480, Number(b?.durationMin) || 60));
        item.overnight = b?.overnight === true;
      }
      return item;
    })
    .filter((b) => b && b.minute >= 0);
}
