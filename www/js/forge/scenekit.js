// MapForge 端侧生成器：DSL → 32×24 单房间场景 + 家具 + 交互 + 热点。
// 模型只出 DSL；坐标/碰撞/家具由本地文法确定性生成。

import { FURNITURE_SIZES } from "./furniture.js";
import { buildIntGrid } from "./scene.js";
import { fnv1a, mulberry32 } from "./grammar.js";
import { parseDsl, SIZES } from "./dsl.js";

const ARCH_NAME = {
  bedroom: "卧室", study: "书房", kitchen: "厨房", living: "客厅",
  entry: "玄关", balcony: "阳台", shop: "街角小店", park: "公园",
};

const ARCH_PROPS = {
  bedroom: { req: ["bed", "wardrobe", "lamp"], opt: ["plant", "rug", "shelf", "chair"], minHot: 2 },
  study: { req: ["desk", "bookshelf", "chair", "lamp"], opt: ["plant", "rug", "shelf", "sofa"], minHot: 3 },
  kitchen: { req: ["counter", "fridge", "stove", "table"], opt: ["plant", "chair"], minHot: 3 },
  living: { req: ["sofa", "tv", "table"], opt: ["plant", "rug", "lamp", "shelf"], minHot: 3 },
  entry: { req: ["shelf", "plant", "lamp"], opt: ["rug", "door_mat", "chair"], minHot: 2 },
  balcony: { req: ["chair", "plant", "table"], opt: ["plant_big", "lamp", "bench"], minHot: 2 },
  shop: { req: ["counter", "shelf", "plant", "lamp"], opt: ["rug", "shelf", "chair"], minHot: 3 },
  park: { req: ["bench", "plant_big", "plant"], opt: ["plant", "lamp", "bench"], minHot: 2 },
};

const ACT_DEFS = {
  sleep: { label: "睡觉", animation: "sleep", duration: 480, priority: 10, effects: [{ kind: "event", name: "sleep" }] },
  read: { label: "阅读", animation: "read", duration: 25, priority: 5, effects: [{ kind: "event", name: "read" }] },
  work: { label: "工作", animation: "work", duration: 45, priority: 6, effects: [{ kind: "event", name: "work" }] },
  cook: { label: "做饭", animation: "cook", duration: 35, priority: 5, effects: [{ kind: "event", name: "cook" }] },
  eat: { label: "吃饭", animation: "eat", duration: 30, priority: 4, effects: [{ kind: "event", name: "eat" }] },
  watch: { label: "看电视", animation: "watch_tv", duration: 30, priority: 4, effects: [{ kind: "event", name: "watch" }] },
  rest: { label: "休息", animation: "rest", duration: 20, priority: 3, effects: [{ kind: "event", name: "rest" }] },
  dress: { label: "换衣", animation: "dress", duration: 10, priority: 3, effects: [{ kind: "event", name: "dress" }] },
  bath: { label: "洗澡", animation: "bathe", duration: 25, priority: 3, effects: [{ kind: "event", name: "bath" }] },
  wash: { label: "洗漱", animation: "wash_up", duration: 10, priority: 2, effects: [{ kind: "event", name: "wash" }] },
  laundry: { label: "洗衣", animation: "laundry", duration: 40, priority: 2, effects: [{ kind: "event", name: "laundry" }] },
  water: { label: "浇水", animation: "water_plants", duration: 10, priority: 2, effects: [{ kind: "event", name: "water" }] },
  play: { label: "逗猫", animation: "play_cat", duration: 15, priority: 3, effects: [{ kind: "event", name: "play" }] },
  sit: { label: "坐下", animation: "sit", duration: 10, priority: 2, effects: [{ kind: "event", name: "sit" }] },
  light: { label: "开灯", animation: "idle", duration: 5, priority: 1, effects: [{ kind: "event", name: "light" }] },
  toilet: { label: "上厕所", animation: "use_toilet", duration: 5, priority: 2, effects: [{ kind: "event", name: "toilet" }] },
};

const PROP_ACT = {
  bed: "sleep", wardrobe: "dress", dresser: "dress", lamp: "light",
  shelf: "read", bookshelf: "read", desk: "work", table: "eat",
  counter: "cook", stove: "cook", fridge: "cook", sofa: "rest",
  armchair: "rest", tv: "watch", chair: "sit", bench: "sit",
  plant: "water", plant_big: "water", cat_tree: "play",
  bathtub: "bath", sink: "wash", toilet: "toilet", washer: "laundry",
};

