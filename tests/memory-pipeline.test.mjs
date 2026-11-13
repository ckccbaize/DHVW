import test from "node:test";
import assert from "node:assert/strict";

import { createMemoryPipeline, prefilter, validateFacts } from "../www/js/core/memory/pipeline.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const registry = createRegistryFromData({
  version: 1,
  skills: {
    "memory-summarize": {
      name: "memory-summarize",
      description: "归纳",
      class: "work",
      prompt: "memory-summarize",
      maxTokens: 800,
      temperature: 0.3,
      tools: [],
      output: "json",
      body: "",
    },
  },
  prompts: { "memory-summarize": "{{events}} {{existing}}" },
});

function scripted(texts) {
  const calls = [];
  return {
    calls,
    async complete(opts) {
      calls.push(opts);
      return { text: texts[Math.min(calls.length - 1, texts.length - 1)] };
    },
  };
}

function fakeMemory() {
  const docs = [];
  return {
    docs,
    search: () => [],
    async add(doc) {
      docs.push(doc);
      return doc;
    },
  };
}

const events = [
  { kind: "plot:generated", payload: { text: "雨停了" }, t_local: 1 },
  { kind: "behavior:done", payload: { name: "做点吃的" }, t_local: 2 },
  { kind: "travel:arrive", payload: { to: "cafe" }, t_local: 3 },
  { kind: "debug", payload: {}, t_local: 4 },
  { kind: "wake:silent", payload: {}, t_local: 5 },
];

test("prefilter：排除噪声与上限", () => {
  const out = prefilter(events);
  assert.equal(out.length, 3);
  assert.ok(out.every((e) => e.kind !== "debug" && e.kind !== "wake:silent"));
  assert.equal(prefilter(events, { limit: 2 }).length, 2);
});

test("validateFacts：长度过滤", () => {
  const r = validateFacts([{ text: "太短" }, { text: "她喜欢在雨天开窗，听楼下的雨声。" }]);
  assert.equal(r.facts.length, 1);
  assert.equal(r.rejected[0].reason, "bad_length");
});

test("pipeline：归纳 → 本地记忆 → PC 候选", async () => {
  const llm = scripted([
    JSON.stringify({
      facts: [
        { text: "她喜欢在雨天开窗，听楼下的雨声。", tier: "L2" },
        { text: "她常去咖啡馆坐一会儿。", tier: "L2" },
      ],
    }),
  ]);
  const memory = fakeMemory();
  const sent = [];
  const pipeline = createMemoryPipeline({ llm, registry, localMemory: memory, sendCandidates: (p) => sent.push(p) });
  const r = await pipeline.run(events);
  assert.equal(r.ok, true);
  assert.equal(r.facts.length, 2);
  assert.equal(memory.docs.length, 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].facts.length, 2);
});

test("pipeline：重复事实不重复入库", async () => {
  const llm = scripted([JSON.stringify({ facts: [{ text: "她喜欢在雨天开窗，听楼下的雨声。" }] })]);
  const memory = fakeMemory();
  const seen = new Set();
  const p1 = createMemoryPipeline({ llm, registry, localMemory: memory, seen });
  await p1.run(events);
  const p2 = createMemoryPipeline({ llm, registry, localMemory: memory, seen });
  const r = await p2.run(events);
  assert.equal(r.facts.length, 0);
  assert.equal(memory.docs.length, 1);
});

test("pipeline：事件不足 / 坏 JSON", async () => {
  const p = createMemoryPipeline({ llm: scripted(["{}"]), registry });
  assert.equal((await p.run(events.slice(0, 2))).reason, "not_enough_events");
  const bad = createMemoryPipeline({ llm: scripted(["nope"]), registry });
  assert.equal((await bad.run(events)).reason, "invalid_json");
});
