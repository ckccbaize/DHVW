// 场景合成（W31）：三层图 + 合成图 + 2x + built.json，全部在 JS 内完成。
import { paintFurniture } from "./furniture.js";
import { paintLight, paintTerrain, T } from "./painter.js";

const NON_BLOCK = new Set(["rug", "door_mat", "bath_mat"]);

export function buildIntGrid(spec) {
  const W = spec.grid.w;
  const H = spec.grid.h;
  const roomOf = Array.from({ length: H }, () => Array(W).fill(null));
  for (const r of [...(spec.rooms || []), ...(spec.zones || [])]) {
    const [x, y, w, h] = r.rect;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) roomOf[yy][xx] = r.id;
  }
  const doors = new Set(spec.doors.map((d) => `${d.x},${d.y}`));
  const windows = new Set(spec.windows.map((w) => `${w.x},${w.y}`));
  const blocked = new Set();
  for (const p of spec.props || []) {
    if (NON_BLOCK.has(p.id)) continue;
    const w = p.w || 1;
    const h = p.h || 1;
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) blocked.add(`${p.x + dx},${p.y + dy}`);
  }
  const rows = [];
  for (let y = 0; y < H; y++) {
    let row = "";
    for (let x = 0; x < W; x++) {
      const k = `${x},${y}`;
      if (doors.has(k)) row += "2";
      else if (windows.has(k)) row += "3";
      else if (roomOf[y][x] && !blocked.has(k)) row += "0";
      else row += "1";
    }
    rows.push(row);
  }
  return rows;
}

export function alphaOver(dst, src) {
  for (let i = 0; i < dst.data.length; i += 4) {
    const sa = src.data[i + 3] / 255;
    if (sa === 0) continue;
    const da = dst.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) continue;
    for (let c = 0; c < 3; c++) {
      dst.data[i + c] = Math.round((src.data[i + c] * sa + dst.data[i + c] * da * (1 - sa)) / oa);
    }
    dst.data[i + 3] = Math.round(oa * 255);
  }
  return dst;
}

export function composeImage(terrain, furniture, light) {
  const out = { w: terrain.w, h: terrain.h, data: new Uint8ClampedArray(terrain.data) };
  alphaOver(out, furniture);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = Math.min(255, out.data[i] + light.data[i]);
    out.data[i + 1] = Math.min(255, out.data[i + 1] + light.data[i + 1]);
    out.data[i + 2] = Math.min(255, out.data[i + 2] + light.data[i + 2]);
    out.data[i + 3] = 255;
  }
  return out;
}

export function scale2x(cv) {
  const w = cv.w * 2;
  const h = cv.h * 2;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y >> 1) * cv.w + (x >> 1)) * 4;
      const di = (y * w + x) * 4;
      data[di] = cv.data[si];
      data[di + 1] = cv.data[si + 1];
      data[di + 2] = cv.data[si + 2];
      data[di + 3] = cv.data[si + 3];
    }
  }
  return { w, h, data };
}

export function buildBuilt(spec, intGrid) {
  const name = spec.name || "scene";
  return {
    name,
    title: spec.title || name,
    version: spec.version || 1,
    grid: spec.grid,
    start: spec.start || spec.rooms?.[0]?.id || "home",
    cleanup: spec.cleanup || { per_day: 2, min_interval_min: 60, tidy_ratio: 0.5 },
    image: `${name}.png`,
    image2x: `${name}@2x.png`,
    sprites: "sprites.png",
    layers: { terrain: "terrain.png", furniture: "furniture.png", light: "light_day.png" },
    lightKey: "day",
    intGrid,
    rooms: spec.rooms,
    doors: spec.doors,
    windows: spec.windows,
    props: spec.props || [],
    wallProps: spec.wallProps || [],
    decor: spec.decor || [],
    clutter: spec.clutter || [],
  };
}

export function buildScene(spec) {
  const terrain = paintTerrain(spec);
  const furniture = paintFurniture(spec);
  const light = paintLight(spec);
  const image = composeImage(terrain, furniture, light);
  const image2x = scale2x(image);
  const intGrid = buildIntGrid(spec);
  return { terrain, furniture, light, image, image2x, built: buildBuilt(spec, intGrid) };
}
