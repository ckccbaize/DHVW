import test from "node:test";
import assert from "node:assert/strict";

import { createRecordAgent, validateRecord } from "../www/js/core/agent/subs/record.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const registry = createRegistryFromData({
  version: 1,
  skills: {
    "behavior-record": {
      name: "behavior-record",
      description: "留档",
      class: "character",
      prompt: "behavior-record",
      maxTokens: 220,
      temperature: 0.7,
      tools: [],
      output: "json",
      body: "",
    },
  },
  prompts: { "behavior-record": "{{name}} {{kind}} {{place}} {{detail}} {{before}} {{after}}" },
});

function scripted(texts) {
  const calls = [];
  return {
    calls,
    async complete(opts) {
      calls.push(opts);
      const t = texts[Math.min(calls.length - 1, texts.length - 1)];
      if (t instanceof Error) throw t;
      return { text: t };
    },
  };
}

const good = JSON.stringify({
  summary: "她把面煮好，吃完觉得暖了一点。",
  mood: "energy +0.08, valence +0.05",
  evidence: "",
});

test("validateRecord：长度与字段", () => {
  assert.equal(validateRecord(JSON.parse(good)), null);
  assert.equal(validateRecord({ summary: "太短", mood: "x" }), "bad_summary");
  assert.equal(validateRecord({ summary: "她把面煮好，吃完觉得暖了一点。", mood: "" }), "bad_mood");
  assert.equal(validateRecord(null), "not_object");
});

test("run：合法留档", async () => {
  const llm = scripted([good]);
  const agent = createRecordAgent({ llm, registry, now: () => 1 });
  const r = await agent.run({
    behavior: { id: "cook", name: "做点吃的", kind: "home" },
    before: { energy: 0.5 },
    after: { energy: 0.58 },
  });
  assert.equal(r.ok, true);
  assert.match(r.summary, /面/);
  assert.equal(r.mood, "energy +0.08, valence +0.05");
  assert.equal(llm.calls[0].json, true);
  assert.equal(llm.calls[0].cls, "character");
});

test("run：坏 JSON / LLM 失败", async () => {
  const bad = createRecordAgent({ llm: scripted(["nope"]), registry });
  assert.equal((await bad.run({ behavior: { name: "看书", kind: "home" } })).reason, "invalid_json");
  const fail = createRecordAgent({ llm: scripted([new Error("net")]), registry });
  assert.equal((await fail.run({ behavior: { name: "看书", kind: "home" } })).reason, "llm_failed");
});
