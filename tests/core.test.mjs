import test from "node:test";
import assert from "node:assert/strict";

import {
  parseIntGrid,
  tileAt,
  isWalkable,
  bfsPath,
  nearestWalkable,
  buildHotspots,
  spawnPoint,
  TILE,
} from "../www/js/core/grid.js";
import { createAgent, moveTo, step, applyChecksum, placeAt, walkFrame, DEFAULT_SPEED } from "../www/js/core/pathagent.js";
import { createClock, phaseOf, MINUTES_PER_DAY } from "../www/js/core/clock.js";
import { createRingBuffer } from "../www/js/core/ringbuffer.js";
import { pickAsset, selectEvictions, totalSize } from "../www/js/core/assetstore.js";
import { createStore } from "../www/js/core/lifestore.js";
import { lightFor } from "../www/js/core/light.js";

const GRID = parseIntGrid([
  "11111",
  "10001",
  "10201",
  "10001",
  "11111",
]);

test("parseIntGrid：尺寸/取值/非法输入", () => {
  assert.equal(GRID.w, 5);
  assert.equal(GRID.h, 5);
  assert.equal(tileAt(GRID, 0, 0), TILE.BLOCK);
  assert.equal(tileAt(GRID, 2, 2), TILE.DOOR);
  assert.equal(tileAt(GRID, 2, 0), TILE.BLOCK);
  assert.throws(() => parseIntGrid(["10", "1"]), /宽度/);
  assert.throws(() => parseIntGrid(["1x"]), /非法字符/);
  assert.throws(() => parseIntGrid([]), /为空/);
});

test("isWalkable：门可走、窗与墙不可走、越界不可走", () => {
  assert.equal(isWalkable(GRID, 1, 1), true);
  assert.equal(isWalkable(GRID, 2, 2), true); // 门
  assert.equal(isWalkable(GRID, 0, 2), false); // 墙
  assert.equal(isWalkable(GRID, -1, 1), false);
  assert.equal(isWalkable(GRID, 99, 1), false);
});

test("bfsPath：可达返回不含起点的路径，不可达返回 null", () => {
  const path = bfsPath(GRID, 1, 1, 3, 3);
  assert.ok(path && path.length === 4);
  assert.deepEqual(path[path.length - 1], [3, 3]);
  assert.ok(!path.some(([x, y]) => x === 1 && y === 1));
  // 每一步都相邻
  let prev = [1, 1];
  for (const p of path) {
    assert.equal(Math.abs(p[0] - prev[0]) + Math.abs(p[1] - prev[1]), 1);
    prev = p;
  }
  assert.equal(bfsPath(GRID, 1, 1, 0, 0), null); // 目标是墙
  assert.deepEqual(bfsPath(GRID, 1, 1, 1, 1), []);
});

test("nearestWalkable：自身可走直接返回，否则找最近", () => {
  assert.deepEqual(nearestWalkable(GRID, 1, 1), [1, 1]);
  const near = nearestWalkable(GRID, 0, 0, 3);
  assert.ok(near);
  assert.equal(isWalkable(GRID, near[0], near[1]), true);
});

