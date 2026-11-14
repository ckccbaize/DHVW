// 由布局生成可烘焙的场景 spec：房间命名、家具、门窗、墙面小物。
// 纯函数，不依赖 DOM；供地图 Agent 与 forge 烘焙共用。

import { FURNITURE_SIZES } from "./furniture.js";
import { buildInteractions } from "./scenekit.js";
import { fnv1a, mulberry32 } from "./grammar.js";

const NON_BLOCK = new Set(["rug", "door_mat", "bath_mat"]);
const BIG_ITEMS = new Set(["bed", "wardrobe", "dresser", "desk", "bookshelf", "sofa", "tv", "counter", "stove", "fridge", "table", "bench", "cat_tree", "coffee_table"]);

const ROOM_SETS = {
  home: [
    { kind: "living", name: "客厅" },
    { kind: "bedroom", name: "卧室" },
    { kind: "hall", name: "厨房" },
    { kind: "bath", name: "浴室" },
    { kind: "balcony", name: "阳台" },
  ],
  office: [
    { kind: "office", name: "办公区" },
    { kind: "meeting", name: "会议室" },
    { kind: "lounge", name: "休息区" },
  ],
  nature: [
    { kind: "park", name: "公园" },
    { kind: "lawn", name: "草地" },
    { kind: "cabin", name: "小屋" },
  ],
  quiet: [
    { kind: "library", name: "阅览室" },
    { kind: "reading", name: "书房" },
    { kind: "lounge", name: "休息区" },
  ],
  social: [
    { kind: "cafe", name: "咖啡区" },
    { kind: "lounge", name: "休息区" },
  ],
  lively: [
    { kind: "market", name: "集市" },
    { kind: "stall", name: "摊位" },
  ],
  errand: [
    { kind: "store", name: "商店" },
    { kind: "counter", name: "柜台" },
  ],
};

const PROPS_BY_ROOM = {
  bedroom: [["bed", 1], ["nightstand", 1], ["wardrobe", 1], ["lamp", 1], ["rug", 1]],
  bath: [["bathtub", 1], ["sink", 1], ["toilet", 1], ["bath_mat", 1]],
  living: [["sofa", 1], ["coffee_table", 1], ["tv", 1], ["plant", 1], ["rug", 1], ["lamp", 1]],
  hall: [["counter", 1], ["stove", 1], ["fridge", 1], ["table", 1], ["chair", 2], ["plant", 1]],
  balcony: [["bench", 1], ["plant_big", 1], ["plant", 1], ["lamp", 1]],
  office: [["table", 2], ["chair", 4], ["shelf", 1], ["bookshelf", 1], ["plant", 2], ["lamp", 1]],
  meeting: [["table", 1], ["chair", 4], ["plant", 1], ["lamp", 1]],
  lounge: [["sofa", 1], ["coffee_table", 1], ["plant", 1], ["lamp", 1]],
  library: [["bookshelf", 2], ["table", 1], ["chair", 2], ["lamp", 1]],
  reading: [["bookshelf", 1], ["table", 1], ["chair", 1], ["lamp", 1]],
  cafe: [["counter", 1], ["table", 2], ["chair", 4], ["plant", 1]],
  market: [["counter", 1], ["table", 1], ["shelf", 1], ["plant", 1]],
  stall: [["counter", 1], ["shelf", 1], ["plant", 1]],
  store: [["shelf", 2], ["counter", 1], ["fridge", 1]],
  counter: [["counter", 1], ["table", 1], ["chair", 2]],
  park: [["bench", 2], ["plant_big", 2], ["plant", 2], ["lamp", 1]],
  lawn: [["bench", 1], ["plant_big", 1], ["plant", 2]],
  cabin: [["bed", 1], ["table", 1], ["chair", 1], ["lamp", 1]],
  bookstore: [["bookshelf", 3], ["shelf", 2], ["table", 1], ["chair", 2], ["plant", 1]],
  restaurant: [["table", 2], ["chair", 4], ["counter", 1], ["plant", 1]],
  bar: [["counter", 1], ["chair", 3], ["shelf", 1], ["lamp", 1]],
  cinema: [["bench", 3], ["plant", 1], ["lamp", 1]],
  gym: [["bench", 2], ["plant", 1], ["lamp", 1]],
  clinic: [["table", 1], ["chair", 2], ["shelf", 1], ["plant", 1]],
  gallery: [["bench", 2], ["plant", 2], ["lamp", 1]],
  workshop: [["table", 2], ["shelf", 2], ["chair", 2], ["lamp", 1]],
  shop: [["shelf", 2], ["counter", 1], ["fridge", 1], ["plant", 1]],
  garden: [["plant_big", 2], ["plant", 2], ["bench", 1], ["lamp", 1]],
  venue: [["counter", 1], ["table", 2], ["chair", 3], ["plant", 1], ["lamp", 1]],
};

