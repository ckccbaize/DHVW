import test from "node:test";
import assert from "node:assert/strict";

import { tokenize, createBigramIndex } from "../www/js/core/memory/index.js";
import { createLocalMemory, createMemoryDocBackend } from "../www/js/core/memory/local.js";

const DAY = 86400000;

test("tokenize：CJK bigram、ASCII 词、标点丢弃", () => {
  assert.deepEqual(tokenize("京都看枫叶"), ["京都", "都看", "看枫", "枫叶"]);
  assert.deepEqual(tokenize("rain sound"), ["rain", "sound"]);
  assert.deepEqual(tokenize("你好，世界！"), ["你好", "世界"]);
  assert.deepEqual(tokenize("a"), ["a"]);
  assert.deepEqual(tokenize("  ，。 "), []);
  assert.deepEqual(tokenize(null), []);
});

test("索引：字面召回与排序", () => {
  const now = 1000 * DAY;
  const idx = createBigramIndex();
  idx.add({ id: "d1", text: "京都看枫叶，穿了米色风衣", t: now - 7 * DAY });
  idx.add({ id: "d2", text: "米色风衣是去年秋天买的", t: now - 30 * DAY });
  const hits = idx.search("京都枫叶", { now, k: 5 });
  assert.equal(hits[0].id, "d1");
  assert.ok(hits[0].score > 0);
});

test("索引：时间衰减让旧记忆降权", () => {
  const now = 1000 * DAY;
  const idx = createBigramIndex();
  idx.add({ id: "new", text: "米色风衣", t: now - 1 * DAY });
  idx.add({ id: "old", text: "米色风衣", t: now - 60 * DAY });
  const hits = idx.search("米色风衣", { now, k: 5 });
  assert.equal(hits[0].id, "new");
  assert.ok(hits[0].score > hits[1].score);
});

test("索引：同 id 覆盖、删除、清空", () => {
  const idx = createBigramIndex();
  idx.add({ id: "x", text: "苹果", t: 0 });
  idx.add({ id: "x", text: "香蕉", t: 0 });
  assert.equal(idx.size, 1);
  assert.equal(idx.search("苹果", { now: 1 }).length, 0);
  assert.equal(idx.search("香蕉", { now: 1 }).length, 1);
  assert.equal(idx.remove("x"), true);
  assert.equal(idx.remove("x"), false);
  assert.equal(idx.size, 0);
  idx.add({ id: "y", text: "梨", t: 0 });
  idx.clear();
  assert.equal(idx.size, 0);
  assert.equal(idx.terms, 0);
});

test("索引：空查询、k 限制、缺字段", () => {
  const idx = createBigramIndex();
  idx.add({ id: "a", text: "一 二 三", t: 0 });
  idx.add({ id: "b", text: "一 二 三", t: 0 });
  idx.add({ id: "c", text: "一 二 三", t: 0 });
  assert.deepEqual(idx.search("", { now: 1 }), []);
  assert.equal(idx.search("一", { now: 1, k: 2 }).length, 2);
  assert.throws(() => idx.add({ id: "z" }), /id 与 text/);
});

test("本地记忆：写入/检索/持久化重建", async () => {
  const backend = createMemoryDocBackend();
  const now = 1000 * DAY;
  const mem = createLocalMemory({ backend, now: () => now });
  await mem.init();
  await mem.add({ id: "m1", text: "京都看枫叶，穿米色风衣", t: now - 7 * DAY, tier: "L2" });
  await mem.add({ id: "m2", text: "今天下雨", t: now - 1 * DAY });
  assert.equal(mem.count, 2);

  const hits = mem.search("京都枫叶", { k: 3 });
  assert.equal(hits[0].id, "m1");
  assert.equal(hits[0].tier, "L2");

  // 用同一后端重建（模拟重启）
  const mem2 = createLocalMemory({ backend, now: () => now });
  assert.equal(await mem2.init(), 2);
  assert.equal(mem2.search("枫叶", { k: 1 })[0].id, "m1");

  await mem2.remove("m1");
  assert.equal(mem2.count, 1);
  await mem2.clear();
  assert.equal(mem2.count, 0);
});

test("本地记忆：缺字段抛错", async () => {
  const mem = createLocalMemory({ backend: createMemoryDocBackend() });
  await assert.rejects(mem.add({ id: "x" }), /id 与 text/);
});
