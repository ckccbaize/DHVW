import test from "node:test";
import assert from "node:assert/strict";
import { LIGHT_PLATES, createLightPlate } from "../www/js/view/lightplate.js";

/** 最小 canvas 替身：只记录调用，按真实 2D 语义区分"主画布"与"离屏层"。 */
function fakeCanvas(w = 100, h = 80) {
  const layer = { width: w, height: h };
  const layerCtx = {
    canvas: layer,
    cleared: 0,
    filled: [],
    clearRect(x, y, cw, ch) {
      this.cleared += 1;
      // 必须整层清，且用自己这一层的尺寸（不是创建时的默认尺寸）。
      assert.deepEqual([x, y, cw, ch], [0, 0, layer.width, layer.height]);
    },
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    set fillStyle(_v) {},
    fillRect(x, y, cw, ch) {
      this.filled.push([x, y, cw, ch]);
    },
  };
  layer.getContext = () => layerCtx;
  return { layer, layerCtx };
}

test("光罩画在离屏层，合成时只 drawImage 到主画布（不得 clearRect 主画布）", () => {
  const canvases = [];
  let pending = null;
  globalThis.document = {
    createElement() {
      pending = fakeCanvas(120, 90);
      canvases.push(pending);
      return pending.layer;
    },
  };
  try {
    const paint = createLightPlate();
    const target = {
      cleared: 0,
      drawn: [],
      clearRect() {
        this.cleared += 1;
      },
      drawImage(img, x, y) {
        this.drawn.push([img, x, y]);
      },
    };
    paint(target, 120, 90, "night");
    assert.equal(target.cleared, 0, "主画布绝不能被 clearRect");
    assert.equal(target.drawn.length, 1);
    assert.equal(target.drawn[0][0], pending.layer);
    // 离屏层确实画过一次渐变 + 暗角
    assert.equal(pending.layerCtx.cleared, 1);
    assert.equal(pending.layerCtx.filled.length, 2);
  } finally {
    delete globalThis.document;
  }
});

test("同尺寸同档位不重建离屏层（逐帧零分配）", () => {
  let created = 0;
  globalThis.document = {
    createElement() {
      created += 1;
      const c = fakeCanvas();
      return c.layer;
    },
  };
  try {
    const paint = createLightPlate();
    const target = { drawImage() {} };
    for (let i = 0; i < 60; i += 1) paint(target, 100, 80, "day");
    assert.equal(created, 1);
  } finally {
    delete globalThis.document;
  }
});

test("换档位只重绘一次，尺寸变化才重建", () => {
  const made = [];
  globalThis.document = {
    createElement() {
      const c = fakeCanvas();
      made.push(c);
      return c.layer;
    },
  };
  try {
    const paint = createLightPlate();
    const target = { drawImage() {} };
    paint(target, 100, 80, "day");
    const first = made[0];
    for (let i = 0; i < 10; i += 1) paint(target, 100, 80, "night");
    assert.equal(made.length, 1, "换档不应重建");
    assert.equal(first.layerCtx.cleared, 2, "初次 + 换档各绘一次");
    paint(target, 200, 160, "night");
    assert.equal(made.length, 2, "尺寸变化必须重建");
  } finally {
    delete globalThis.document;
  }
});

test("未知档位退化为 day，不抛异常", () => {
  let captured = null;
  globalThis.document = {
    createElement() {
      const c = fakeCanvas();
      captured = c;
      return c.layer;
    },
  };
  try {
    const paint = createLightPlate();
    paint({ drawImage() {} }, 100, 80, "volcano");
    assert.ok(captured.layerCtx.cleared >= 1);
  } finally {
    delete globalThis.document;
  }
});

test("色板覆盖光照映射的全部输出档位", async () => {
  const { lightFor } = await import("../www/js/core/light.js");
  for (const phase of ["sleep", "wake", "morning", "noon", "afternoon", "evening", "night"]) {
    assert.ok(lightFor(phase, "clear") in LIGHT_PLATES);
  }
  for (const w of ["rain", "storm", "snow", "fog", "clear"]) {
    assert.ok(lightFor("noon", w) in LIGHT_PLATES, `weather ${w}`);
  }
});
