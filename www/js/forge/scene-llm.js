// LLM 完整场景 spec 的校验与规范化。
// LLM 出房间/家具/交互/路线；这里只接受已注册原语与枚举。

import { FURNITURE_SIZES } from "./furniture.js";
import { buildIntGrid } from "./scene.js";
import { ACT_DEFS, buildHotspots } from "./scenekit.js";
import { EFFECT_KINDS, REQUIRE_KINDS } from "../core/interactions.js";

export const ANIMATIONS = new Set([
  "bathe", "cook", "dress", "drink", "eat", "hang_coat", "idle", "laundry",
  "meet", "play_cat", "print", "read", "rest", "sit", "sleep", "tidy",
  "use_toilet", "walk", "wash_up", "watch_tv", "water_plants", "work",
]);

const ANIMATION_ALIAS = {
  wash: "wash_up",
  water: "water_plants",
  light: "idle",
  watch: "watch_tv",
  bath: "bathe",
  play: "play_cat",
  toilet: "use_toilet",
  write: "work",
  read: "read",
};

const NON_BLOCK = new Set(["rug", "door_mat", "bath_mat"]);
const BIG_ITEMS = new Set(["bed", "wardrobe", "dresser", "desk", "bookshelf", "sofa", "tv", "counter", "stove", "fridge", "table", "bench", "cat_tree", "coffee_table"]);

function inside(room, x, y, w, h) {
  const [rx, ry, rw, rh] = room.rect;
  return x >= rx && y >= ry && x + w <= rx + rw && y + h <= ry + rh;
}

function walkable(intGrid, w, h, x, y) {
  return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < w && y < h &&
    (intGrid[y * w + x] === 0 || intGrid[y * w + x] === 2);
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
      if (!walkable(intGrid, w, h, nx, ny)) continue;
      const j = ny * w + nx;
      if (seen[j]) continue;
      seen[j] = 1;
      q.push(j);
    }
  }
  return seen;
}

