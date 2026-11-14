import test from "node:test";
import assert from "node:assert/strict";

import { buildSceneFromLlm, validateLlmScene } from "../www/js/forge/scene-llm.js";

function cafeSpec() {
  return {
    name: "街角咖啡馆",
    kind: "cafe",
    grid: { w: 24, h: 16, cell: 16 },
    rooms: [{ id: "main", name: "咖啡区", kind: "cafe", rect: [1, 1, 22, 14], floor: "wood" }],
    doors: [{ id: "door", x: 12, y: 15, to: "outside" }],
    windows: [{ x: 5, y: 0 }],
    props: [
      { id: "counter", x: 2, y: 2, w: 3, h: 1, room: "main", facing: "S" },
      { id: "table", x: 8, y: 6, w: 2, h: 2, room: "main" },
      { id: "chair", x: 8, y: 9, w: 1, h: 1, room: "main" },
      { id: "plant", x: 20, y: 2, w: 1, h: 1, room: "main" },
    ],
    spawn: { x: 12, y: 13 },
    interactions: {
      schema_version: 1,
      acts: {
        cook: {
          label: "做咖啡",
          trigger: { props: ["counter"] },
          perform: { animation: "cook", duration_min: 20, interruptible: true },
          effects: [{ kind: "event", name: "coffee" }],
          priority: 5,
        },
        sit: {
          label: "坐下",
          trigger: { props: ["chair"] },
          perform: { animation: "sit", duration_min: 10, interruptible: true },
          effects: [{ kind: "event", name: "sit" }],
          priority: 2,
        },
      },
    },
    routes: [
      { id: "spawn_counter", from: [12, 13], to: [4, 4], waypoints: [[12, 13], [12, 4], [4, 4]] },
    ],
  };
}

test("validateLlmScene：合法完整场景", () => {
  assert.deepEqual(validateLlmScene(cafeSpec()), []);
  const r = buildSceneFromLlm(cafeSpec());
  assert.equal(r.ok, true);
  assert.equal(r.scene.intGrid.length, 24 * 16);
  assert.ok(r.scene.entities.some((e) => e.type === "hotspot" && e.act === "cook"));
});

test("validateLlmScene：未知家具/动画/路线阻挡", () => {
  const a = cafeSpec();
  a.props.push({ id: "piano", x: 15, y: 10, w: 1, h: 1, room: "main" });
  assert.ok(validateLlmScene(a).some((e) => e.includes("unknown_prop")));

  const b = cafeSpec();
  b.interactions.acts.cook.perform.animation = "dance";
  assert.ok(validateLlmScene(b).some((e) => e.includes("act_animation")));

  const c = cafeSpec();
  c.routes[0].waypoints.push([0, 0]);
  assert.ok(validateLlmScene(c).some((e) => e.includes("route_blocked")));
});