const WALL_PROPS = {
  bedroom: ["picture", "wall_lamp"],
  bath: ["mirror", "towel"],
  living: ["picture", "clock"],
  hall: ["clock", "wall_shelf"],
  office: ["clock", "picture"],
  meeting: ["clock", "picture"],
  library: ["picture", "wall_shelf"],
  cafe: ["picture", "clock"],
  bookstore: ["picture", "wall_shelf"],
  restaurant: ["picture", "clock"],
  bar: ["picture", "clock"],
  gallery: ["picture", "picture"],
  cinema: ["picture", "clock"],
};

const area = (r) => r.rect[2] * r.rect[3];

function roomKinds(layout, kind) {
  const set = ROOM_SETS[kind] || ROOM_SETS.home;
  if (layout.semantic) {
    return layout.rooms.map((r) => ({
      ...r,
      kind: r.kind || "venue",
      name: r.name || ROOM_SETS[kind]?.[0]?.name || "房间",
    }));
  }
  const closed = layout.rooms.filter((r) => r.corner);
  const open = layout.rooms.filter((r) => !r.corner).sort((a, b) => area(b) - area(a));
  const out = [];
  let i = 0;
  for (const r of closed) {
    const t = set[Math.min(i, set.length - 1)];
    out.push({ ...r, kind: t.kind, name: t.name });
    i++;
  }
  for (const r of open) {
    const t = set[Math.min(i, set.length - 1)];
    out.push({ ...r, kind: t.kind, name: t.name });
    i++;
  }
  return out;
}

function doorZones(doors) {
  const set = new Set();
  for (const d of doors) {
    for (let y = d.y - 1; y <= d.y + 1; y++) {
      for (let x = d.x - 1; x <= d.x + 1; x++) set.add(`${x},${y}`);
    }
  }
  return set;
}

function shuffled(list, seed) {
  const rnd = mulberry32(fnv1a(String(seed)));
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function placeProps(rooms, doors, kind, seed) {
  const props = [];
  const occupied = new Set();
  const zones = doorZones(doors);
  const can = (room, x, y, w, h) => {
    const [rx, ry, rw, rh] = room.rect;
    if (x < rx || y < ry || x + w > rx + rw || y + h > ry + rh) return false;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const k = `${xx},${yy}`;
        if (zones.has(k) || occupied.has(k)) return false;
      }
    }
    return true;
  };
  for (const room of rooms) {
    const list = PROPS_BY_ROOM[room.kind] || PROPS_BY_ROOM.venue;
    for (const [id, count] of list) {
      const [w, h] = FURNITURE_SIZES[id] || [1, 1];
      let placed = 0;
      const candidates = [];
      for (let y = room.rect[1]; y <= room.rect[1] + room.rect[3] - h; y++) {
        for (let x = room.rect[0]; x <= room.rect[0] + room.rect[2] - w; x++) {
          candidates.push([x, y]);
        }
      }
      for (const [x, y] of shuffled(candidates, `${seed}|${room.id}|${id}`)) {
        if (placed >= count) break;
        if (!can(room, x, y, w, h)) continue;
        props.push({ id, x, y, w, h, room: room.id });
        if (!NON_BLOCK.has(id)) {
          for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) occupied.add(`${xx},${yy}`);
        }
        placed++;
      }
    }
  }
  return props;
}

