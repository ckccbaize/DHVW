import test from "node:test";
import assert from "node:assert/strict";
import { LOOKS, lookFor } from "../www/js/core/tourlooks.js";

test("LOOKS 是三套形象，顺序固定", () => {
  assert.deepEqual(LOOKS, ["whale", "atri", "miku"]);
});

test("每个场景都换一次形象：家/书店/咖啡厅/公园四段各不相同", () => {
  const seq = [0, 1, 2, 3].map((i) => lookFor(i));
  // 相邻必须不同——「每次更换场景都要切换一下形象」的直接断言
  for (let i = 1; i < seq.length; i += 1) {
    assert.notEqual(seq[i], seq[i - 1], `场景 ${i} 与 ${i - 1} 用了同一套形象 ${seq[i]}`);
  }
  assert.deepEqual(seq, ["whale", "atri", "miku", "whale"]);
});

test("形象按序号循环，不越界", () => {
  for (let i = 0; i < 12; i += 1) {
    assert.ok(LOOKS.includes(lookFor(i)), `序号 ${i} 返回了库外形象`);
  }
  assert.equal(lookFor(0), lookFor(LOOKS.length));
});

test("负数与非法序号也能落到库内", () => {
  assert.ok(LOOKS.includes(lookFor(-1)));
  assert.ok(LOOKS.includes(lookFor(-7)));
  assert.equal(lookFor(NaN), "whale");
  assert.equal(lookFor(2.9), "miku", "小数按截断取");
});

test("形象子集（有加载失败时）按可用列表循环", () => {
  const avail = ["whale", "atri"];
  const seq = [0, 1, 2, 3].map((i) => lookFor(i, avail));
  for (let i = 1; i < seq.length; i += 1) assert.notEqual(seq[i], seq[i - 1]);
  assert.ok(seq.every((n) => avail.includes(n)));
});

test("空列表退回完整 LOOKS", () => {
  assert.equal(lookFor(1, []), "atri");
  assert.equal(lookFor(1, null), "atri");
});
