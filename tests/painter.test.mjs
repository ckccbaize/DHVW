import test from "node:test";
import assert from "node:assert/strict";

import { paintTerrain, T } from "../www/js/forge/painter.js";

const spec = {
  grid: { w: 12, h: 10, cell: 16 },
  rooms: [
    { id: "living", rect: [1, 1, 5, 5], floor: "wood" },
    { id: "bath", rect: [7, 1, 4, 3], floor: "tile" },
  ],
  zones: [{ name: "区域-厨房", rect: [2, 7, 4, 2], floor: "stone" }],
  doors: [{ id: "d1", x: 6, y: 2, to: "living" }],
  windows: [{ x: 2, y: 0 }],
};

test("paintTerrain：尺寸与确定性", () => {
  const a = paintTerrain(spec);
  const b = paintTerrain(spec);
  assert.equal(a.w, 12 * T);
  assert.equal(a.h, 10 * T);
  assert.deepEqual(a.data, b.data);
});

test("paintTerrain：地板类型都能画", () => {
  for (const floor of ["wood", "tile", "stone", "carpet"]) {
    const cv = paintTerrain({ ...spec, rooms: [{ id: "r", rect: [1, 1, 4, 4], floor }], zones: [], doors: [], windows: [] });
    assert.equal(cv.data.length, cv.w * cv.h * 4);
  }
});

test("paintTerrain：门与窗有独立像素", () => {
  const cv = paintTerrain(spec);
  const at = (x, y) => {
    const i = (y * cv.w + x) * 4;
    return [cv.data[i], cv.data[i + 1], cv.data[i + 2], cv.data[i + 3]];
  };
  const door = at(6 * T + 8, 2 * T + 8);
  const window = at(2 * T + 8, 0);
  assert.notDeepEqual(door, [0, 0, 0, 255]);
  assert.notDeepEqual(window, [0, 0, 0, 255]);
});
