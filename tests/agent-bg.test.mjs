import test from "node:test";
import assert from "node:assert/strict";

import { coverRect, isMonochrome, createBgAgent } from "../www/js/core/agent/subs/bg.js";

test("coverRect：16:9 原图不裁，4:3 裁上下", () => {
  assert.deepEqual(coverRect(1920, 1080, 960, 540), { sx: 0, sy: 0, sw: 1920, sh: 1080 });
  const r = coverRect(1600, 1200, 960, 540);
  assert.equal(r.sw, 1600);
  assert.equal(r.sh, 900);
  assert.equal(r.sy, 150);
  assert.equal(r.sx, 0);
});

test("isMonochrome：纯色/近纯色为真，彩色为假", () => {
  const gray = Array.from({ length: 20 }, () => [128, 128, 128]);
  assert.equal(isMonochrome(gray), true);
  const dark = Array.from({ length: 20 }, () => [10, 10, 12]);
  assert.equal(isMonochrome(dark), true);
  const colorful = Array.from({ length: 20 }, (_, i) => [i * 12, 255 - i * 10, (i * 37) % 255]);
  assert.equal(isMonochrome(colorful), false);
  assert.equal(isMonochrome([]), true);
});

test("search：走 /__image/search 并归一化", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      async json() {
        return { source: "bing", items: [{ url: "https://x/a.jpg", thumb: "https://x/a_t.jpg" }] };
      },
    };
  };
  const bg = createBgAgent({ fetchImpl });
  const r = await bg.search("rain window", { n: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.source, "bing");
  assert.equal(r.items.length, 1);
  assert.match(calls[0], /q=rain\+window/);
  assert.match(calls[0], /n=4/);
});

test("search：空词与上游失败", async () => {
  const bg = createBgAgent({ fetchImpl: async () => ({ ok: false, status: 502 }) });
  assert.equal((await bg.search("")).reason, "empty_query");
  assert.equal((await bg.search("x")).reason, "search_http_502");
});
