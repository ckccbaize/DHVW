import test from "node:test";
import assert from "node:assert/strict";

import { parseDsl } from "../www/js/forge/dsl.js";
import { buildSceneFromDsl, produceScene } from "../www/js/forge/scenekit.js";
import { generateMap } from "../www/js/core/agent/subs/map.js";

test("parseDsl：合法 DSL 与枚举校验", () => {
  const ok = parseDsl("study/l/warm_wood/rain_dusk/old_books+window_seat/desk");
  assert.equal(ok.ok, true);
  assert.equal(ok.arch, "study");
  assert.deepEqual(ok.features, ["old_books", "window_seat"]);
  assert.equal(parseDsl("study/l/warm_wood/day/a+b+c+d/desk").ok, false);
  assert.equal(parseDsl("study/x/warm_wood/day//desk").ok, false);
  assert.equal(parseDsl("study/l/warm_wood/day//piano").ok, false);
});

test("buildSceneFromDsl：32×24、家具、交互、热点可达", () => {
  const r = buildSceneFromDsl("study/l/warm_wood/rain_dusk/old_books+window_seat/desk", "seed-1");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.scene.w, 32);
  assert.equal(r.scene.h, 24);
  assert.ok(r.scene.props.some((p) => p.id === "desk"));
  assert.ok(r.scene.interactions.acts.work);
  assert.ok(r.scene.interactions.acts.read);
  assert.ok(r.report.reachableHotspots >= r.report.minHot);
  for (const hot of r.scene.entities.filter((e) => e.type === "hotspot")) {
    assert.equal(r.scene.intGrid[hot.y * r.scene.w + hot.x], 0);
    assert.ok(r.scene.interactions.acts[hot.act]);
  }
});

test("buildSceneFromDsl：同 DSL/seed 确定性", () => {
  const a = buildSceneFromDsl("bedroom/m/cool_plaster/night//bed", "same");
  const b = buildSceneFromDsl("bedroom/m/cool_plaster/night//bed", "same");
  assert.deepEqual(a.scene.intGrid, b.scene.intGrid);
  assert.deepEqual(a.scene.props, b.scene.props);
});

test("produceScene：intent 不存在时拒绝", () => {
  const r = produceScene({ seed: "x", dsl: "study/l/warm_wood/day//desk", intent: "piano" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /intent_missing/);
});

test("generateMap：mapSpec.dsl 走 DSL 生成器", () => {
  const r = generateMap({ mapSpec: { dsl: "shop/s/warm_wood/day//counter" }, seed: "shop-1" });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.scene.kind, "shop");
  assert.ok(r.scene.interactions.acts.cook);
  assert.equal(r.scene.intGrid.length, r.scene.w * r.scene.h);
});
