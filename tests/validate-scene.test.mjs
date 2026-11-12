import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { validateScene, readPngSize, parseIntGrid, EFFECT_KINDS, REQUIRE_KINDS } from "../tools/validate-scene.mjs";

const baseScene = () => ({
  id: "test",
  title: "测试场景",
  grid: { w: 5, h: 5, cell: 16 },
  intGrid: ["11111", "10001", "10201", "10001", "11111"],
  layers: { terrain: "terrain.png", furniture: "furniture.png", light: { day: "light_day.png" } },
  entities: [
    { type: "spawn", x: 1, y: 1 },
    { type: "door", x: 2, y: 2, to: "outside", anchor: "south" },
    { type: "hotspot", x: 1, y: 2, prop: "desk", act: "read", face: "S" },
  ],
  props: [{ id: "desk", x: 1, y: 1, w: 1, h: 1 }],
});

const baseInteractions = () => ({
  schema_version: 1,
  acts: {
    read: {
      label: "阅读",
      trigger: { props: ["desk"] },
      perform: { animation: "read", duration_min: 30, interruptible: true },
      effects: [{ kind: "mood", target: "valence", delta: 0.1, apply: "on_complete" }],
    },
  },
});

const baseSheet = () => ({ animations: { read: { fps: 2, frames: { S: [0] } } } });

const pngSizes = () => ({
  "terrain.png": { w: 80, h: 80 },
  "furniture.png": { w: 80, h: 80 },
  "light_day.png": { w: 80, h: 80 },
});

const graph = () => new Map([["outside", new Set(["south"])]]);

function run(overrides = {}) {
  return validateScene({
    scene: baseScene(),
    interactions: baseInteractions(),
    sheet: baseSheet(),
    pngSizes: pngSizes(),
    graph: graph(),
    ...overrides,
  });
}

const codes = (r) => r.errors.map((e) => e.code);

test("合法包通过", () => {
  const r = run();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
  assert.equal(r.stats.acts, 1);
  assert.equal(r.stats.hotspots, 1);
});

test("intGrid 长度/宽度不符 → intgrid", () => {
  const s = baseScene();
  s.intGrid = ["11111", "1001", "10201", "10001", "11111"];
  const r = run({ scene: s });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("intgrid"));
});

test("spawn 落在墙上 → spawn", () => {
  const s = baseScene();
  s.entities[0] = { type: "spawn", x: 0, y: 0 };
  const r = run({ scene: s });
  assert.ok(codes(r).includes("spawn"));
});

test("门格不是 2 → door", () => {
  const s = baseScene();
  s.intGrid = ["11111", "10001", "10001", "10001", "11111"];
  const r = run({ scene: s });
  assert.ok(codes(r).includes("door"));
});

test("门指向不存在的场景 → door", () => {
  const r = run({ graph: new Map() });
  assert.ok(codes(r).includes("door"));
});

test("hotspot 不可走 / act 未定义 → hotspot/act", () => {
  const s = baseScene();
  s.entities[2] = { type: "hotspot", x: 0, y: 0, prop: "desk", act: "nope" };
  const r = run({ scene: s });
  assert.ok(codes(r).includes("hotspot"));
  assert.ok(codes(r).includes("act"));
});

test("动画不在图集 → animation", () => {
  const r = run({ sheet: { animations: {} } });
  assert.ok(codes(r).includes("animation"));
});

test("未知效果 / 条件 → effect/require", () => {
  const i = baseInteractions();
  i.acts.read.effects = [{ kind: "teleport" }];
  i.acts.read.requires = [{ kind: "moon_phase" }];
  const r = run({ interactions: i });
  assert.ok(codes(r).includes("effect"));
  assert.ok(codes(r).includes("require"));
});

test("时长越界 → duration", () => {
  const i = baseInteractions();
  i.acts.read.perform.duration_min = 5000;
  const r = run({ interactions: i });
  assert.ok(codes(r).includes("duration"));
});

test("图层尺寸不符 → layer", () => {
  const p = pngSizes();
  p["terrain.png"] = { w: 64, h: 64 };
  const r = run({ pngSizes: p });
  assert.ok(codes(r).includes("layer"));
});

test("act 的道具不在场景 → coverage 警告（不致命）", () => {
  const i = baseInteractions();
  i.acts.read.trigger.props = ["piano"];
  const r = run({ interactions: i });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === "coverage"));
});

test("缺少 interactions：非 strict 只警告，strict 报错", () => {
  const a = run({ interactions: null });
  assert.equal(a.ok, true);
  assert.ok(a.warnings.some((w) => w.code === "act"));
  const b = run({ interactions: null, strict: true });
  assert.equal(b.ok, false);
  assert.ok(codes(b).includes("act"));
});

test("legacy built.json：字符串行 + doors 可校验", () => {
  const legacyScene = {
    name: "home",
    grid: { w: 5, h: 5, cell: 16 },
    start: "living",
    intGrid: ["11111", "10001", "10001", "10001", "11111"],
    rooms: [{ id: "living", rect: [1, 1, 3, 3] }],
    doors: [{ id: "front", x: 2, y: 2, to: "outside" }],
    props: [],
    image: "home.png",
    image2x: "home@2x.png",
  };
  const r = validateScene({
    scene: legacyScene,
    legacy: true,
    pngSizes: { "home@2x.png": { w: 160, h: 160 } },
  });
  // 门格是 0 不是 2 → 应报错
  assert.ok(r.errors.some((e) => e.code === "door"));
  assert.equal(r.stats.legacy, true);
});

test("legacy 门指向未知房间 → door", () => {
  const legacyScene = {
    name: "home",
    grid: { w: 5, h: 5, cell: 16 },
    start: "living",
    intGrid: ["11111", "10001", "10201", "10001", "11111"],
    rooms: [{ id: "living", rect: [1, 1, 3, 3] }],
    doors: [{ id: "x", x: 2, y: 2, to: "nowhere" }],
    props: [],
    image: "home.png",
    image2x: "home@2x.png",
  };
  const r = validateScene({
    scene: legacyScene,
    legacy: true,
    pngSizes: { "home@2x.png": { w: 160, h: 160 } },
  });
  assert.ok(r.errors.some((e) => e.code === "door" && e.msg.includes("nowhere")));
});

test("readPngSize：真实 PNG 与非法数据", () => {
  const buf = fs.readFileSync(new URL("../www/assets/scenes/home/home.png", import.meta.url));
  const size = readPngSize(buf);
  assert.ok(size && size.w > 0 && size.h > 0);
  assert.equal(readPngSize(Buffer.from("not a png")), null);
});

test("parseIntGrid：越界值不静默", () => {
  assert.throws(() => parseIntGrid(["1x"], 2, 1), /非法字符/);
  const g = parseIntGrid([0, 1, 2, 3], 2, 2);
  assert.deepEqual([...g], [0, 1, 2, 3]);
});

test("枚举集合是封闭的", () => {
  assert.ok(EFFECT_KINDS.has("mood"));
  assert.ok(!EFFECT_KINDS.has("teleport"));
  assert.ok(REQUIRE_KINDS.has("place"));
  assert.ok(!REQUIRE_KINDS.has("moon_phase"));
});
