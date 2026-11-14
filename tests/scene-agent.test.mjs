import test from "node:test";
import assert from "node:assert/strict";

import { pickOpenLayout } from "../www/js/forge/floorplan.js";
import { buildOpenSceneSpec } from "../www/js/forge/scene-spec.js";
import { runSceneAgent } from "../www/js/core/agent/scene-agent.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const registry = createRegistryFromData({
  version: 1,
  skills: {},
  prompts: {
    "scene-agent": "{{description}} {{kind}} {{name}} {{layout}} {{tools}} {{furniture}} {{acts}} {{animations}}",
  },
});

test("runSceneAgent：多轮工具调用直到 finish", async () => {
  const layout = pickOpenLayout(32, 24, "agent-test");
  const spec = buildOpenSceneSpec(layout, { kind: "cafe", name: "咖啡馆", seed: "agent-test" });
  const calls = [
    { tool: "get_layout" },
    { tool: "add_props", args: { props: spec.props } },
    { tool: "set_interactions", args: { interactions: spec.interactions } },
    { tool: "set_routes", args: { routes: spec.routes } },
    { tool: "validate" },
    { tool: "finish" },
  ];
  let i = 0;
  const llm = {
    async complete() {
      return { text: JSON.stringify(calls[Math.min(i++, calls.length - 1)]) };
    },
  };
  const turns = [];
  const r = await runSceneAgent({
    llm,
    registry,
    layout,
    kind: "cafe",
    name: "咖啡馆",
    description: "咖啡馆",
    onTurn: async (t) => turns.push(t),
  });
  assert.equal(r.ok, true);
  assert.equal(r.turns, 6);
  assert.equal(turns.at(-1).tool, "finish");
  assert.ok(r.scene.props.length >= 40);
});