export function validateLlmScene(obj, { quality = true } = {}) {
  const errors = [];
  if (!obj || typeof obj !== "object") return ["not_object"];
  const w = obj.grid?.w;
  const h = obj.grid?.h;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 12 || h < 10) errors.push("grid");
  if (!Array.isArray(obj.rooms) || !obj.rooms.length) errors.push("rooms");
  if (!Array.isArray(obj.props)) errors.push("props");
  if (!obj.interactions?.acts) errors.push("interactions");
  if (!Array.isArray(obj.routes)) errors.push("routes");
  if (errors.length) return errors;

  const rooms = new Map();
  for (const r of [...(obj.rooms || []), ...(obj.zones || [])]) {
    if (!r.id || !Array.isArray(r.rect) || r.rect.length !== 4) {
      errors.push(`room:${r.id || "?"}`);
      continue;
    }
    const [x, y, rw, rh] = r.rect;
    if (x < 1 || y < 1 || x + rw > w - 1 || y + rh > h - 1) errors.push(`room_bounds:${r.id}`);
    rooms.set(r.id, r);
  }

  const occupied = new Set();
  const propIds = new Set();
  for (const p of obj.props) {
    const known = FURNITURE_SIZES[p.id];
    const custom = Array.isArray(p.shape);
    if (!known && !custom) {
      errors.push(`unknown_prop:${p.id}`);
      continue;
    }
    if (custom) {
      if (!Number.isInteger(p.w) || !Number.isInteger(p.h) || p.w < 1 || p.h < 1) errors.push(`custom_size:${p.id}`);
      for (const sh of p.shape) {
        if (!sh || !["rect", "ellipse", "line", "polygon"].includes(sh.kind)) errors.push(`shape_kind:${p.id}`);
        if (sh?.kind === "polygon" && !Array.isArray(sh.points)) errors.push(`shape_points:${p.id}`);
      }
    }
    const [dw, dh] = known || [p.w || 1, p.h || 1];
    const pw = Number(p.w || dw);
    const ph = Number(p.h || dh);
    const room = rooms.get(p.room);
    if (!room) {
      errors.push(`prop_room:${p.id}`);
      continue;
    }
    if (!inside(room, p.x, p.y, pw, ph)) errors.push(`prop_bounds:${p.id}`);
    if (!NON_BLOCK.has(p.id)) {
      for (let yy = p.y; yy < p.y + ph; yy++) {
        for (let xx = p.x; xx < p.x + pw; xx++) {
          const k = `${xx},${yy}`;
          if (occupied.has(k)) errors.push(`overlap:${p.id}@${k}`);
          occupied.add(k);
        }
      }
    }
    propIds.add(p.id);
  }

  for (const d of obj.doors || []) {
    if (!Number.isInteger(d.x) || !Number.isInteger(d.y)) errors.push(`door:${d.id}`);
    if (d.to !== "outside" && !rooms.has(d.to)) errors.push(`door_to:${d.id}`);
  }
  for (const win of obj.windows || []) {
    if (!Number.isInteger(win.x) || !Number.isInteger(win.y)) errors.push("window");
  }

  const acts = obj.interactions.acts;
  for (const [id, def] of Object.entries(acts)) {
    if (!def?.label) errors.push(`act_label:${id}`);
    const props = def?.trigger?.props || [];
    if (!props.length) errors.push(`act_props:${id}`);
    for (const prop of props) if (!propIds.has(prop)) errors.push(`act_prop_missing:${id}:${prop}`);
    const anim = def?.perform?.animation;
    if (ANIMATION_ALIAS[anim]) def.perform.animation = ANIMATION_ALIAS[anim];
    if (!ANIMATIONS.has(def?.perform?.animation)) errors.push(`act_animation:${id}`);
    const dur = Number(def?.perform?.duration_min);
    if (!Number.isFinite(dur) || dur < 1 || dur > 1440) errors.push(`act_duration:${id}`);
    for (const e of def?.effects || []) if (!EFFECT_KINDS.has(e.kind)) errors.push(`act_effect:${id}:${e.kind}`);
    for (const r of def?.requires || []) if (!REQUIRE_KINDS.has(r.kind)) errors.push(`act_require:${id}:${r.kind}`);
  }

  const spec = {
    ...obj,
    grid: { w, h, cell: obj.grid?.cell || 16 },
    props: obj.props.map((p) => {
      const [dw, dh] = FURNITURE_SIZES[p.id] || [p.w || 1, p.h || 1];
      return { ...p, w: p.w || dw, h: p.h || dh };
    }),
    doors: obj.doors || [],
    windows: obj.windows || [],
    zones: obj.zones || [],
    wallProps: obj.wallProps || [],
    decor: obj.decor || [],
  };
  const rows = buildIntGrid(spec);
  const intGrid = rows.join("").split("").map(Number);
  const spawn = obj.spawn || {};
  if (!walkable(intGrid, w, h, spawn.x, spawn.y)) errors.push("spawn");
  for (const route of obj.routes || []) {
    if (!Array.isArray(route.waypoints) || route.waypoints.length < 2) {
      errors.push(`route:${route.id}`);
      continue;
    }
    for (const [x, y] of route.waypoints) {
      if (!walkable(intGrid, w, h, x, y)) errors.push(`route_blocked:${route.id}@${x},${y}`);
    }
  }
  if (quality) {
    const enclosed = obj.rooms || [];
    const zones = obj.zones || [];
    if (enclosed.length < 1) errors.push("rooms_too_few");
    if (enclosed.length > 2) errors.push("rooms_too_many");
    if (zones.length < 2) errors.push("zones_too_few");
    if ((obj.props || []).length < 40) errors.push("props_too_few");
    if (!(obj.doors || []).length) errors.push("doors_missing");
    if (!(obj.windows || []).length) errors.push("windows_missing");
    if (obj.wallStyle && !["solid", "glass"].includes(obj.wallStyle)) errors.push("wall_style");
    const interior = Math.max(1, (w - 2) * (h - 2));
    const roomArea = enclosed.reduce((sum, r) => sum + (r.rect?.[2] || 0) * (r.rect?.[3] || 0), 0);
    const zoneArea = zones.reduce((sum, r) => sum + (r.rect?.[2] || 0) * (r.rect?.[3] || 0), 0);
    if ((roomArea + zoneArea) / interior < 0.7) errors.push("rooms_too_sparse");
    if (zoneArea / Math.max(1, roomArea + zoneArea) < 0.5) errors.push("open_area_too_small");
    for (const z of zones) {
      if (!z.name) errors.push(`zone_name:${z.id || "?"}`);
      if ((z.rect?.[2] || 0) * (z.rect?.[3] || 0) < 6) errors.push(`zone_too_small:${z.id || "?"}`);
    }
    if (enclosed.length === 2) {
      const [a, b] = enclosed;
      const ac = [(a.rect?.[0] || 0) + (a.rect?.[2] || 0) / 2, (a.rect?.[1] || 0) + (a.rect?.[3] || 0) / 2];
      const bc = [(b.rect?.[0] || 0) + (b.rect?.[2] || 0) / 2, (b.rect?.[1] || 0) + (b.rect?.[3] || 0) / 2];
      if (Math.abs(ac[0] - bc[0]) < 3 || Math.abs(ac[1] - bc[1]) < 3) errors.push("enclosed_rooms_not_diagonal");
      if (a.rect?.[2] === b.rect?.[2] && a.rect?.[3] === b.rect?.[3]) errors.push("enclosed_rooms_same_size");
    }
    const allAreas = [...enclosed, ...zones];
    const roomIds = new Set(allAreas.map((r) => r.id));
    for (const id of roomIds) {
      const room = allAreas.find((r) => r.id === id);
      const count = (obj.props || []).filter((p) => p.room === id).length;
      const need = Math.max(3, Math.ceil(((room?.rect?.[2] || 0) * (room?.rect?.[3] || 0)) / 16));
      if (!count) errors.push(`room_empty:${id}`);
      else if (count < need) errors.push(`room_props_too_few:${id}:${count}/${need}`);
    }
    const names = (obj.props || []).map((p) => p.name).filter(Boolean);
    if (new Set(names).size !== names.length) errors.push("prop_name_duplicate");
    const ids = new Set((obj.props || []).map((p) => p.id));
    const countOf = (id) => (obj.props || []).filter((p) => p.id === id || String(p.id).startsWith(`${id}_`)).length;
    if (obj.kind === "cafe") {
      for (const need of ["counter", "table", "chair", "plant", "rug", "lamp"]) {
        if (!countOf(need)) errors.push(`missing_prop:${need}`);
      }
      if (countOf("table") < 2) errors.push("cafe_tables_too_few");
      if (countOf("chair") < 4) errors.push("cafe_chairs_too_few");
      if (countOf("plant") < 3) errors.push("cafe_plants_too_few");
      if (countOf("rug") < 3) errors.push("cafe_rugs_too_few");
      if (countOf("lamp") < 2) errors.push("cafe_lamps_too_few");
    }
    for (const item of BIG_ITEMS) {
      if (item === "table" && ["cafe", "restaurant", "bar"].includes(obj.kind)) continue;
      if (countOf(item) > 1) errors.push(`big_item_duplicate:${item}`);
    }
    const allNames = [...(obj.rooms || []), ...(obj.zones || [])].map((r) => r.name).filter(Boolean);
    if (new Set(allNames).size !== allNames.length) errors.push("area_name_duplicate");
    const filled = new Set();
    for (const p of obj.props || []) {
      const pw = p.w || 1;
      const ph = p.h || 1;
      for (let yy = p.y; yy < p.y + ph; yy++) for (let xx = p.x; xx < p.x + pw; xx++) filled.add(`${xx},${yy}`);
    }
    for (const d of obj.decor || []) filled.add(`${d.x},${d.y}`);
    const doorClear = new Set();
    for (const d of obj.doors || []) {
      for (let yy = d.y - 1; yy <= d.y + 1; yy++) for (let xx = d.x - 1; xx <= d.x + 1; xx++) doorClear.add(`${xx},${yy}`);
    }
    for (const d of obj.doors || []) {
      for (const p of obj.props || []) {
        if (NON_BLOCK.has(p.id)) continue;
        const pw = p.w || 1;
        const ph = p.h || 1;
        let hit = false;
        for (let yy = p.y; yy < p.y + ph && !hit; yy++) for (let xx = p.x; xx < p.x + pw; xx++) if (doorClear.has(`${xx},${yy}`)) { hit = true; break; }
        if (hit) errors.push(`door_clearance:${d.id}:${p.name || p.id}`);
      }
    }
    let blanks = 0;
    for (const area of (obj.rooms || [])) {
      const [rx, ry, rw, rh] = area.rect || [];
      for (let y = ry; y <= ry + rh - 3; y++) {
        for (let x = rx; x <= rx + rw - 3; x++) {
          let skip = false;
          for (let yy = y; yy < y + 3 && !skip; yy++) for (let xx = x; xx < x + 3; xx++) if (doorClear.has(`${xx},${yy}`)) { skip = true; break; }
          if (skip) continue;
          let has = false;
          for (let yy = y; yy < y + 3 && !has; yy++) for (let xx = x; xx < x + 3; xx++) if (filled.has(`${xx},${yy}`)) { has = true; break; }
          if (!has && blanks < 5) {
            errors.push(`blank_3x3:${area.id || "?"}@${x},${y}`);
            blanks += 1;
          }
        }
      }
    }
  }
  return errors;
}

