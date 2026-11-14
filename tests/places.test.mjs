import test from "node:test";
import assert from "node:assert/strict";

import { createPlaceGraph, HOME_ID, planTravel, travelMinutes, validatePlace } from "../www/js/core/places/graph.js";

const cafe = { id: "cafe", name: "咖啡馆", kind: "indoor", distance: 6 };
const park = { id: "park", name: "公园", kind: "street", distance: 10 };

test("validatePlace：字段与边界", () => {
  assert.equal(validatePlace(cafe), null);
  assert.equal(validatePlace({ ...cafe, id: "Bad ID" }), "bad_id");
  assert.equal(validatePlace({ ...cafe, name: "" }), "bad_name");
  assert.equal(validatePlace({ ...cafe, distance: -1 }), "bad_distance");
  assert.equal(validatePlace({ ...cafe, distance: 999 }), "bad_distance");
});

test("graph：家 + 自定义地点，增删", () => {
  const g = createPlaceGraph({ places: [cafe] });
  assert.ok(g.get(HOME_ID));
  assert.equal(g.list().length, 2);
  assert.equal(g.add(park).ok, true);
  assert.equal(g.list().length, 3);
  assert.equal(g.remove("cafe"), true);
  assert.equal(g.remove(HOME_ID), false);
  assert.equal(g.add({ ...park, id: HOME_ID }).reason, "home_reserved");
});

test("travel：步行时间与同地点", () => {
  const g = createPlaceGraph({ places: [cafe, park] });
  assert.deepEqual(g.travel(HOME_ID, "cafe"), { from: HOME_ID, to: "cafe", minutes: 12 });
  assert.equal(g.travel(HOME_ID, HOME_ID).minutes, 0);
  assert.equal(g.travel(HOME_ID, "nope"), null);
  assert.equal(travelMinutes(1), 3);
});

test("planTravel：跨夜判定", () => {
  const g = createPlaceGraph({ places: [park] });
  const day = planTravel({ graph: g, from: HOME_ID, to: "park", minute: 10 * 60 });
  assert.equal(day.ok, true);
  assert.equal(day.minutes, 20);
  assert.equal(day.crossesNight, false);

  const night = planTravel({ graph: g, from: HOME_ID, to: "park", minute: 23 * 60 + 50 });
  assert.equal(night.crossesNight, true);
  assert.equal(night.arriveMinute, 24 * 60 + 10);

  assert.equal(planTravel({ graph: g, from: HOME_ID, to: "nope", minute: 0 }).reason, "unknown_place");
});
