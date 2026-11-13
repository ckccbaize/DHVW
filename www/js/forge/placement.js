// 家具落位校验（W31+）：AI 给 props，设备校验后才允许渲染。
import { FURNITURE_SIZES } from "./furniture.js";

const WALL_HUG = new Set([
  "bed", "wardrobe", "dresser", "bookshelf", "counter", "stove", "fridge",
  "bathtub", "toilet", "sink", "washer", "tv", "desk", "shelf", "cat_tree",
]);
const NON_BLOCK = new Set(["rug", "door_mat", "bath_mat"]);

function roomAt(rooms, x, y) {
  for (const r of rooms) {
    const [rx, ry, rw, rh] = r.rect;
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) return r;
  }
  return null;
}

export function validatePlacement({ rooms = [], doors = [], props = [], furnitureDefs = {} }) {
  const errors = [];
  const occupied = new Map();
  const seenBig = new Set();

  for (const p of props) {
    const size = furnitureDefs[p.id]?.size || FURNITURE_SIZES[p.id];
    if (!size) {
      errors.push(`unknown_furniture:${p.id}`);
      continue;
    }
    const [w, h] = size;
    const room = roomAt(rooms, p.x, p.y);
    if (!room) {
      errors.push(`out_of_room:${p.id}@${p.x},${p.y}`);
      continue;
    }
    for (let dy = 0; dy < h; dy++) {
      for (let dx = 0; dx < w; dx++) {
        const x = p.x + dx;
        const y = p.y + dy;
        if (!roomAt(rooms, x, y)) errors.push(`cross_wall:${p.id}@${x},${y}`);
        if (NON_BLOCK.has(p.id)) continue;
        const k = `${x},${y}`;
        if (occupied.has(k)) errors.push(`overlap:${p.id}@${k}`);
        occupied.set(k, p.id);
      }
    }
    if (WALL_HUG.has(p.id)) {
      if (seenBig.has(p.id)) errors.push(`duplicate_big:${p.id}`);
      seenBig.add(p.id);
      let touch = false;
      for (let yy = p.y - 1; yy <= p.y + h; yy++) {
        for (let xx = p.x - 1; xx <= p.x + w; xx++) {
          if (!roomAt(rooms, xx, yy)) touch = true;
        }
      }
      if (!touch) errors.push(`not_wall_hug:${p.id}`);
    }
  }

  for (const d of doors) {
    for (let yy = d.y - 1; yy <= d.y + 1; yy++) {
      for (let xx = d.x - 1; xx <= d.x + 1; xx++) {
        if (xx === d.x && yy === d.y) continue;
        const who = occupied.get(`${xx},${yy}`);
        if (who) errors.push(`door_blocked:${d.id}:${who}`);
      }
    }
  }
  return errors;
}

export function applyPlacement(spec, props) {
  return {
    ...spec,
    props: props.map((p) => {
      const size = spec.furnitureDefs?.[p.id]?.size || FURNITURE_SIZES[p.id] || [1, 1];
      return { ...p, w: p.w || size[0], h: p.h || size[1] };
    }),
  };
}
