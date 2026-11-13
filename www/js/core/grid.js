// 网格与寻路：intGrid 是唯一碰撞真相（MAP-SCENE-DESIGN §2.2 / M6-T8）。
// 纯函数，主线程与 Worker 共用，Node 可直接 import 测试。

export const TILE = Object.freeze({ WALK: 0, BLOCK: 1, DOOR: 2, WINDOW: 3 });

/** 道具 → 交互动作。热点由道具相邻可走格推导，不是道具本身。 */
export const PROP_ACT = Object.freeze({
  bed: "sleep",
  nightstand: "rest",
  wardrobe: "dress",
  dresser: "dress",
  stool: "sit",
  chair: "sit",
  table: "eat",
  coffee_table: "rest",
  lamp: "light",
  counter: "cook",
  stove: "cook",
  fridge: "cook",
  sofa: "rest",
  armchair: "rest",
  tv: "watch",
  bookshelf: "read",
  desk: "write",
  cat_tree: "play",
  bathtub: "bath",
  sink: "wash",
  toilet: "toilet",
  washer: "laundry",
  plant: "water",
  plant_big: "water",
});

/**
 * 解析 home.built.json 的 intGrid（字符串行数组）为 Uint8Array。
 * 行宽不一致或出现非数字字符直接抛错——资源包坏了要在启动时就知道。
 */
export function parseIntGrid(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("intGrid 为空");
  const h = rows.length;
  const w = rows[0].length;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    if (typeof row !== "string" || row.length !== w) {
      throw new Error(`intGrid 第 ${y} 行宽度 ${row?.length} ≠ ${w}`);
    }
    for (let x = 0; x < w; x++) {
      const c = row.charCodeAt(x) - 48;
      if (c < 0 || c > 9) throw new Error(`intGrid (${x},${y}) 非法字符 ${row[x]}`);
      data[y * w + x] = c;
    }
  }
  return { w, h, data };
}

export function tileAt(grid, x, y) {
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return TILE.BLOCK;
  return grid.data[y * grid.w + x];
}

export function isWalkable(grid, x, y) {
  const t = tileAt(grid, x, y);
  return t === TILE.WALK || t === TILE.DOOR;
}

const DIRS = [
  [0, 1],
  [-1, 0],
  [1, 0],
  [0, -1],
];

/** 4 邻域 BFS。返回不含起点的格子序列；不可达返回 null。 */
export function bfsPath(grid, sx, sy, tx, ty) {
  if (!isWalkable(grid, sx, sy) || !isWalkable(grid, tx, ty)) return null;
  if (sx === tx && sy === ty) return [];
  const w = grid.w;
  const seen = new Uint8Array(w * grid.h);
  const prev = new Int32Array(w * grid.h).fill(-1);
  const queue = new Int32Array(w * grid.h);
  let head = 0;
  let tail = 0;
  const start = sy * w + sx;
  const goal = ty * w + tx;
  seen[start] = 1;
  queue[tail++] = start;
  while (head < tail) {
    const cur = queue[head++];
    if (cur === goal) {
      const path = [];
      let node = cur;
      while (node !== start) {
        path.push([node % w, (node / w) | 0]);
        node = prev[node];
      }
      return path.reverse();
    }
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(grid, nx, ny)) continue;
      const nk = ny * w + nx;
      if (seen[nk]) continue;
      seen[nk] = 1;
      prev[nk] = cur;
      queue[tail++] = nk;
    }
  }
  return null;
}

/** 最近的可行走格（含自身），最多搜 maxR 圈。 */
export function nearestWalkable(grid, x, y, maxR = 6) {
  if (isWalkable(grid, x, y)) return [x, y];
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (isWalkable(grid, x + dx, y + dy)) return [x + dx, y + dy];
      }
    }
  }
  return null;
}

/** 道具矩形四邻的可走格，按「下方 → 左 → 右 → 上」优先，保证确定性。 */
function adjacentCells(grid, prop) {
  const w = prop.w || 1;
  const h = prop.h || 1;
  const out = [];
  for (let x = prop.x; x < prop.x + w; x++) out.push([x, prop.y + h]);
  for (let y = prop.y; y < prop.y + h; y++) out.push([prop.x - 1, y]);
  for (let y = prop.y; y < prop.y + h; y++) out.push([prop.x + w, y]);
  for (let x = prop.x; x < prop.x + w; x++) out.push([x, prop.y - 1]);
  return out.filter(([x, y]) => isWalkable(grid, x, y));
}

/**
 * 从场景推导热点：可交互道具的相邻可走格。
 * 返回 [{x, y, prop, act, room, face}]，同一格只保留第一个（确定性）。
 */
export function buildHotspots(scene) {
  const grid = scene.grid;
  const seen = new Set();
  const out = [];
  for (const prop of scene.props || []) {
    const act = PROP_ACT[prop.id];
    if (!act) continue;
    const cell = facingCell(grid, prop) || adjacentCells(grid, prop)[0];
    if (!cell) continue;
    const key = cell[1] * grid.w + cell[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: cell[0], y: cell[1], prop: prop.id, act, room: prop.room, face: prop.facing || "S" });
  }
  return out;
}

/** 按 facing 选使用面相邻格；不可走时回退任意相邻格。 */
function facingCell(grid, prop) {
  const w = prop.w || 1;
  const h = prop.h || 1;
  const fx = prop.x + Math.floor(w / 2);
  const fy = prop.y + Math.floor(h / 2);
  const cand = {
    N: [fx, prop.y - 1],
    S: [fx, prop.y + h],
    W: [prop.x - 1, fy],
    E: [prop.x + w, fy],
  }[prop.facing];
  if (!cand) return null;
  const [x, y] = cand;
  if (x < 0 || y < 0 || x >= grid.w || y >= grid.h) return null;
  return isWalkable(grid, x, y) ? cand : null;
}

/** 出生点：场景 start 房间内、离房间中心最近的可行走格。 */
export function spawnPoint(scene) {
  const room = (scene.rooms || []).find((r) => r.id === scene.start) || (scene.rooms || [])[0];
  if (!room) return [1, 1];
  const [rx, ry, rw, rh] = room.rect;
  const cx = rx + (rw >> 1);
  const cy = ry + (rh >> 1);
  return nearestWalkable(scene.grid, cx, cy, 8) || [1, 1];
}
