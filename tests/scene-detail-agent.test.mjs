import test from "node:test";
import assert from "node:assert/strict";

import { pickOpenLayout } from "../www/js/forge/floorplan.js";
import { buildOpenSceneSpec } from "../www/js/forge/scene-spec.js";
import { buildSceneFromLlm } from "../www/js/forge/scene-llm.js";
import { runSceneDetailAgent } from "../www/js/core/agent/scene-detail-agent.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const registry = createRegistryFromData({
  version: 1,
  skills: {},
  prompts: { "scene-detail": "{{kind}} {{name}} {{scene}} {{tools}}" },
});

test("runSceneDetailAgent：只叠加细节，不删家具", async () => {
  const layout = pickOpenLayout(32, 24, "detail-test");
  const spec = buildOpenSceneSpec(layout, { kind: "cafe", name: "咖啡馆", seed: "detail-test" });
  const base = buildSceneFromLlm(spec);
  assert.equal(base.ok, true);
  const target = base.scene.props[0];
  const calls = [
    { tool: "get_scene" },
    { tool: "add_prop_detail", args: { target: target.name || target.id, shapes: [{ kind: "line", x1: 0, y1: 0, x2: 15, y2: 0, color: "#ffffff" }] } },
    { tool: "add_floor_detail", args: { details: [{ x: 3, y: 3, shape: [{ kind: "line", x1: 0, y1: 0, x2: 15, y2: 0, color: "#000000" }] }] } },
    { tool: "validate" },
    { tool: "finish" },
  ];
  let i = 0;
  const llm = { async complete() { return { text: JSON.stringify(calls[Math.min(i++, calls.length - 1)]) }; } };
  const turns = [];
  const r = await runSceneDetailAgent({
    llm,
    registry,
    scene: base.scene,
    kind: "cafe",
    name: "咖啡馆",
    onTurn: async (t) => turns.push(t),
  });
  assert.equal(r.ok, true);
  assert.equal(r.scene.props.length, base.scene.props.length);
  assert.ok(r.scene.decor.length >= 1);
  assert.ok(r.scene.props.some((p) => p.overlay?.length || p.shape?.length > 1));
});