function placeWallProps(rooms) {
  const out = [];
  for (const room of rooms) {
    const list = WALL_PROPS[room.kind] || [];
    const [x, y, w] = room.rect;
    for (let i = 0; i < list.length; i++) {
      const wx = x + 1 + i * 2;
      if (wx >= x + w - 1) break;
      out.push({ id: list[i], x: wx, y: Math.max(0, y - 1) });
    }
  }
  return out;
}


function fillBlank3x3(areas, props, doors, seed) {
  const decor = [];
  const occupied = new Set();
  for (const p of props) {
    const pw = p.w || 1;
    const ph = p.h || 1;
    for (let yy = p.y; yy < p.y + ph; yy++) for (let xx = p.x; xx < p.x + pw; xx++) occupied.add(`${xx},${yy}`);
  }
  const doorZone = doorZones(doors);
  const rnd = mulberry32(fnv1a(`${seed}|fill`));
  let added = 0;
  for (const area of areas) {
    const [rx, ry, rw, rh] = area.rect;
    for (let y = ry; y <= ry + rh - 3; y++) {
      for (let x = rx; x <= rx + rw - 3; x++) {
        let hasDoor = false;
        let has = false;
        for (let yy = y; yy < y + 3; yy++) for (let xx = x; xx < x + 3; xx++) {
          if (doorZone.has(`${xx},${yy}`)) hasDoor = true;
          if (occupied.has(`${xx},${yy}`)) has = true;
        }
        if (hasDoor || has) continue;
        const ids = ["book", "mug", "keys", "slippers", "watering_can"];
        const cx = x + 1;
        const cy = y + 1;
        decor.push({ name: `${area.name || area.id}-小物-${added + 1}`, id: ids[added % ids.length], x: cx, y: cy, room: area.id });
        occupied.add(`${cx},${cy}`);
        added += 1;
      }
    }
  }
  return decor;
}

const SET_ALIAS = {
  cafe: "social", restaurant: "social", bar: "social", market: "lively",
  bookstore: "quiet", library: "quiet", shop: "errand", store: "errand",
  park: "nature", garden: "nature", venue: "social",
};


function freeSpot(areas, props, doors, w = 1, h = 1) {
  const occupied = new Set();
  for (const p of props) {
    const pw = p.w || 1;
    const ph = p.h || 1;
    for (let yy = p.y; yy < p.y + ph; yy++) for (let xx = p.x; xx < p.x + pw; xx++) occupied.add(`${xx},${yy}`);
  }
  const doorZone = doorZones(doors);
  for (const area of areas) {
    const [rx, ry, rw, rh] = area.rect;
    for (let y = ry; y <= ry + rh - h; y++) {
      for (let x = rx; x <= rx + rw - w; x++) {
        let ok = true;
        for (let yy = y; yy < y + h && ok; yy++) for (let xx = x; xx < x + w; xx++) {
          if (occupied.has(`${xx},${yy}`) || doorZone.has(`${xx},${yy}`)) { ok = false; break; }
        }
        if (ok) return { x, y, room: area.id };
      }
    }
  }
  return null;
}

