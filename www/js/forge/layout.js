// 场景骨架生成（W16/W31 部分）：pick_layout.py 的 JS 版。
// 只定封闭房间、开间、门、分区；不含家具与像素绘制。
// 约束与 Python 版一致：封闭 1–2 间落对角、四周留 1 格墙、开放面积 ≥50%、分区 ≥2。

import { fnv1a, mulberry32 } from "./grammar.js";

const FLOORS_OPEN = ["wood", "tile", "carpet", "stone"];
const DIAGONALS = [
  ["NW", "SE"],
  ["NE", "SW"],
];

const randint = (rnd, a, b) => a + Math.floor(rnd() * (b - a + 1));
const choice = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
function sample(rnd, arr, k) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

export function closedRect(corner, w, h, cw, ch) {
  if (corner === "NW") return [1, 1, cw, ch];
  if (corner === "NE") return [w - 1 - cw, 1, cw, ch];
  if (corner === "SW") return [1, h - 1 - ch, cw, ch];
  return [w - 1 - cw, h - 1 - ch, cw, ch];
}

const key = (x, y) => `${x},${y}`;

export function decompose(cells, w, h) {
  const set = new Set(cells);
  const rects = [];
  for (let y = 1; y < h - 1; y++) {
    let x = 1;
    while (x < w - 1) {
      if (!set.has(key(x, y))) {
        x += 1;
        continue;
      }
      let x2 = x;
      while (set.has(key(x2 + 1, y))) x2 += 1;
      let y2 = y;
      while (y2 + 1 < h - 1) {
        let all = true;
        for (let xx = x; xx <= x2; xx++) {
          if (!set.has(key(xx, y2 + 1))) {
            all = false;
            break;
          }
        }
        if (!all) break;
        y2 += 1;
      }
      rects.push([x, y, x2 - x + 1, y2 - y + 1]);
      for (let yy = y; yy <= y2; yy++) for (let xx = x; xx <= x2; xx++) set.delete(key(xx, yy));
      x = x2 + 1;
    }
  }
  return rects;
}

export function buildLayout(w, h, seed = "layout") {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 12 || h < 10) {
    throw new Error("布局网格至少 12×10");
  }
  const rnd = mulberry32(typeof seed === "number" ? seed : fnv1a(String(seed)));
  const n = choice(rnd, [1, 1, 2]);
  const [a, b] = choice(rnd, DIAGONALS);
  const corners = n === 1 ? [a] : [a, b];

  const closed = corners.map((corner) => {
    const cw = randint(rnd, 4, Math.min(6, Math.floor(w / 4)));
    const ch = randint(rnd, 4, Math.min(6, Math.floor(h / 3)));
    return [corner, closedRect(corner, w, h, cw, ch)];
  });

  const blocked = new Set();
  for (const [, [x, y, cw, ch]] of closed) {
    for (let xx = x - 1; xx <= x + cw; xx++) {
      for (let yy = y - 1; yy <= y + ch; yy++) {
        if (xx >= 1 && xx <= w - 2 && yy >= 1 && yy <= h - 2) blocked.add(key(xx, yy));
      }
    }
  }
  const interior = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) if (!blocked.has(key(x, y))) interior.push(key(x, y));

  const openRects = decompose(interior, w, h);
  if (!openRects.length) throw new Error("没有可用的开放面积");

  const floors = sample(rnd, FLOORS_OPEN, FLOORS_OPEN.length);
  const rooms = closed.map(([corner, rect], i) => ({
    id: `room${i + 1}`,
    name: `封闭房间${i + 1}`,
    corner,
    rect,
    floor: choice(rnd, ["wood", "tile", "stone"]),
    unlock: { type: "start" },
    story: "",
  }));
  const openRooms = openRects.map((rect, i) => ({
    id: `open${i + 1}`,
    name: `开间${i + 1}`,
    rect,
    floor: floors[i % floors.length],
    unlock: { type: "start" },
    story: "",
  }));

  const closedArea = rooms.reduce((s, r) => s + r.rect[2] * r.rect[3], 0);
  const openArea = openRooms.reduce((s, r) => s + r.rect[2] * r.rect[3], 0);
  const share = openArea / Math.max(1, closedArea + openArea);
  if (share < 0.5) throw new Error(`开放面积只有 ${(share * 100).toFixed(0)}%`);

  const openCells = new Map();
  for (const r of openRooms) {
    const [x, y, ww, hh] = r.rect;
    for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) openCells.set(key(xx, yy), r.id);
  }

  const doors = [];
  for (const r of rooms) {
    const [x, y, cw, ch] = r.rect;
    const ring = [
      ...Array.from({ length: ch }, (_, i) => [x - 1, y + i]),
      ...Array.from({ length: ch }, (_, i) => [x + cw, y + i]),
      ...Array.from({ length: cw }, (_, i) => [x + i, y - 1]),
      ...Array.from({ length: cw }, (_, i) => [x + i, y + ch]),
    ];
    const cand = [];
    for (const [cx, cy] of ring) {
      if (cx < 1 || cx > w - 2 || cy < 1 || cy > h - 2) continue;
      const near = [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ];
      const target = near.map(([nx, ny]) => openCells.get(key(nx, ny))).find(Boolean);
      const touchesRoom = near.some(([nx, ny]) => nx >= x && nx < x + cw && ny >= y && ny < y + ch);
      if (target && touchesRoom) cand.push([cx, cy, target]);
    }
    if (!cand.length) throw new Error(`封闭房间 ${r.id} 找不到可开门的墙格`);
    const [dx, dy, target] = choice(rnd, cand);
    doors.push({ id: `${r.id}_door`, x: dx, y: dy, to: target });
  }

  const noBuild = new Set();
  for (const d of doors) {
    for (const [nx, ny] of [
      [d.x + 1, d.y],
      [d.x - 1, d.y],
      [d.x, d.y + 1],
      [d.x, d.y - 1],
    ]) {
      for (let yy = ny - 1; yy <= ny + 1; yy++) for (let xx = nx - 1; xx <= nx + 1; xx++) noBuild.add(key(xx, yy));
    }
  }

  const biggest = [...openRooms].sort((p, q) => q.rect[2] * q.rect[3] - p.rect[2] * p.rect[3]).slice(0, 2);
  const zones = [];
  for (let i = 0; i < biggest.length; i++) {
    const r = biggest[i];
    const [x, y, ww, hh] = r.rect;
    const zw = Math.min(ww - 1, randint(rnd, 3, 4));
    const zh = Math.min(hh - 1, randint(rnd, 2, 3));
    let zx = null;
    let zy = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const tx = x + randint(rnd, 1, Math.max(1, ww - zw - 1));
      const ty = y + randint(rnd, 1, Math.max(1, hh - zh - 1));
      let blockedCell = false;
      for (let dy = 0; dy < zh && !blockedCell; dy++) {
        for (let dx = 0; dx < zw; dx++) {
          if (noBuild.has(key(tx + dx, ty + dy))) {
            blockedCell = true;
            break;
          }
        }
      }
      if (!blockedCell) {
        zx = tx;
        zy = ty;
        break;
      }
    }
    if (zx === null) continue;
    const alt = FLOORS_OPEN.filter((f) => f !== r.floor);
    zones.push({ name: `区域-${i + 1}`, rect: [zx, zy, zw, zh], floor: choice(rnd, alt) });
  }

  return {
    w,
    h,
    seed,
    openShare: Math.round(share * 100) / 100,
    rooms: [...rooms, ...openRooms],
    zones,
    doors,
    closedRooms: rooms.map((r) => r.id),
  };
}
