import test from "node:test";
import assert from "node:assert/strict";

import { buildSceneFromDsl } from "../www/js/forge/scenekit.js";
import { buildScene } from "../www/js/forge/scene.js";
import { buildScenePackage, saveScenePackage, loadScenePackage, sceneFromPackage } from "../www/js/core/scene-package.js";

function memoryBackend() {
  const kv = new Map();
  const blobs = new Map();
  return {
    async setKV(k, v) { kv.set(k, v); },
    async getKV(k) { return kv.get(k); },
    async putBlob(k, b) { blobs.set(k, b); },
    async getBlob(k) { return blobs.get(k) || null; },
  };
}

const fakePng = async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

test("buildScenePackage：包结构、manifest、intgrid", async () => {
  const r = buildSceneFromDsl("study/l/warm_wood/rain_dusk/old_books+window_seat/desk", "pkg-1");
  assert.equal(r.ok, true, r.reason);
  const baked = buildScene(r.scene.spec);
  const pkg = await buildScenePackage(r.scene, baked, { encodePngImpl: fakePng });
  assert.equal(pkg.ok, true);
  const paths = pkg.files.map((f) => f.path).sort();
  assert.deepEqual(paths, [
    "furniture.png", "image.png", "interactions.json", "intgrid.bin", "light.png",
    "manifest.json", "scene.json", "terrain.png",
  ]);
  assert.equal(pkg.sceneJson.intGrid, "intgrid.bin");
  assert.equal(pkg.sceneJson.interactions, "interactions.json");
  assert.equal(pkg.manifest.files.length, 7);
  assert.ok(pkg.manifest.files.every((f) => f.sha256.length === 64));
});

test("save/loadScenePackage：包可回读并还原 grid", async () => {
  const r = buildSceneFromDsl("bedroom/m/cool_plaster/night//bed", "pkg-2");
  const baked = buildScene(r.scene.spec);
  const pkg = await buildScenePackage(r.scene, baked, { encodePngImpl: fakePng });
  const backend = memoryBackend();
  await saveScenePackage(backend, pkg);
  const loaded = await loadScenePackage(backend, pkg.id);
  assert.ok(loaded);
  assert.equal(loaded.intGrid.length, r.scene.w * r.scene.h);
  const scene = sceneFromPackage(loaded);
  assert.equal(scene.grid.data.length, r.scene.w * r.scene.h);
  assert.ok(loaded.interactions.acts.sleep);
});
