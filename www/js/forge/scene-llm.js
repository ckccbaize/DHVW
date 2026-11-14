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

export function validateLlmScene(obj) {
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
  for (const r of obj.rooms) {
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
    if (!FURNITURE_SIZES[p.id]) {
      errors.push(`unknown_prop:${p.id}`);
      continue;
    }
    const [dw, dh] = FURNITURE_SIZES[p.id];
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
      const [dw, dh] = FURNITURE_SIZES[p.id] || [1, 1];
      return { ...p, w: p.w || dw, h: p.h || dh };
    }),
    doors: obj.doors || [],
    windows: obj.windows || [],
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
  const seen = walkable(intGrid, w, h, spawn.x, spawn.y) ? reachable(intGrid, w, h, spawn.y * w + spawn.x) : null;
  if (seen) {
    const scene = { ...spec, w, h, intGrid, interactions: obj.interactions };
    for (const hot of buildHotspots(scene, obj.interactions)) {
      if (!seen[hot.y * w + hot.x]) errors.push(`hotspot_unreachable:${hot.act}@${hot.x},${hot.y}`);
    }
  }
  return errors;
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
  const rooms = new Map((obj.rooms || []).map((r) => [r.id, r]));
  const occupied = new Set();
  const props = [];
  for (const p of obj.props || []) {
    const size = FURNITURE_SIZES[p.id];
    const room = rooms.get(p.room);
    if (!size || !room) continue;
    const pw = p.w || size[0];
    const ph = p.h || size[1];
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

export function buildSceneFromLlm(input) {
  const obj = normalizeLlmScene(input);
  const errors = validateLlmScene(obj);
  if (errors.length) return { ok: false, errors };
  const w = obj.grid.w;
  const h = obj.grid.h;
  const spec = {
    ...obj,
    grid: { w, h, cell: obj.grid.cell || 16 },
    props: obj.props.map((p) => {
      const [dw, dh] = FURNITURE_SIZES[p.id] || [1, 1];
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
  scene.entities.push(...buildHotspots(scene, obj.interactions));
  return { ok: true, scene };
}
