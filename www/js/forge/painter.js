// 地形层 painter（W31 第一批）：paint_home.py 的 JS 移植（地板/墙/门/窗/栏杆/墙脚阴影）。
// 只处理 terrain 层；家具/装饰/光照后续批次。
// 目标：同 spec 与 Python terrain.png 逐像素一致。

import { drawFurnitureDef, validateFurnitureDef } from "./shapes.js";

export const T = 16;

const WOOD = [
  [58, 40, 32],
  [92, 62, 44],
  [128, 88, 58],
  [164, 120, 78],
  [196, 154, 104],
];
const WALL = [
  [70, 60, 70],
  [102, 86, 92],
  [138, 118, 114],
  [174, 152, 136],
  [206, 186, 162],
];
const FLOOR = [
  [86, 56, 42],
  [118, 82, 56],
  [150, 110, 72],
  [180, 140, 96],
];
const TILE = [
  [82, 88, 100],
  [114, 120, 132],
  [146, 152, 162],
  [178, 184, 192],
];
const STONE = [
  [86, 84, 92],
  [118, 116, 124],
  [150, 148, 154],
  [180, 178, 182],
];
const CREAM = [228, 210, 178];
const INK = [46, 34, 36];

export function createCanvas(w, h, fill = [0, 0, 0, 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3] ?? 255;
  }
  return { w, h, data };
}

export function put(cv, x, y, c) {
  if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
  const i = (y * cv.w + x) * 4;
  // PIL ImageDraw 在 RGBA 上是直接写像素（不混合 alpha），这里保持一致。
  cv.data[i] = c[0];
  cv.data[i + 1] = c[1];
  cv.data[i + 2] = c[2];
  cv.data[i + 3] = c[3] ?? 255;
}

export function rect(cv, x, y, w, h, c) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(cv, xx, yy, c);
}

function hline(cv, x0, x1, y, c) {
  for (let x = x0; x <= x1; x++) put(cv, x, y, c);
}

function vline(cv, x, y0, y1, c) {
  for (let y = y0; y <= y1; y++) put(cv, x, y, c);
}

function outline(cv, x, y, w, h, c) {
  hline(cv, x, x + w - 1, y, c);
  hline(cv, x, x + w - 1, y + h - 1, c);
  vline(cv, x, y, y + h - 1, c);
  vline(cv, x + w - 1, y, y + h - 1, c);
}

export function paintFloor(cv, x0, y0, w, h, kind) {
  for (let cy = 0; cy < h; cy++) {
    for (let cx = 0; cx < w; cx++) {
      const x = (x0 + cx) * T;
      const y = (y0 + cy) * T;
      if (kind === "wood") {
        for (let b = 0; b < 4; b++) {
          const n = (x0 + cx + (y0 + cy) * 3 + b * 5) % 4;
          rect(cv, x, y + b * 4, T, 4, FLOOR[[1, 2, 1, 0][n]]);
          hline(cv, x, x + T - 1, y + b * 4, FLOOR[0]);
          if (n === 2) hline(cv, x + 2, x + 9, y + b * 4 + 1, FLOOR[3]);
        }
        if ((x0 + cx) % 3 === 0) vline(cv, x, y, y + T - 1, FLOOR[0]);
      } else if (kind === "carpet") {
        const n = (x0 + cx * 3 + y0 + cy) % 4;
        rect(cv, x, y, T, T, n % 2 ? [96, 102, 116] : [104, 110, 124]);
        hline(cv, x, x + T - 1, y + 7, [88, 94, 108]);
        vline(cv, x + 7, y, y + T - 1, [88, 94, 108]);
        if (n === 0) rect(cv, x + 3, y + 3, 2, 2, [112, 118, 132]);
      } else if (kind === "tile") {
        rect(cv, x, y, T, T, TILE[1]);
        rect(cv, x + 1, y + 1, 7, 7, TILE[2]);
        rect(cv, x + 8, y + 8, 7, 7, TILE[2]);
        hline(cv, x, x + T - 1, y + 8, TILE[0]);
        vline(cv, x + 8, y, y + T - 1, TILE[0]);
      } else {
        const n = (x0 + cx * 2 + y0 + cy * 3) % 3;
        rect(cv, x, y, T, T, STONE[[1, 2, 1][n]]);
        hline(cv, x, x + T - 1, y + 7, STONE[0]);
        vline(cv, x + 7, y, y + T - 1, STONE[0]);
        if (n === 2) rect(cv, x + 3, y + 3, 2, 2, STONE[0]);
      }
    }
  }
}

