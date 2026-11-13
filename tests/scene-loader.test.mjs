import test from "node:test";
import assert from "node:assert/strict";

import { loadScene } from "../www/js/view/scene-loader.js";

const built = {
  name: "demo",
  grid: { w: 5, h: 4, cell: 16 },
  intGrid: ["11111", "10001", "10201", "11111"],
  rooms: [{ id: "a", rect: [1, 1, 3, 2] }],
  props: [{ id: "desk", x: 2, y: 1, w: 1, h: 1 }],
  image: "demo.png",
  image2x: "demo@2x.png",
};

test("loadScene：网格/热点/图片路径", async () => {
  const scene = await loadScene("demo", {
    fetchImpl: async (url) => {
      assert.match(url, /assets\/scenes\/demo\/demo\.built\.json/);
      return { ok: true, json: async () => built };
    },
  });
  assert.equal(scene.grid.w, 5);
  assert.equal(scene.grid.h, 4);
  assert.equal(scene.grid.data.length, 20);
  assert.equal(scene.imageUrl, "assets/scenes/demo/demo.png");
  assert.equal(scene.image2xUrl, "assets/scenes/demo/demo@2x.png");
  assert.ok(Array.isArray(scene.hotspots));
});

test("loadScene：失败抛错", async () => {
  await assert.rejects(
    () => loadScene("nope", { fetchImpl: async () => ({ ok: false, status: 404 }) }),
    /场景加载失败 404/,
  );
});
