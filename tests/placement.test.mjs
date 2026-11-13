import test from "node:test";
import assert from "node:assert/strict";

import { applyPlacement, validatePlacement } from "../www/js/forge/placement.js";
import { createPlaceAgent } from "../www/js/core/agent/subs/place.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const layout = {
  rooms: [
    { id: "a", rect: [1, 1, 6, 6] },
    { id: "b", rect: [8, 1, 4, 4] },
  ],
  doors: [{ id: "d1", x: 7, y: 3, to: "b" }],
};

test("validatePlacement：合法摆放", () => {
  const errors = validatePlacement({
    ...layout,
    props: [
      { id: "chair", x: 2, y: 2 },
      { id: "plant", x: 4, y: 4 },
      { id: "rug", x: 2, y: 3 },
    ],
  });
  assert.deepEqual(errors, []);
});

test("validatePlacement：越界/重叠/门净空/贴墙/大件唯一", () => {
  assert.ok(validatePlacement({ ...layout, props: [{ id: "chair", x: 20, y: 20 }] }).includes("out_of_room:chair@20,20"));
  assert.ok(
    validatePlacement({
      ...layout,
      props: [
        { id: "chair", x: 2, y: 2 },
        { id: "plant", x: 2, y: 2 },
      ],
    }).some((e) => e.startsWith("overlap")),
  );
  assert.ok(
    validatePlacement({ ...layout, props: [{ id: "chair", x: 6, y: 3 }] }).some((e) => e.startsWith("door_blocked")),
  );
  assert.ok(validatePlacement({ ...layout, props: [{ id: "bed", x: 3, y: 3 }] }).includes("not_wall_hug:bed"));
  assert.ok(
    validatePlacement({
      ...layout,
      props: [
        { id: "bed", x: 1, y: 1 },
        { id: "bed", x: 1, y: 4 },
      ],
    }).includes("duplicate_big:bed"),
  );
  assert.ok(validatePlacement({ ...layout, props: [{ id: "ghost", x: 2, y: 2 }] }).includes("unknown_furniture:ghost"));
});

test("applyPlacement：补 w/h", () => {
  const spec = applyPlacement({ rooms: layout.rooms }, [{ id: "bed", x: 1, y: 1 }]);
  assert.equal(spec.props[0].w, 2);
  assert.equal(spec.props[0].h, 3);
});

const registry = createRegistryFromData({
  version: 1,
  skills: {
    "furniture-plan": {
      name: "furniture-plan",
      description: "摆家具",
      class: "work",
      prompt: "furniture-plan",
      maxTokens: 700,
      temperature: 0.4,
      tools: [],
      output: "json",
      body: "",
    },
  },
  prompts: { "furniture-plan": "{{rooms}} {{doors}} {{furniture}} {{intent}}" },
});

function scripted(texts) {
  const calls = [];
  return {
    calls,
    async complete(opts) {
      calls.push(opts);
      const t = texts[Math.min(calls.length - 1, texts.length - 1)];
      return { text: t };
    },
  };
}

test("placeAgent：合法一次通过", async () => {
  const llm = scripted([JSON.stringify({ props: [{ id: "chair", x: 2, y: 2 }] })]);
  const agent = createPlaceAgent({ llm, registry });
  const r = await agent.run({ layout });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(llm.calls[0].json, true);
});

test("placeAgent：非法带原因重试", async () => {
  const llm = scripted([
    JSON.stringify({ props: [{ id: "chair", x: 20, y: 20 }] }),
    JSON.stringify({ props: [{ id: "chair", x: 2, y: 2 }] }),
  ]);
  const agent = createPlaceAgent({ llm, registry });
  const r = await agent.run({ layout });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.match(llm.calls[1].messages[0].content, /out_of_room/);
});

test("placeAgent：三次仍非法 → 失败", async () => {
  const llm = scripted([JSON.stringify({ props: [{ id: "ghost", x: 2, y: 2 }] })]);
  const agent = createPlaceAgent({ llm, registry });
  const r = await agent.run({ layout });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "placement_invalid");
  assert.ok(r.errors.some((e) => e.startsWith("unknown_furniture")));
});