export function fitSceneGrid(input, w, h) {
  const obj = JSON.parse(JSON.stringify(input || {}));
  const ow = obj.grid?.w;
  const oh = obj.grid?.h;
  if (!Number.isInteger(ow) || !Number.isInteger(oh) || ow === w && oh === h) return obj;
  const sx = w / ow;
  const sy = h / oh;
  const px = (v) => Math.max(1, Math.min(w - 2, Math.round(v * sx)));
  const py = (v) => Math.max(1, Math.min(h - 2, Math.round(v * sy)));
  const pw = (v) => Math.max(1, Math.round(v * sx));
  const ph = (v) => Math.max(1, Math.round(v * sy));
  obj.grid = { ...(obj.grid || {}), w, h };
  obj.rooms = (obj.rooms || []).map((r) => {
    const [x, y, rw, rh] = r.rect || [1, 1, ow - 2, oh - 2];
    return { ...r, rect: [px(x), py(y), Math.max(2, pw(rw)), Math.max(2, ph(rh))] };
  });
  obj.props = (obj.props || []).map((p) => ({ ...p, x: px(p.x), y: py(p.y), w: pw(p.w || 1), h: ph(p.h || 1) }));
  obj.doors = (obj.doors || []).map((d) => ({ ...d, x: px(d.x), y: py(d.y) }));
  obj.windows = (obj.windows || []).map((win) => ({ ...win, x: px(win.x), y: py(win.y) }));
  if (obj.spawn) obj.spawn = { x: px(obj.spawn.x), y: py(obj.spawn.y) };
  obj.routes = (obj.routes || []).map((r) => ({
    ...r,
    from: Array.isArray(r.from) ? [px(r.from[0]), py(r.from[1])] : r.from,
    to: Array.isArray(r.to) ? [px(r.to[0]), py(r.to[1])] : r.to,
    waypoints: (r.waypoints || []).map(([x, y]) => [px(x), py(y)]),
  }));
  return obj;
}

