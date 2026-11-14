import test from "node:test";
import assert from "node:assert/strict";
import { createActRoomMap, roomForAct, normalizeBehaviors } from "../www/js/core/life/plan.js";

const hotspots = [
  { act: "cook", room: "hall" },
  { act: "watch", room: "living" },
  { act: "sleep", room: "bedroom" },
  { act: "bath", room: "bath" },
  { prop: "table", act: "eat", room: "hall" },
  { prop: "coffee_table", act: "rest", room: "living" },
];

test("roomForAct：动作只在有热点的房间执行", () => {
  const map = createActRoomMap(hotspots);
  assert.equal(roomForAct(map, "cook", "bedroom"), "hall");
  assert.equal(roomForAct(map, "cook", "hall"), "hall");
  assert.equal(roomForAct(map, "dance", "living"), null);
  assert.equal(roomForAct(map, "write", "bedroom"), "hall");
});

test("normalizeBehaviors：错地点改到可用房间，无热点动作丢弃", () => {
  const out = normalizeBehaviors(
    [
      { minute: 490, act: "cook", place: "bedroom", why: "做早饭" },
      { minute: 600, act: "watch", place: "living", why: "看电视" },
      { minute: 700, act: "dance", place: "living", why: "跳舞" },
      { minute: -1, act: "sleep", place: "bedroom" },
    ],
    { rooms: new Set(["living", "hall", "bedroom", "bath"]), hotspots, fallbackPlace: "living" },
  );
  assert.deepEqual(out, [
    { minute: 490, act: "cook", place: "hall", why: "做早饭" },
    { minute: 600, act: "watch", place: "living", why: "看电视" },
  ]);
});