function paintWallGlass(cv, x, y) {
  const px = x * T;
  const py = y * T;
  rect(cv, px, py, T, T, [86, 96, 108]);
  rect(cv, px + 2, py + 2, T - 4, T - 4, [128, 156, 172]);
  rect(cv, px + 3, py + 3, T - 6, 4, [156, 184, 198]);
  hline(cv, px + 2, px + T - 3, py + T / 2, [96, 108, 120]);
  outline(cv, px + 1, py + 1, T - 2, T - 2, INK);
}

function paintWall(cv, x, y, adj) {
  const px = x * T;
  const py = y * T;
  if (y === 0) {
    rect(cv, px, py, T, T, WALL[1]);
    rect(cv, px, py, T, 2, WALL[3]);
    hline(cv, px, px + T - 1, py + T - 1, WALL[0]);
    return;
  }
  if (y === 1) {
    rect(cv, px, py, T, T, WALL[2]);
    rect(cv, px, py, T, 2, WALL[3]);
    rect(cv, px, py + T - 3, T, 3, WALL[1]);
    hline(cv, px, px + T - 1, py + T - 4, WALL[1]);
    return;
  }
  const [left, right, up, down] = adj;
  rect(cv, px, py, T, T, WALL[2]);
  if (down) {
    rect(cv, px, py, T, 4, WALL[3]);
    rect(cv, px, py + T - 3, T, 3, WALL[1]);
    hline(cv, px, px + T - 1, py + 4, WALL[1]);
  } else if (up) {
    rect(cv, px, py + T - 3, T, 3, WALL[3]);
    rect(cv, px, py, T, 3, WALL[1]);
    hline(cv, px, px + T - 1, py + T - 4, WALL[1]);
  } else if (right) {
    rect(cv, px, py, 4, T, WALL[3]);
    rect(cv, px + T - 3, py, 3, T, WALL[1]);
    vline(cv, px + 4, py, py + T - 1, WALL[1]);
  } else if (left) {
    rect(cv, px + T - 3, py, 3, T, WALL[3]);
    rect(cv, px, py, 3, T, WALL[1]);
    vline(cv, px + T - 4, py, py + T - 1, WALL[1]);
  } else {
    rect(cv, px, py, T, 4, WALL[3]);
    rect(cv, px, py + T - 3, T, 3, WALL[1]);
  }
}

function paintWindow(cv, x, y) {
  const px = x * T;
  const py = y * T;
  const H2 = y === 0 ? T * 2 : T;
  rect(cv, px, py, T, H2, WALL[1]);
  rect(cv, px + 2, py + 3, T - 4, H2 - 6, [110, 158, 180]);
  rect(cv, px + 2, py + 3, T - 4, 6, [170, 210, 226]);
  rect(cv, px + 3, py + 4, 3, 4, [216, 238, 246]);
  if (H2 > T) hline(cv, px + 2, px + T - 3, py + T, WALL[1]);
  vline(cv, px + 8, py + 3, py + H2 - 4, WALL[1]);
  outline(cv, px + 1, py + 2, T - 2, H2 - 4, INK);
}

function paintDoor(cv, x, y) {
  const px = x * T;
  const py = y * T;
  rect(cv, px, py, T, T, FLOOR[0]);
  rect(cv, px + 1, py + 1, T - 2, T - 2, WOOD[2]);
  rect(cv, px + 2, py + 2, T - 4, 5, WOOD[3]);
  hline(cv, px + 2, px + T - 3, py + 9, WOOD[0]);
  rect(cv, px + 11, py + 7, 2, 2, CREAM);
  outline(cv, px + 1, py + 1, T - 2, T - 2, INK);
}

function paintRailing(cv, x, y) {
  const px = x * T;
  const py = y * T;
  rect(cv, px, py, T, T, [74, 92, 82]);
  rect(cv, px, py, T, 5, [92, 112, 98]);
  rect(cv, px, py + 2, T, 2, WOOD[2]);
  rect(cv, px, py + 12, T, 2, WOOD[1]);
  for (let i = 0; i < T; i += 5) rect(cv, px + i + 1, py + 4, 2, 8, WOOD[1]);
  hline(cv, px, px + T - 1, py + 2, WOOD[3]);
}