function nearestWalkable(intGrid, w, h, x, y) {
  if (walkable(intGrid, w, h, x, y)) return [x, y];
  for (let r = 1; r < Math.max(w, h); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (walkable(intGrid, w, h, nx, ny)) return [nx, ny];
      }
    }
  }
  return [1, 1];
}

function bfsPath(intGrid, w, h, sx, sy, tx, ty) {
  if (!walkable(intGrid, w, h, sx, sy) || !walkable(intGrid, w, h, tx, ty)) return null;
  const prev = new Int32Array(w * h).fill(-1);
  const seen = new Uint8Array(w * h);
  const q = [sy * w + sx];
  seen[sy * w + sx] = 1;
  while (q.length) {
    const i = q.shift();
    if (i === ty * w + tx) {
      const path = [];
      let cur = i;
      while (cur !== -1) {
        path.push([cur % w, Math.floor(cur / w)]);
        cur = prev[cur];
      }
      return path.reverse();
    }
    const x = i % w;
    const y = Math.floor(i / w);
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (!walkable(intGrid, w, h, nx, ny)) continue;
      const j = ny * w + nx;
      if (seen[j]) continue;
      seen[j] = 1;
      prev[j] = i;
      q.push(j);
    }
  }
  return null;
}

function normalizeLlmScene(input) {
  const obj = JSON.parse(JSON.stringify(input || {}));
  const w = obj.grid?.w;
  const h = obj.grid?.h;
  if (!Number.isInteger(w) || !Number.isInteger(h)) return obj;
  const rooms = new Map([...(obj.rooms || []), ...(obj.zones || [])].map((r) => [r.id, r]));
  const occupied = new Set();
  const props = [];
  for (const p of obj.props || []) {
    const size = FURNITURE_SIZES[p.id];
    const custom = Array.isArray(p.shape);
    const room = rooms.get(p.room);
    if ((!size && !custom) || !room) continue;
    const pw = p.w || size?.[0] || 1;
    const ph = p.h || size?.[1] || 1;
    if (!inside(room, p.x, p.y, pw, ph)) continue;
    if (!NON_BLOCK.has(p.id)) {
      let clash = false;
      for (let yy = p.y; yy < p.y + ph && !clash; yy++) {
        for (let xx = p.x; xx < p.x + pw; xx++) if (occupied.has(`${xx},${yy}`)) { clash = true; break; }
      }
      if (clash) continue;
      for (let yy = p.y; yy < p.y + ph; yy++) for (let xx = p.x; xx < p.x + pw; xx++) occupied.add(`${xx},${yy}`);
    }
    props.push({ ...p, w: pw, h: ph });
  }
  obj.props = props;
  const propIds = new Set(props.map((p) => p.id));
  for (const [id, def] of Object.entries(obj.interactions?.acts || {})) {
    def.trigger = def.trigger || { props: [] };
    def.trigger.props = (def.trigger.props || []).filter((p) => propIds.has(p));
    if (!def.trigger.props.length) delete obj.interactions.acts[id];
  }
  const spec = { ...obj, props, doors: obj.doors || [], windows: obj.windows || [] };
  const intGrid = buildIntGrid(spec).join("").split("").map(Number);
  const [sx, sy] = nearestWalkable(intGrid, w, h, obj.spawn?.x ?? 1, obj.spawn?.y ?? 1);
  obj.spawn = { x: sx, y: sy };
  obj.routes = (obj.routes || []).map((route) => {
    const from = Array.isArray(route.from) ? route.from : [route.from?.x, route.from?.y];
    const to = Array.isArray(route.to) ? route.to : [route.to?.x, route.to?.y];
    const path = bfsPath(intGrid, w, h, from[0], from[1], to[0], to[1]);
    return path ? { ...route, from, to, waypoints: path } : null;
  }).filter(Boolean);
  return obj;
}

