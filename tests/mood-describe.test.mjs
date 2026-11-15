import test from "node:test";
import assert from "node:assert/strict";
import { describeMood, moodTone } from "../www/js/core/mood/describe.js";

test("describeMood：把 [0,1] 数值翻成自然语言", () => {
  assert.equal(describeMood({}), "情绪平稳");
  const low = describeMood({ valence: 0.18, energy: 0.2 });
  assert.match(low, /心里发沉/);
  assert.match(low, /很乏/);
  assert.doesNotMatch(low, /0\./);
});

test("moodTone：按 [0,1] 情绪给语气约束", () => {
  assert.match(moodTone({ valence: 0.2 }), /语气低/);
  assert.match(moodTone({ energy: 0.25 }), /句子短/);
  assert.match(moodTone({}), /自然/);
});