/** 只画 spec.furnitureDefs 中的自定义家具（透明底），用于黄金图对比。 */
export function paintFurnitureDefs(spec) {
  const W = spec.grid.w;
  const H = spec.grid.h;
  const cv = createCanvas(W * T, H * T, [0, 0, 0, 0]);
  const defs = spec.furnitureDefs || {};
  for (const p of spec.props || []) {
    const def = defs[p.id];
    if (!def || validateFurnitureDef(def) !== null) continue;
    drawFurnitureDef(cv, def, p.x * T, p.y * T);
  }
  return cv;
}

export function paintTerrain(spec) {
  const W = spec.grid.w;
  const H = spec.grid.h;
  const cv = createCanvas(W * T, H * T, [0, 0, 0, 255]);

  const roomOf = Array.from({ length: H }, () => Array(W).fill(null));
  for (const r of spec.rooms) {
    const [x, y, w, h] = r.rect;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) roomOf[yy][xx] = r.id;
  }
  const doors = new Set(spec.doors.map((d) => `${d.x},${d.y}`));
  const windows = new Set(spec.windows.map((w) => `${w.x},${w.y}`));

  for (const r of spec.rooms) paintFloor(cv, r.rect[0], r.rect[1], r.rect[2], r.rect[3], r.floor);
  for (const z of spec.zones || []) paintFloor(cv, z.rect[0], z.rect[1], z.rect[2], z.rect[3], z.floor);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (roomOf[y][x] || doors.has(`${x},${y}`)) continue;
      const adj = [
        x > 0 ? roomOf[y][x - 1] !== null : false,
        x < W - 1 ? roomOf[y][x + 1] !== null : false,
        y > 0 ? roomOf[y - 1][x] !== null : false,
        y < H - 1 ? roomOf[y + 1][x] !== null : false,
      ];
      if (y === H - 1 && y > 0 && roomOf[y - 1][x] === "balcony") {
        paintRailing(cv, x, y);
        continue;
      }
      const interior =
        (x > 0 && x < W - 1 && roomOf[y][x - 1] && roomOf[y][x + 1]) ||
        (y > 0 && y < H - 1 && roomOf[y - 1][x] && roomOf[y + 1][x]);
      if (spec.wallStyle === "glass" && interior) {
        paintWallGlass(cv, x, y);
        continue;
      }
      if (y <= 1 && y + 2 < H && roomOf[y + 2][x] === "balcony") {
        paintRailing(cv, x, y);
        continue;
      }
      if (windows.has(`${x},${y - 1}`)) continue;
      paintWall(cv, x, y, adj);
      if (windows.has(`${x},${y}`)) paintWindow(cv, x, y);
    }
  }

  // 墙脚投影
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (roomOf[y][x] || doors.has(`${x},${y}`)) continue;
      for (const [dx, dy] of [
        [0, 1],
        [0, -1],
        [1, 0],
        [-1, 0],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || !roomOf[ny][nx]) continue;
        const px = nx * T;
        const py = ny * T;
        if (dy === 1) rect(cv, px, py, T, 2, [40, 28, 30, 95]);
        else if (dy === -1) rect(cv, px, py + T - 2, T, 2, [40, 28, 30, 70]);
        else if (dx === 1) rect(cv, px, py, 2, T, [40, 28, 30, 95]);
        else rect(cv, px + T - 2, py, 2, T, [40, 28, 30, 70]);
      }
    }
  }

  for (const d of spec.doors) paintDoor(cv, d.x, d.y);

  // 静态色调：暗角 + 暖偏移
  const cw = W * T;
  const ch = H * T;
  for (let y = 0; y < ch; y++) {
    const ny = (y - ch / 2) / (ch / 2);
    for (let x = 0; x < cw; x++) {
      const nx = (x - cw / 2) / (cw / 2);
      const vig = 1 - 0.15 * Math.min(1, nx * nx + ny * ny);
      const i = (y * cw + x) * 4;
      cv.data[i] = Math.min(255, Math.floor(cv.data[i] * vig * 1.02));
      cv.data[i + 1] = Math.min(255, Math.floor(cv.data[i + 1] * vig));
      cv.data[i + 2] = Math.min(255, Math.floor(cv.data[i + 2] * vig * 0.97));
    }
  }

  return cv;
}