const NON_BLOCK = new Set(["rug", "door_mat", "bath_mat"]);

const FEATURE_PROPS = {
  old_books: ["bookshelf"],
  window_seat: ["chair"],
  fresh_flowers: ["plant"],
  warm_lamp: ["lamp"],
  cat_corner: ["cat_tree"],
  laundry: ["washer"],
  clutter: ["shelf"],
  dust_motes: ["lamp"],
  rain_sound: ["chair"],
  open_window: ["plant"],
  morning_light: ["plant"],
  street_noise: ["shelf"],
};

function shuffled(list, seed) {
  const rnd = mulberry32(fnv1a(String(seed)));
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function placeProps(spec, dsl, seed) {
  const { w, h, rooms, doors } = spec;
  const room = rooms[0];
  const [rx, ry, rw, rh] = room.rect;
  const occupied = new Set();
  const noBuild = new Set();
  for (const d of doors) {
    for (let y = d.y - 1; y <= d.y + 1; y++) {
      for (let x = d.x - 1; x <= d.x + 1; x++) noBuild.add(`${x},${y}`);
    }
  }
  const can = (x, y, pw, ph) => {
    if (x < rx || y < ry || x + pw > rx + rw || y + ph > ry + rh) return false;
    for (let yy = y; yy < y + ph; yy++) {
      for (let xx = x; xx < x + pw; xx++) {
        const k = `${xx},${yy}`;
        if (occupied.has(k) || noBuild.has(k)) return false;
      }
    }
    return true;
  };
  const props = [];
  const def = ARCH_PROPS[dsl.arch];
  const want = [...def.req];
  const opt = shuffled(def.opt, `${seed}|opt`).slice(0, 2 + Math.floor(mulberry32(fnv1a(seed))() * 3));
  want.push(...opt);
  for (const f of dsl.features || []) want.push(...(FEATURE_PROPS[f] || []));
  if (dsl.focus && !want.includes(dsl.focus)) want.push(dsl.focus);
  const unique = [...new Set(want)];

  for (const id of unique) {
    const [pw, ph] = FURNITURE_SIZES[id] || [1, 1];
    const candidates = [];
    for (let y = ry; y <= ry + rh - ph; y++) {
      for (let x = rx; x <= rx + rw - pw; x++) candidates.push([x, y]);
    }
    for (const [x, y] of shuffled(candidates, `${seed}|${id}|${props.length}`)) {
      if (!can(x, y, pw, ph)) continue;
      props.push({ id, x, y, w: pw, h: ph, room: room.id });
      if (!NON_BLOCK.has(id)) {
        for (let yy = y; yy < y + ph; yy++) for (let xx = x; xx < x + pw; xx++) occupied.add(`${xx},${yy}`);
      }
      break;
    }
  }
  return props;
}

export function buildInteractions(props) {
  const acts = {};
  for (const p of props) {
    const act = PROP_ACT[p.id];
    if (!act || !ACT_DEFS[act]) continue;
    if (!acts[act]) {
      const d = ACT_DEFS[act];
      acts[act] = {
        label: d.label,
        trigger: { props: [p.id] },
        perform: { animation: d.animation, duration_min: d.duration, interruptible: true },
        effects: d.effects,
        priority: d.priority,
      };
    } else if (!acts[act].trigger.props.includes(p.id)) {
      acts[act].trigger.props.push(p.id);
    }
  }
  return { schema_version: 1, acts };
}

export function buildHotspots(scene, interactions) {
  const { w, h, intGrid, rooms } = scene;
  const room = rooms[0];
  const out = [];
  const seen = new Set();
  for (const [act, def] of Object.entries(interactions.acts)) {
    for (const propId of def.trigger.props) {
      for (const p of scene.props.filter((x) => x.id === propId)) {
        for (const [dx, dy] of [[0, 1], [-1, 0], [1, 0], [0, -1]]) {
          const x = p.x + dx;
          const y = p.y + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (intGrid[y * w + x] !== 0) continue;
          const k = `${x},${y},${act}`;
          if (seen.has(k)) continue;
          seen.add(k);
          out.push({ type: "hotspot", x, y, prop: propId, act, room: room.id });
        }
      }
    }
  }
  return out;
}

function reachable(intGrid, w, h, start) {
  const seen = new Uint8Array(w * h);
  const q = [start];
  seen[start] = 1;
  while (q.length) {
    const i = q.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (seen[j] || (intGrid[j] !== 0 && intGrid[j] !== 2)) continue;
      seen[j] = 1;
      q.push(j);
    }
  }
  return seen;
}