test("buildHotspots：热点是道具相邻可走格，且带动作", () => {
  const scene = {
    grid: GRID,
    props: [
      { id: "bed", x: 1, y: 1, w: 1, h: 1, room: "r", facing: "S" },
      { id: "rug", x: 3, y: 3, w: 1, h: 1, room: "r" }, // 无交互动作
    ],
  };
  const spots = buildHotspots(scene);
  assert.equal(spots.length, 1);
  assert.equal(spots[0].act, "sleep");
  assert.equal(spots[0].prop, "bed");
  assert.equal(isWalkable(GRID, spots[0].x, spots[0].y), true);
  // 同一格不重复
  const dup = buildHotspots({ grid: GRID, props: [{ id: "bed", x: 1, y: 1, w: 1, h: 1, room: "r" }, { id: "chair", x: 2, y: 1, w: 1, h: 1, room: "r" }] });
  const keys = dup.map((h) => `${h.x},${h.y}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("spawnPoint：落在 start 房间且可走", () => {
  const scene = {
    grid: GRID,
    start: "a",
    rooms: [{ id: "a", rect: [1, 1, 3, 3] }],
  };
  const [x, y] = spawnPoint(scene);
  assert.equal(isWalkable(GRID, x, y), true);
});

test("PathAgent：moveTo + 插值推进 + 到达转 act", () => {
  const agent = createAgent(1, 1);
  assert.equal(agent.state, "idle");
  assert.equal(moveTo(agent, []), false);
  assert.equal(moveTo(agent, [[2, 1], [3, 1]], { act: "read" }), true);
  assert.equal(agent.state, "walk");

  // 0.35s/格：推进 0.35s 应恰好到第一格
  step(agent, 0.35);
  assert.equal(agent.gx, 2);
  assert.equal(agent.gy, 1);
  assert.equal(agent.path.length, 1);

  const arrived = step(agent, 0.35);
  assert.equal(arrived, "arrived");
  assert.equal(agent.gx, 3);
  assert.equal(agent.state, "act");
  assert.equal(agent.act, "read");

  step(agent, 2.1);
  assert.equal(agent.state, "idle");
  assert.equal(agent.act, null);
  assert.equal(DEFAULT_SPEED, 1 / 0.35);
});

test("PathAgent：插值是连续的，不会瞬移", () => {
  const agent = createAgent(1, 1);
  moveTo(agent, [[5, 1]]);
  let last = agent.px;
  for (let i = 0; i < 20; i++) {
    step(agent, 0.05);
    assert.ok(agent.px >= last - 1e-9);
    assert.ok(agent.px - last < 0.2, `单帧位移过大: ${agent.px - last}`);
    last = agent.px;
  }
});

test("applyChecksum：偏差 >1 格才吸附，行走中不吸附", () => {
  const agent = createAgent(2, 2);
  assert.equal(applyChecksum(agent, 3, 2), false); // 1 格内
  assert.equal(applyChecksum(agent, 5, 2), true); // >1 格
  assert.equal(agent.gx, 5);

  moveTo(agent, [[6, 5]]);
  step(agent, 0.05);
  assert.equal(applyChecksum(agent, 1, 1), false);
  assert.equal(agent.state, "walk");
});

test("placeAt：切场景落点与朝向", () => {
  const agent = createAgent(1, 1);
  moveTo(agent, [[3, 1]]);
  placeAt(agent, 7, 4, { x: 0, y: -1 });
  assert.deepEqual([agent.gx, agent.gy], [7, 4]);
  assert.equal(agent.px, 7.5);
  assert.equal(agent.state, "idle");
  assert.deepEqual(agent.dir, { x: 0, y: -1 });
  assert.equal(agent.path.length, 0);
  assert.equal(walkFrame(agent), 0);
});

test("Clock：跨天推进与时段划分", () => {
  const c = createClock({ day: 1, minute: 23 * 60 });
  c.advance(120);
  assert.equal(c.day, 2);
  assert.equal(c.minute, 60);
  c.advance(MINUTES_PER_DAY * 2);
  assert.equal(c.day, 4);
  assert.equal(c.hhmm(), "01:00");

  assert.equal(phaseOf(0), "sleep");
  assert.equal(phaseOf(7 * 60), "wake");
  assert.equal(phaseOf(9 * 60), "morning");
  assert.equal(phaseOf(12 * 60), "noon");
  assert.equal(phaseOf(15 * 60), "afternoon");
  assert.equal(phaseOf(20 * 60), "evening");
  assert.equal(phaseOf(22 * 60 + 30), "night");
});

test("Clock：主机时间校准偏移", () => {
  const c = createClock();
  const deviceNow = 1_000_000;
  c.setOffsetFromServer(deviceNow + 5000, deviceNow);
  assert.equal(c.offsetMs, 5000);
  assert.equal(c.correctedNow(deviceNow), deviceNow + 5000);
});

test("RingBuffer：满则覆盖最旧并计数", () => {
  const rb = createRingBuffer(3);
  rb.push(1);
  rb.push(2);
  rb.push(3);
  assert.equal(rb.dropped, 0);
  rb.push(4);
  assert.deepEqual(rb.toArray(), [2, 3, 4]);
  assert.equal(rb.dropped, 1);
  assert.deepEqual(rb.peek(2), [2, 3]);
  assert.throws(() => createRingBuffer(0));
});

test("AssetStore：tier 优先，其次新旧", () => {
  const assets = [
    { id: "e1", kind: "bg", tier: "edge", created_at: 200 },
    { id: "h1", kind: "bg", tier: "host", created_at: 100 },
    { id: "e2", kind: "bg", tier: "edge", created_at: 300 },
    { id: "p1", kind: "plot", tier: "edge", created_at: 300 },
  ];
  assert.equal(pickAsset(assets, "bg").id, "h1");
  assert.equal(pickAsset(assets, "bg", { hostOnly: true }).id, "h1");
  assert.equal(pickAsset(assets, "plot").id, "p1");
  assert.equal(pickAsset(assets, "scene"), null);
});

test("AssetStore：配额只淘汰 edge，最久未消费优先", () => {
  const assets = [
    { id: "h", kind: "bg", tier: "host", size: 100, created_at: 1 },
    { id: "e1", kind: "bg", tier: "edge", size: 100, created_at: 10, consumed_at: 0 },
    { id: "e2", kind: "plot", tier: "edge", size: 100, created_at: 20, consumed_at: 50 },
  ];
  assert.equal(totalSize(assets), 300);
  assert.deepEqual(selectEvictions(assets, 300), []);
  assert.deepEqual(selectEvictions(assets, 200), ["e1"]);
  assert.deepEqual(selectEvictions(assets, 100), ["e1", "e2"]);
  // host 永不淘汰
  assert.ok(!selectEvictions(assets, 0).includes("h"));
});

test("LifeStore：patch 只通知变更键，emit 走事件总线", () => {
  const store = createStore({ a: 1, b: 2 });
  const seen = [];
  const off = store.subscribe((state, changed) => seen.push(changed));
  store.patch({ a: 1 });
  assert.equal(seen.length, 0);
  store.patch({ a: 3, c: 4 });
  assert.deepEqual(seen[0], ["a", "c"]);
  off();
  store.patch({ a: 9 });
  assert.equal(seen.length, 1);

  let got = null;
  store.on("say", (p) => (got = p));
  store.emit("say", { text: "hi" });
  assert.deepEqual(got, { text: "hi" });
});

test("lightFor：天气优先于时段", () => {
  assert.equal(lightFor("morning", "clear"), "day");
  assert.equal(lightFor("evening", "clear"), "dusk");
  assert.equal(lightFor("sleep", "clear"), "night");
  assert.equal(lightFor("morning", "rain"), "rain");
  assert.equal(lightFor("evening", "snow"), "snow");
});
