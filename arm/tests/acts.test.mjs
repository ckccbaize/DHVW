import test from "node:test";
import assert from "node:assert/strict";
import { ACT_DURATION, pickDuration } from "../www/js/core/life/acts.js";

test("pickDuration：有基准且带抖动", () => {
  assert.equal(pickDuration("read", () => 0.5), ACT_DURATION.read);
  assert.ok(pickDuration("sleep", () => 0) < ACT_DURATION.sleep);
  assert.ok(pickDuration("sleep", () => 1) > ACT_DURATION.sleep);
  assert.equal(pickDuration("unknown", () => 0.5), 15);
});