export function buildSceneFromLlm(input, options = {}) {
  const fitted = options.grid ? fitSceneGrid(input, options.grid.w, options.grid.h) : input;
  const obj = normalizeLlmScene(fitted);
  const errors = validateLlmScene(obj, options);
  if (errors.length) return { ok: false, errors };
  const w = obj.grid.w;
  const h = obj.grid.h;
  const spec = {
    ...obj,
    grid: { w, h, cell: obj.grid.cell || 16 },
    props: obj.props.map((p) => {
      const [dw, dh] = FURNITURE_SIZES[p.id] || [p.w || 1, p.h || 1];
      return { ...p, w: p.w || dw, h: p.h || dh };
    }),
    wallProps: obj.wallProps || [],
    decor: obj.decor || [],
    clutter: obj.clutter || [],
  };
  const intGrid = buildIntGrid(spec).join("").split("").map(Number);
  const scene = {
    ...spec,
    w,
    h,
    semantic: true,
    intGrid,
    interactions: obj.interactions,
    routes: obj.routes || [],
    entities: [
      { type: "spawn", x: obj.spawn.x, y: obj.spawn.y },
      ...(obj.doors || []).map((d) => ({ type: "door", x: d.x, y: d.y, to: d.to })),
    ],
    meta: { ...(obj.meta || {}), source: "llm" },
    spec,
  };
  const seen = reachable(intGrid, w, h, obj.spawn.y * w + obj.spawn.x);
  const hotspots = buildHotspots(scene, obj.interactions).filter((h) => seen[h.y * w + h.x]);
  const liveActs = new Set(hotspots.map((h) => h.act));
  scene.interactions = {
    ...obj.interactions,
    acts: Object.fromEntries(Object.entries(obj.interactions.acts || {}).filter(([id]) => liveActs.has(id))),
  };
  scene.entities.push(...hotspots);
  return { ok: true, scene };
}