export function buildSceneFromDsl(dslInput, seed = "scene") {
  const parsed = parseDsl(dslInput);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const [w, h] = SIZES[parsed.size];
  const room = {
    id: parsed.arch,
    kind: parsed.arch,
    name: ARCH_NAME[parsed.arch],
    rect: [1, 1, w - 2, h - 2],
    floor: parsed.palette === "green_outdoor" ? "stone" : parsed.palette === "cool_plaster" ? "tile" : "wood",
    unlock: { type: "start" },
    story: "",
  };
  const rnd = mulberry32(fnv1a(`${seed}|${parsed.dsl}`));
  const doorX = 2 + Math.floor(rnd() * (w - 4));
  const doors = [{ id: "door", x: doorX, y: h - 1, to: "outside" }];
  const windows = [];
  for (let x = 3; x < w - 3; x += 6) windows.push({ x, y: 0 });
  const spec = {
    name: ARCH_NAME[parsed.arch],
    title: ARCH_NAME[parsed.arch],
    version: 1,
    w,
    h,
    grid: { w, h, cell: 16 },
    start: room.id,
    rooms: [room],
    zones: [],
    doors,
    windows,
    props: [],
    wallProps: [],
    decor: [],
    clutter: [],
    meta: parsed,
    lightKey: parsed.light,
    palette: parsed.palette,
  };
  spec.props = placeProps(spec, parsed, seed);
  const rows = buildIntGrid(spec);
  const intGrid = rows.join("").split("").map(Number);
  const spawnX = doorX;
  const spawnY = h - 2;
  const spawn = intGrid[spawnY * w + spawnX] === 0 ? [spawnX, spawnY] : [Math.floor(w / 2), Math.floor(h / 2)];
  const interactions = buildInteractions(spec.props);
  const scene = {
    ...spec,
    kind: parsed.arch,
    seed: `${seed}|${parsed.dsl}`,
    semantic: true,
    intGrid,
    interactions,
    entities: [
      { type: "spawn", x: spawn[0], y: spawn[1] },
      ...doors.map((d) => ({ type: "door", x: d.x, y: d.y, to: d.to })),
    ],
    meta: {
      ...parsed,
      created_at: 0,
      spawn: { x: spawn[0], y: spawn[1] },
    },
  };
  scene.entities.push(...buildHotspots(scene, interactions));
  scene.spec = spec;
  const seen = reachable(intGrid, w, h, spawn[1] * w + spawn[0]);
  const hotspots = scene.entities.filter((e) => e.type === "hotspot");
  const reachableHot = hotspots.filter((e) => seen[e.y * w + e.x]);
  const minHot = ARCH_PROPS[parsed.arch].minHot;
  const focus = parsed.focus;
  const focusOk = !focus || scene.props.some((p) => p.id === focus);
  const report = {
    arch: parsed.arch,
    size: parsed.size,
    props: scene.props.length,
    hotspots: hotspots.length,
    reachableHotspots: reachableHot.length,
    minHot,
    focus,
    focusOk,
  };
  if (intGrid[spawn[1] * w + spawn[0]] !== 0) return { ok: false, reason: "spawn_blocked", report, scene };
  if (reachableHot.length < minHot) return { ok: false, reason: "hotspots_unreachable", report, scene };
  if (!focusOk) return { ok: false, reason: "focus_missing", report, scene };
  return { ok: true, scene, report };
}

export function produceScene({ seed = "scene", dsl, intent } = {}) {
  const r = buildSceneFromDsl(dsl, seed);
  if (!r.ok) return r;
  if (intent && !r.scene.interactions.acts[intent]) {
    return { ok: false, reason: `intent_missing:${intent}`, report: r.report };
  }
  return { ok: true, scene: r.scene, report: r.report };
}
