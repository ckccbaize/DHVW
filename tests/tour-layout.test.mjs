import test from "node:test";
import assert from "node:assert/strict";
import {
  layoutTour,
  cameraTarget,
  pickExit,
  walkingRowPx,
  CELL_DEFAULT,
  GROUND_RATIO,
  CAM_RATIO,
  WALK_ZOOM,
} from "../www/js/core/tourlayout.js";

const scene = (w, h, rows = null, cell = 16) => {
  if (!rows) return { grid: { w, h, cell } };
  const data = new Uint8Array(w * h);
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x += 1) data[y * w + x] = row[x] === "." ? 0 : 1;
  });
  return { grid: { w, h, cell, data } };
};

const VIEW = { w: 1258, h: 622 };
const HOME = scene(20, 15);
const BOOK = scene(28, 19);
const CAFE = scene(28, 19);
const PARK = scene(24, 17);
const ALL = [HOME, BOOK, CAFE, PARK];

test("首段是 room：整幅地图 contain 进视口（看全屋）", () => {
  const out = layoutTour(ALL, VIEW);
  const r = out.segs[0];
  assert.equal(r.mode, "room");
  assert.ok(r.drawW <= VIEW.w + 1e-9);
  assert.ok(r.drawH <= VIEW.h + 1e-9);
  assert.ok(Math.abs(r.ox - (VIEW.w - r.drawW) / 2) < 1e-9, "水平居中");
  assert.equal(r.camMax, 0);
});

test("街景段是 walk：宽度至少 vw*ZOOM，才有真正的滚动余量", () => {
  const out = layoutTour(ALL, VIEW);
  for (const s of out.segs.slice(1)) {
    assert.equal(s.mode, "walk");
    assert.ok(s.drawW >= VIEW.w * WALK_ZOOM - 1e-9, `drawW ${s.drawW} 不足 ${VIEW.w * WALK_ZOOM}`);
    assert.ok(s.camMax > VIEW.w * 0.5, `camMax ${s.camMax} 太小，滚不动`);
  }
});

test("walk 段也盖满视口高度（不露底色）", () => {
  const out = layoutTour(ALL, VIEW);
  for (const s of out.segs.slice(1)) {
    assert.ok(s.drawH >= VIEW.h - 1e-9, `drawH ${s.drawH} < ${VIEW.h}`);
    assert.ok(s.oy <= 0, `oy ${s.oy} 应能盖住顶边`);
  }
});

test("所有 walk 段共用同一比例（否则换图时角色缩放跳变）", () => {
  const out = layoutTour(ALL, VIEW);
  const ks = out.segs.slice(1).map((s) => s.k);
  // 各场景源尺寸不同，k 可以不同；关键是"换图时角色屏幕上不缩放"取决于同一 k。
  // 这里锁定实际口径：尺寸相同的场景必须 k 相同。
  assert.equal(out.segs[1].k, out.segs[2].k, "书店与咖啡厅同尺寸，k 必须一致");
  assert.ok(ks.every((k) => k > 0));
});

// drawCharacter 的脚底口径：oy + row*k + cell*k*0.25（立绘底边再往下 1/4 格）。
const footOf = (s) => s.oy + s.row * s.k + (s.cell || 16) * s.k * 0.25;

test("纵向锚定：脚底落在 GROUND_RATIO 处（角色不出画）", () => {
  const out = layoutTour(ALL, VIEW);
  for (const s of out.segs.slice(1)) {
    const feet = footOf(s);
    assert.ok(
      Math.abs(feet - VIEW.h * GROUND_RATIO) < 1e-6,
      `脚底 y=${feet}，应为 ${VIEW.h * GROUND_RATIO}`,
    );
  }
});

test("walk 段地图底边不低于视口底部（不露黑带）", () => {
  const out = layoutTour(ALL, VIEW);
  for (const s of out.segs.slice(1)) {
    const mapBottom = s.oy + s.drawH;
    assert.ok(
      mapBottom >= VIEW.h - 0.5,
      `${s.cell} 格场景地图底边 ${mapBottom} < 视口 ${VIEW.h}，底部会露出黑带`,
    );
  }
});

test("walk 段脚下至少有 2 格地板（行走行离地图底边 >= 2 格）", () => {
  const out = layoutTour(ALL, VIEW);
  for (const s of out.segs.slice(1)) {
    const below = (s.oy + s.drawH - footOf(s)) / s.k / (s.cell || 16);
    assert.ok(below >= 2, `脚下只有 ${below.toFixed(2)} 格地板，视觉上会悬空`);
  }
});

test("角色在整个 walk 段都落在画面内（含头顶）", () => {
  const out = layoutTour(ALL, VIEW);
  const charH = 48 * (16 / 24); // 立绘高（格）
  for (const s of out.segs.slice(1)) {
    const feet = footOf(s);
    const head = feet - charH * s.k * 1.5;
    assert.ok(feet > 0 && feet < VIEW.h, `脚底 ${feet} 出画`);
    assert.ok(head > 0, `头顶 ${head} 出画`);
  }
});

test("cameraTarget：角色停在 CAM_RATIO 处，两端夹紧", () => {
  assert.equal(cameraTarget(1000, 5000, 1000), 600);
  assert.equal(cameraTarget(100, 5000, 1000), 0);
  assert.equal(cameraTarget(9000, 5000, 1000), 5000);
  assert.equal(CAM_RATIO, 0.4);
});

