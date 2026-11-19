import test from "node:test";
import assert from "node:assert/strict";
import { layoutTour, cameraTarget, CELL_DEFAULT } from "../www/js/core/tourlayout.js";

const scene = (w, h, cell = 16) => ({ grid: { w, h, cell } });

test("街景带内所有场景共用同一像素比例（否则过门时角色缩放跳变）", () => {
  const out = layoutTour([scene(20, 15), scene(28, 19), scene(24, 17)], { w: 1280, h: 720 });
  const ks = out.rooms.map((r) => r.stripK);
  assert.deepEqual(new Set(ks.map((k) => k.toFixed(6))).size, 1);
});

test("比例取 cover：每段都盖满视口（宽高都不小于视口）", () => {
  const scenes = [scene(20, 15), scene(28, 19), scene(24, 17)];
  const view = { w: 1280, h: 720 };
  const out = layoutTour(scenes, view);
  for (const r of out.rooms) {
    assert.ok(r.stripW >= view.w - 1e-9, `stripW ${r.stripW} < ${view.w}`);
    assert.ok(r.stripH >= view.h - 1e-9, `stripH ${r.stripH} < ${view.h}`);
  }
});

test("街景段首尾相接、无缝隙也无重叠", () => {
  const out = layoutTour([scene(20, 15), scene(28, 19), scene(24, 17)], { w: 1280, h: 720 });
  assert.equal(out.rooms[0].x0, 0);
  for (let i = 1; i < out.rooms.length; i += 1) {
    assert.equal(out.rooms[i].x0, out.rooms[i - 1].x0 + out.rooms[i - 1].stripW);
  }
  const last = out.rooms[out.rooms.length - 1];
  assert.equal(out.totalW, last.x0 + last.stripW);
});

test("地面线对齐屏幕底部：stripTop + stripH == 视口高", () => {
  const out = layoutTour([scene(20, 15), scene(28, 19)], { w: 1280, h: 720 });
  for (const r of out.rooms) assert.ok(Math.abs(r.stripTop + r.stripH - 720) < 1e-9);
});

test("室内首段用 contain 整屋居中，比例与街景段不同（这是刻意的）", () => {
  const out = layoutTour([scene(20, 15), scene(28, 19)], { w: 1280, h: 720 });
  const [first, second] = out.rooms;
  assert.equal(first.roomK, Math.min(1280 / 320, 720 / 240));
  assert.ok(first.roomK < first.stripK);
  assert.ok(Math.abs(first.roomW - 320 * first.roomK) < 1e-9);
  assert.ok(second.roomK < second.stripK);
});

test("非 16 单元格按各自 cell 换算", () => {
  const out = layoutTour([scene(10, 10, 32), scene(20, 20, 16)], { w: 640, h: 640 });
  // 两段源尺寸相同（320×320），比例应一致且恰好 2
  assert.equal(out.rooms[0].stripK, 2);
  assert.equal(out.rooms[1].stripK, 2);
});

test("空场景列表不炸，总值退化为 0", () => {
  const out = layoutTour([], { w: 800, h: 600 });
  assert.equal(out.totalW, 0);
  assert.equal(out.rooms.length, 0);
  assert.equal(out.stripK, 1);
});

test("cameraTarget：角色停在 40% 处，两端夹紧", () => {
  assert.equal(cameraTarget(1000, 5000, 1000), 600);
  assert.equal(cameraTarget(100, 5000, 1000), 0);
  assert.equal(cameraTarget(9000, 5000, 1000), 5000);
});

test("默认单元格常量与契约一致（16px）", () => {
  assert.equal(CELL_DEFAULT, 16);
});
