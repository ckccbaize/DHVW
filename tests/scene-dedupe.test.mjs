import test from "node:test";
import assert from "node:assert/strict";

import {
  dedupeSceneRequests,
  findSceneDirForPlace,
  sceneDirMatchesPlace,
  shouldEnqueueScene,
} from "../www/js/core/life/scene-dedupe.js";

test("sceneDirMatchesPlace：别名目录与 job 目录都算同一地点", () => {
  assert.equal(sceneDirMatchesPlace("library", "library"), true);
  assert.equal(sceneDirMatchesPlace("indoor-6-library", "library"), true);
  assert.equal(sceneDirMatchesPlace("indoor-21-library", "library"), true);
  assert.equal(sceneDirMatchesPlace("indoor-6-library", "bookstore"), false);
  assert.equal(sceneDirMatchesPlace("bookstore", "library"), false);
  // 不能把 library 误配到别的地点
  assert.equal(sceneDirMatchesPlace("street-13-park", "park"), true);
  assert.equal(sceneDirMatchesPlace("street-13-park", "library"), false);
});

test("findSceneDirForPlace：只认 <dir>.built.json，且按后缀归属", () => {
  const paths = [
    "/assets/scenes/library/library.built.json",
    "/assets/scenes/indoor-6-library/indoor-6-library.built.json",
    "/assets/scenes/indoor-6-library/scene.json",
    "/assets/scenes/bookstore/bookstore.built.json",
  ];
  assert.equal(findSceneDirForPlace(paths, "library"), "library");
  assert.equal(findSceneDirForPlace(paths, "bookstore"), "bookstore");
  assert.equal(findSceneDirForPlace(paths, "cafe"), "");
  // 只有 job 包、没有别名副本时也能认出来
  assert.equal(
    findSceneDirForPlace(["/assets/scenes/indoor-21-library/indoor-21-library.built.json"], "library"),
    "indoor-21-library",
  );
});

test("shouldEnqueueScene：有场景/有请求/当天已失败都不再申请", () => {
  const base = { requests: [], placeId: "library", day: 21 };
  assert.equal(shouldEnqueueScene({ ...base, hasScene: false }), true);
  // 已有场景：即便请求表是空的也不申请（这就是重复生成图书馆那条路径）
  assert.equal(shouldEnqueueScene({ ...base, hasScene: true }), false);
  // 已有 pending / ready
  assert.equal(shouldEnqueueScene({ ...base, requests: [{ placeId: "library", status: "pending" }] }), false);
  assert.equal(shouldEnqueueScene({ ...base, requests: [{ placeId: "library", status: "ready" }] }), false);
  // 同一天失败过：不重提
  assert.equal(
    shouldEnqueueScene({ ...base, requests: [{ placeId: "library", status: "failed", day: 21 }] }),
    false,
  );
  // 换了一天：允许重提
  assert.equal(
    shouldEnqueueScene({ ...base, requests: [{ placeId: "library", status: "failed", day: 19 }] }),
    true,
  );
  // 别的地点不影响
  assert.equal(shouldEnqueueScene({ ...base, requests: [{ placeId: "cafe", status: "pending" }] }), true);
  assert.equal(shouldEnqueueScene({ ...base, placeId: "" }), false);
});

test("dedupeSceneRequests：同地点只留一条，优先 ready/failed 而非新造的 pending", () => {
  const requests = [
    { id: "scene-library-21", placeId: "library", status: "pending", createdAt: 100 },
    { id: "scene-library-6", placeId: "library", status: "ready", createdAt: 10 },
    { id: "scene-cafe-5", placeId: "cafe", status: "pending", createdAt: 20 },
  ];
  const out = dedupeSceneRequests(requests);
  assert.equal(out.length, 2);
  const lib = out.find((r) => r.placeId === "library");
  assert.equal(lib.id, "scene-library-6");
  assert.equal(lib.status, "ready");
});

test("dedupeSceneRequests：已有场景的 pending 被丢掉", () => {
  const requests = [
    { id: "scene-library-21", placeId: "library", status: "pending", createdAt: 100 },
    { id: "scene-cafe-5", placeId: "cafe", status: "pending", createdAt: 20 },
  ];
  const out = dedupeSceneRequests(requests, (id) => id === "library");
  assert.deepEqual(out.map((r) => r.placeId), ["cafe"]);
});

test("dedupeSceneRequests：忽略坏数据", () => {
  const out = dedupeSceneRequests([null, { id: "x" }, { placeId: "cafe", status: "pending" }]);
  assert.deepEqual(out.map((r) => r.placeId), ["cafe"]);
  assert.deepEqual(dedupeSceneRequests(undefined), []);
});
