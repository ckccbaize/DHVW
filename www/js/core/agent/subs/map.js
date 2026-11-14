// 地图子 Agent（W16）：把出门/剧情给的 mapSpec 变成可渲染的场景骨架。
// 输出 rooms/zones/doors/windows + intGrid（0 走 1 墙 2 门 3 窗）；像素绘制留给 W31。

import { buildLayout } from "../../../forge/layout.js";
import { buildSceneSpec } from "../../../forge/scene-spec.js";
import { buildFloorplan } from "../../../forge/floorplan.js";
import { buildIntGrid } from "../../../forge/scene.js";

export const TILE = Object.freeze({ WALK: 0, BLOCK: 1, DOOR: 2, WINDOW: 3 });

export function buildGrid(layout) {
  const { w, h, rooms, doors } = layout;
  const grid = new Uint8Array(w * h).fill(TILE.BLOCK);
  const at = (x, y) => y * w + x;

  for (const r of rooms) {
    const [x, y, rw, rh] = r.rect;
    for (let yy = y; yy < y + rh; yy++) {
      for (let xx = x; xx < x + rw; xx++) {
        if (xx > 0 && xx < w - 1 && yy > 0 && yy < h - 1) grid[at(xx, yy)] = TILE.WALK;
      }
    }
  }
  for (const d of doors) grid[at(d.x, d.y)] = TILE.DOOR;

  const windows = [];
  for (let x = 1; x < w - 1; x++) {
    if (grid[at(x, 1)] === TILE.WALK && grid[at(x, 0)] === TILE.BLOCK) {
      grid[at(x, 0)] = TILE.WINDOW;
      windows.push({ x, y: 0 });
      if (windows.length >= 3) break;
    }
  }
  return { grid, windows };
}

export function reachable(grid, w, h, start) {
  const seen = new Uint8Array(w * h);
  const q = [start];
  seen[start] = 1;
  const walkable = (i) => grid[i] === TILE.WALK || grid[i] === TILE.DOOR;
  while (q.length) {
    const i = q.pop();
    const x = i % w;
    const y = (i - x) / w;
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!seen[j] && walkable(j)) {
        seen[j] = 1;
        q.push(j);
      }
    }
  }
  return seen;
}

export function validateMap(scene) {
  const errors = [];
  const { w, h, rooms, doors } = scene;
  const grid = scene.intGrid || scene.grid;
  if (!w || !h || !grid || grid.length !== w * h) errors.push("grid 尺寸不符");
  if (!rooms?.length) errors.push("没有房间");
  if (!scene.semantic) {
    const closed = rooms.filter((r) => r.corner);
    if (closed.length < 1 || closed.length > 2) errors.push("封闭房间必须 1–2 间");
    if (new Set(closed.map((r) => r.corner)).size !== closed.length) errors.push("封闭房间不能同角");
    if (doors.length !== closed.length) errors.push("门数量应等于封闭房间数");

    const area = (r) => r.rect[2] * r.rect[3];
    const closedArea = closed.reduce((s, r) => s + area(r), 0);
    const openArea = rooms.filter((r) => !r.corner).reduce((s, r) => s + area(r), 0);
    if (openArea / Math.max(1, closedArea + openArea) < 0.5) errors.push("开放面积不足 50%");
    if (!scene.zones?.length) errors.push("没有分区");
  }

  for (const d of doors) {
    if (grid[d.y * w + d.x] !== TILE.DOOR) errors.push(`门 ${d.id} 不在门格上`);
    if (!rooms.some((r) => r.id === d.to)) errors.push(`门 ${d.id} 指向未知房间`);
  }

  const startRoom = rooms.find((r) => !r.corner) || rooms[0];
  const [sx, sy, sw, sh] = startRoom.rect;
  const start = (sy + Math.floor(sh / 2)) * w + sx + Math.floor(sw / 2);
  const seen = reachable(grid, w, h, start);
  for (const r of rooms) {
    const [x, y, rw, rh] = r.rect;
    const cx = x + Math.floor(rw / 2);
    const cy = y + Math.floor(rh / 2);
    if (!seen[cy * w + cx]) errors.push(`房间 ${r.id} 不可达`);
  }
  return errors;
}

export function generateMap({ mapSpec = {}, seed, w = 24, h = 16 } = {}) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 12 || h < 10) {
    return { ok: false, reason: "布局网格至少 12×10" };
  }
  const baseSeed = seed ?? mapSpec.seed ?? "map";
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const s = attempt === 0 ? baseSeed : `${baseSeed}-${attempt}`;
    try {
      const kind = mapSpec.kind || "home";
      const name = mapSpec.name || (kind === "home" ? "家" : "未命名场景");
      const layout = buildFloorplan(kind, w, h, s, mapSpec);
      const { windows } = layout.windows ? { windows: layout.windows } : buildGrid(layout);
      const spec = buildSceneSpec(layout, { kind, name, seed: s });
      spec.windows = windows;
      const makeScene = () => {
        const rows = buildIntGrid(spec);
        return {
          name,
          title: name,
          kind,
          seed: s,
          w,
          h,
          rooms: spec.rooms,
          zones: spec.zones,
          doors: spec.doors,
          windows: spec.windows,
          props: spec.props,
          wallProps: spec.wallProps,
          decor: spec.decor,
          spec,
          semantic: !!layout.semantic,
          intGrid: rows.join("").split("").map(Number),
          openShare: layout.openShare,
        };
      };
      let scene = makeScene();
      let errors = validateMap(scene);
      // 家具可能堵住房间中心：从后往前撤掉家具，直到全房间可达
      while (errors.length && spec.props.length) {
        const bad = errors.map((e) => /房间 (\S+) 不可达/.exec(e)?.[1]).find(Boolean);
        const idx = bad ? spec.props.map((p) => p.room).lastIndexOf(bad) : -1;
        if (idx >= 0) spec.props.splice(idx, 1);
        else spec.props.pop();
        scene = makeScene();
        errors = validateMap(scene);
      }
      if (errors.length) {
        lastErr = new Error(errors.join("; "));
        continue;
      }
      return { ok: true, scene, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
    }
  }
  return { ok: false, reason: lastErr ? lastErr.message : "generate_failed" };
}
