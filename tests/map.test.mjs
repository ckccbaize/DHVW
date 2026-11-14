import test from "node:test";
import assert from "node:assert/strict";

import { buildLayout } from "../www/js/forge/layout.js";
import { buildGrid, generateMap, reachable, TILE, validateMap } from "../www/js/core/agent/subs/map.js";

test("buildLayout：结构与约束", () => {
  let ok = 0;
  for (let i = 0; i < 20; i++) {
    let layout;
    try {
      layout = buildLayout(24, 16, `s${i}`);
    } catch {
      continue;
    }
    ok += 1;
    const closed = layout.rooms.filter((r) => r.corner);
    assert.ok(closed.length >= 1 && closed.length <= 2, `closed=${closed.length}`);
    assert.equal(new Set(closed.map((r) => r.corner)).size, closed.length);
    assert.ok(layout.openShare >= 0.5, `openShare=${layout.openShare}`);
    assert.ok(layout.zones.length >= 2, `zones=${layout.zones.length}`);
    assert.equal(layout.doors.length, closed.length);
    for (const r of layout.rooms) {
      const [x, y, w, h] = r.rect;
      assert.ok(x >= 1 && y >= 1 && x + w <= 23 && y + h <= 15, `越界 ${r.id}`);
    }
  }
  assert.ok(ok >= 18, `成功 ${ok}/20`);
});

test("buildLayout：同种子确定性", () => {
  const a = buildLayout(24, 16, "seed-7");
  const b = buildLayout(24, 16, "seed-7");
  assert.deepEqual(a, b);
});

test("buildGrid：边界为墙、门格为 DOOR", () => {
  const layout = buildLayout(24, 16, "grid-1");
  const { grid, windows } = buildGrid(layout);
  assert.equal(grid.length, 24 * 16);
  for (let x = 0; x < 24; x++) {
    assert.notEqual(grid[x], TILE.WALK);
    assert.notEqual(grid[(15 * 24) + x], TILE.WALK);
  }
  for (const d of layout.doors) assert.equal(grid[d.y * 24 + d.x], TILE.DOOR);
  assert.ok(windows.length >= 1);
  assert.equal(grid[windows[0].y * 24 + windows[0].x], TILE.WINDOW);
});

test("generateMap：合法、可走通、确定性", () => {
  const spec = { name: "集市", kind: "lively", distance: 7, seed: "11-13-1" };
  const a = generateMap({ mapSpec: spec });
  assert.equal(a.ok, true, a.reason);
  assert.deepEqual(validateMap(a.scene), []);
  assert.equal(a.scene.name, "集市");
  assert.equal(a.scene.kind, "lively");
  assert.equal(a.scene.intGrid.length, 24 * 16);

  const b = generateMap({ mapSpec: spec });
  assert.deepEqual(a.scene.intGrid, b.scene.intGrid);

  const startRoom = a.scene.rooms.find((r) => !r.corner);
  const [x, y, w, h] = startRoom.rect;
  const seen = reachable(a.scene.intGrid, 24, 16, (y + Math.floor(h / 2)) * 24 + x + Math.floor(w / 2));
  const doors = a.scene.doors;
  for (const d of doors) assert.equal(seen[d.y * 24 + d.x], 1, `门 ${d.id} 不可达`);
});

test("generateMap：home/office 生成可识别户型与家具", () => {
  const home = generateMap({ mapSpec: { kind: "home", name: "家" }, seed: "home-1" });
  assert.equal(home.ok, true, home.reason);
  assert.deepEqual(home.scene.rooms.map((r) => r.kind), ["living", "bedroom", "hall", "bath", "balcony"]);
  assert.ok(home.scene.props.length >= 10);
  assert.ok(home.scene.props.some((p) => p.id === "bed"));
  assert.ok(home.scene.props.some((p) => p.id === "counter"));
  assert.deepEqual(validateMap(home.scene), []);

  const office = generateMap({ mapSpec: { kind: "office", name: "办公室" }, seed: "office-1" });
  assert.equal(office.ok, true, office.reason);
  assert.deepEqual(office.scene.rooms.map((r) => r.kind), ["office", "meeting", "lounge"]);
  assert.ok(office.scene.props.filter((p) => p.id === "table").length >= 1);
  assert.ok(office.scene.props.filter((p) => p.id === "chair").length >= 2);
  assert.deepEqual(validateMap(office.scene), []);
});

test("generateMap：任意场景按名称生成对应房间与家具", () => {
  const cafe = generateMap({ mapSpec: { kind: "social", name: "咖啡馆" }, seed: "cafe-1" });
  assert.equal(cafe.ok, true, cafe.reason);
  assert.ok(cafe.scene.rooms.some((r) => r.kind === "cafe"));
  assert.ok(cafe.scene.props.some((p) => p.id === "counter"));
  assert.ok(cafe.scene.props.some((p) => p.id === "table"));

  const books = generateMap({ mapSpec: { kind: "quiet", name: "书店" }, seed: "books-1" });
  assert.equal(books.ok, true, books.reason);
  assert.ok(books.scene.rooms.some((r) => r.kind === "bookstore"));
  assert.ok(books.scene.props.some((p) => p.id === "bookshelf"));

  const custom = generateMap({
    mapSpec: { kind: "custom", name: "花店", program: [{ kind: "shop", name: "花店" }, { kind: "counter", name: "包扎台" }] },
    seed: "flower-1",
  });
  assert.equal(custom.ok, true, custom.reason);
  assert.deepEqual(custom.scene.rooms.map((r) => r.kind), ["shop", "counter"]);
  assert.ok(custom.scene.props.length >= 3);
});

test("generateMap：网格过小直接失败", () => {
  const r = generateMap({ mapSpec: { seed: "x" }, w: 8, h: 6 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /12×10|开放面积|没有可用/);
});