function ensureDensity(areas, props, doors, kind, seed) {
  for (const area of areas) {
    const need = Math.max(4, Math.ceil(((area.rect[2] || 0) * (area.rect[3] || 0)) / 12));
    let count = props.filter((p) => p.room === area.id).length;
    let guard = 0;
    while (count < need && guard++ < 40) {
      const spot = freeSpot([area], props, doors, 1, 1);
      if (!spot) break;
      const fillIds = ["chair", "plant", "lamp", "shelf"];
      const fillId = fillIds[count % fillIds.length];
      props.push({ name: `${area.name || area.id}-${fillId}-${count + 1}`, id: fillId, x: spot.x, y: spot.y, w: 1, h: 1, room: area.id });
      count += 1;
    }
  }
  if (kind === "cafe") {
    let tables = props.filter((p) => p.id === "table").length;
    let guard = 0;
    while (tables < 2 && guard++ < 20) {
      const spot = freeSpot(areas, props, doors, 2, 2);
      if (!spot) break;
      props.push({ name: `咖啡区-桌子-${tables + 1}`, id: "table", x: spot.x, y: spot.y, w: 2, h: 2, room: spot.room });
      tables += 1;
    }
  }
}
export function buildOpenSceneSpec(layout, { kind = "cafe", name = "未命名场景", seed = "map" } = {}) {
  const set = ROOM_SETS[kind] || ROOM_SETS[SET_ALIAS[kind]] || ROOM_SETS.venue;
  const closed = (layout.rooms || []).map((r, i) => ({
    ...r,
    kind: set[Math.min(i, set.length - 1)]?.kind || "venue",
    name: r.name || set[Math.min(i, set.length - 1)]?.name || `房间${i + 1}`,
  }));
  const zoneKinds = ["cafe", "lounge", "counter", "reading", "hall", "balcony", "cafe", "reading", "lounge", "hall"];
  const open = (layout.zones || []).map((z, i) => ({
    ...z,
    kind: zoneKinds[i % zoneKinds.length],
    name: z.name || `开放区${i + 1}`,
  }));
  const areas = [...closed, ...open];
  let props = placeProps(areas, layout.doors || [], kind, seed);
  const seenBig = new Set();
  props = props.filter((p) => {
    if (!BIG_ITEMS.has(p.id)) return true;
    if (p.id === "table" && ["cafe", "restaurant", "bar"].includes(kind)) return true;
    if (seenBig.has(p.id)) return false;
    seenBig.add(p.id);
    return true;
  });
  const decor = fillBlank3x3(closed, props, layout.doors || [], seed);
  ensureDensity(areas, props, layout.doors || [], kind, seed);
  if (kind === "cafe") {
    let rugs = props.filter((p) => p.id === "rug").length;
    let guard = 0;
    while (rugs < 3 && guard++ < 10) {
      const spot = freeSpot(areas, props, layout.doors || [], 4, 3);
      if (!spot) break;
      props.push({ name: `咖啡区-地毯-${rugs + 1}`, id: "rug", x: spot.x, y: spot.y, w: 4, h: 3, room: spot.room });
      rugs += 1;
    }
  }
  const wallProps = placeWallProps(closed);
  const startArea = [...areas].sort((a, b) => area(b) - area(a))[0];
  const interactions = buildInteractions(props);
  return {
    name,
    title: name,
    version: 1,
    seed,
    kind,
    grid: { w: layout.grid.w, h: layout.grid.h, cell: 16 },
    start: startArea?.id || areas[0]?.id,
    spawn: freeSpot(areas, props, layout.doors || [], 1, 1) || layout.spawn || { x: 2, y: 2 },
    rooms: closed,
    zones: open,
    doors: layout.doors || [],
    windows: layout.windows || [],
    props,
    wallProps,
    decor,
    clutter: [],
    interactions,
    routes: [],
    cleanup: { per_day: 3, min_interval_min: 45, tidy_ratio: 0.3 },
  };
}
export function buildSceneSpec(layout, { kind = "home", name = "未命名场景", seed = "map" } = {}) {
  const rooms = roomKinds(layout, kind);
  const props = placeProps(rooms, layout.doors || [], kind, seed);
  const wallProps = placeWallProps(rooms);
  const startRoom = [...rooms].sort((a, b) => area(b) - area(a))[0];
  return {
    name,
    title: name,
    version: 1,
    seed,
    kind,
    grid: { w: layout.w, h: layout.h, cell: 16 },
    start: startRoom?.id || rooms[0]?.id,
    rooms,
    zones: layout.zones || [],
    doors: layout.doors || [],
    windows: layout.windows || [],
    props,
    wallProps,
    decor: [],
    clutter: [],
    cleanup: { per_day: 3, min_interval_min: 45, tidy_ratio: 0.3 },
  };
}