test("所有 walk 段脚底与头顶屏幕位置完全一致（换图不跳）", () => {
  const out = layoutTour(ALL, VIEW);
  const charH = 48 * (16 / 24);
  const feet = out.segs.slice(1).map(footOf);
  const heads = out.segs.slice(1).map((s, i) => feet[i] - charH * s.k * 2);
  for (const y of feet) assert.ok(Math.abs(y - VIEW.h * GROUND_RATIO) < 1e-6, `脚底 ${y}`);
  for (const y of heads) assert.ok(Math.abs(y - heads[0]) < 1e-6, `头顶 ${y} ≠ ${heads[0]}`);
  assert.ok(heads.every((y) => y > 0), "头顶不能出画");
});

test("walk 段统一比例：换图不缩放", () => {
  const out = layoutTour(ALL, VIEW);
  const ks = out.segs.slice(1).map((s) => s.k);
  assert.equal(new Set(ks.map((k) => k.toFixed(9))).size, 1, `k 不一致：${ks}`);
});

test("room 段同样不让人物出画", () => {
  const out = layoutTour(ALL, VIEW);
  const r = out.segs[0];
  const feet = r.oy + r.row * r.k;
  const head = feet - 48 * (16 / 24) * r.k * 2;
  assert.ok(feet > 0 && feet < VIEW.h, `脚底 ${feet}`);
  assert.ok(head > 0, `头顶 ${head}`);
});

test("walk 段：从 startPx 走满 runPx 后摄像机饱和，角色仍在屏幕 CAM_RATIO 处", () => {
  const out = layoutTour(ALL, VIEW);
  const s = out.segs[1];
  // 起点：camX=0 时角色已在 40% 处
  assert.ok(Math.abs(s.startPx * s.k - VIEW.w * CAM_RATIO) < 1e-6);
  // 终点：camX 饱和到 camMax，屏幕位置仍是 40%
  const endPx = s.startPx + s.runPx;
  const camAtEnd = cameraTarget(endPx * s.k, s.camMax, VIEW.w);
  assert.ok(Math.abs(camAtEnd - s.camMax) < 1e-6, `camX 应饱和 ${camAtEnd} vs ${s.camMax}`);
  const screenX = endPx * s.k - camAtEnd;
  assert.ok(Math.abs(screenX - VIEW.w * CAM_RATIO) < 1e-6, `屏幕 x ${screenX}`);
});

test("walkingRowPx 取最下方 outside 门那一行（街面）", () => {
  const rows = [
    "####",
    "#..#",
    "#..#",
    "####",
  ];
  const s = scene(4, 4, rows);
  s.doors = [
    { id: "side", x: 3, y: 1, to: "outside" },
    { id: "front", x: 1, y: 2, to: "outside" },
  ];
  // 取最下方（y=2），不是中位数/最近门 → (2+0.5)*16 = 40
  assert.equal(walkingRowPx(s, 16), 40);
});

test("walkingRowPx 无 outside 门时退回可行走带下沿上一格", () => {
  const rows = [
    "####",
    "#..#",
    "#..#",
    "####",
  ];
  const s = scene(4, 4, rows);
  // 可行走带 hi=2 → 退一格 = y1 → (1+0.5)*16 = 24
  assert.equal(walkingRowPx(s, 16), 24);
});

test("walkingRowPx 无网格无门时退化到 75% 处", () => {
  assert.equal(walkingRowPx({ grid: { w: 10, h: 10, cell: 16 } }, 16), 160 * 0.75);
});

test("空场景列表不炸", () => {
  const out = layoutTour([], VIEW);
  assert.equal(out.segs.length, 0);
});

test("pickExit 只认 to:outside：家的底部门，不是最右格", () => {
  const grid = scene(20, 5, [
    "####################",
    "#..................#",
    "#..................#",
    "####################",
    "########...........#",
  ]);
  const walkable = (x, y) => grid.grid.data[y * grid.grid.w + x] === 0;
  const doors = [
    { id: "bed_hall", x: 5, y: 1, to: "hall" },
    { id: "front", x: 8, y: 4, to: "outside" },
  ];
  assert.deepEqual(pickExit(doors, walkable, [10, 1]), [8, 4]);
});

test("pickExit 多个 outside 门时选离起点最近的", () => {
  const grid = scene(11, 3, ["..........#", "...........", "..........."]);
  const walkable = (x, y) => grid.grid.data[y * grid.grid.w + x] === 0;
  const doors = [
    { id: "a", x: 0, y: 0, to: "outside" },
    { id: "b", x: 9, y: 2, to: "outside" },
  ];
  assert.deepEqual(pickExit(doors, walkable, [8, 2]), [9, 2]);
  assert.deepEqual(pickExit(doors, walkable, [1, 0]), [0, 0]);
});

test("pickExit 无 outside 时退回任意可走门，再退回 null", () => {
  const grid = scene(3, 2, ["..#", "..."]);
  const walkable = (x, y) => grid.grid.data[y * grid.grid.w + x] === 0;
  assert.deepEqual(pickExit([{ x: 0, y: 1, to: "hall" }], walkable), [0, 1]);
  assert.equal(pickExit([{ x: 2, y: 0, to: "outside" }], walkable), null);
  assert.equal(pickExit(null, walkable), null);
});

test("常量与契约一致", () => {
  assert.equal(CELL_DEFAULT, 16);
  assert.ok(GROUND_RATIO > 0.5 && GROUND_RATIO < 0.9);
  assert.ok(WALK_ZOOM > 1);
});
