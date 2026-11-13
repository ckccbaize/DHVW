import test from "node:test";
import assert from "node:assert/strict";

import { drawFurnitureDef, validateFurnitureDef } from "../www/js/forge/shapes.js";
import { createCanvas } from "../www/js/forge/painter.js";

const good = {
  size: [1, 1],
  shapes: [
    { op: "shadow", x: 1, y: 1, w: 12, h: 12, color: [40, 28, 30, 70] },
    { op: "rect", x: 2, y: 2, w: 12, h: 12, color: [92, 62, 44] },
    { op: "line", x1: 8, y1: 6, x2: 8, y2: 13, color: [46, 34, 36] },
    { op: "outline", x: 2, y: 2, w: 12, h: 12, color: [46, 34, 36] },
    { op: "pixel", x: 9, y: 9, color: [228, 210, 178] },
  ],
};

test("validateFurnitureDef：形状与颜色", () => {
  assert.equal(validateFurnitureDef(good), null);
  assert.equal(validateFurnitureDef({ size: [0, 1], shapes: [] }), "bad_size");
  assert.equal(validateFurnitureDef({ size: [1, 1], shapes: [] }), "bad_shapes");
  assert.equal(validateFurnitureDef({ size: [1, 1], shapes: [{ op: "circle", color: [0, 0, 0] }] }), "bad_op:circle");
  assert.equal(validateFurnitureDef({ size: [1, 1], shapes: [{ op: "rect", x: 0, y: 0, w: 0, h: 1, color: [0, 0, 0] }] }), "bad_rect");
  assert.equal(validateFurnitureDef({ size: [1, 1], shapes: [{ op: "rect", x: 0, y: 0, w: 1, h: 1, color: [0, 0, 999] }] }), "bad_color");
});

test("drawFurnitureDef：确定性与像素写入", () => {
  const a = createCanvas(32, 32, [0, 0, 0, 0]);
  const b = createCanvas(32, 32, [0, 0, 0, 0]);
  drawFurnitureDef(a, good, 0, 0);
  drawFurnitureDef(b, good, 0, 0);
  assert.deepEqual(a.data, b.data);
  const i = (6 * 32 + 6) * 4;
  assert.deepEqual([a.data[i], a.data[i + 1], a.data[i + 2]], [92, 62, 44]);
  const p = (9 * 32 + 9) * 4;
  assert.deepEqual([a.data[p], a.data[p + 1], a.data[p + 2]], [228, 210, 178]);
});
