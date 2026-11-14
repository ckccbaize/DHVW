import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { deriveScene } from "../www/js/forge/lexicon.js";
import { parseDsl } from "../www/js/forge/dsl.js";

const lexicon = JSON.parse(fs.readFileSync(new URL("../www/assets/lexicon/scene.json", import.meta.url), "utf8"));

test("deriveScene：书房/雨夜 → 合法 DSL", () => {
  const r = deriveScene("深夜她在书房翻旧书，窗外下着雨。", lexicon);
  assert.equal(r.ok, true);
  assert.equal(r.arch, "study");
  assert.equal(r.light, "rain");
  assert.ok(r.features.includes("old_books"));
  assert.equal(parseDsl(r.dsl).ok, true, r.dsl);
});

test("deriveScene：无场景词返回失败", () => {
  assert.equal(deriveScene("她今天什么也没做。", lexicon).ok, false);
});

test("deriveScene：公园/白天 → green_outdoor", () => {
  const r = deriveScene("下午去公园散步，坐在长椅上看树。", lexicon);
  assert.equal(r.ok, true);
  assert.equal(r.arch, "park");
  assert.match(r.dsl, /green_outdoor/);
});
