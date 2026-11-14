import test from "node:test";
import assert from "node:assert/strict";

import { createManagerAgent, extractJson, validatePlan } from "../www/js/core/agent/manager.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";
import { buildRegistry } from "../tools/build-agent.mjs";
import path from "node:path";

const registry = createRegistryFromData({
  version: 1,
  skills: {
    "wake-character": {
      name: "wake-character",
      description: "唤醒",
      class: "character",
      prompt: "character-wake",
      maxTokens: 200,
      temperature: 0.8,
      tools: [],
      output: "text",
      body: "",
    },
    "plot-writer": {
      name: "plot-writer",
      description: "剧情",
      class: "work",
      prompt: "plot",
      maxTokens: 400,
      temperature: 0.5,
      tools: [],
      output: "text",
      body: "",
    },
    "json-skill": {
      name: "json-skill",
      description: "JSON",
      class: "work",
      prompt: "plot",
      maxTokens: 200,
      temperature: 0.2,
      tools: [],
      output: "json",
      body: "",
    },
  },
  prompts: {
    "manager-plan": "技能：{{skills}}\n目标：{{intent}}\n时间：{{now}}",
    "character-wake": "现在：{{now}} 种子：{{input}}",
    plot: "事件：{{input}}",
  },
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

function harness(texts, opts = {}) {
  const events = [];
  const runs = [];
  const llm = scripted(texts);
  const agent = createManagerAgent({
    llm,
    registry,
    appendEvent: async (kind, payload) => events.push({ kind, payload }),
    saveRun: async (r) => runs.push(r),
    now: (() => {
      let t = 1000;
      return () => (t += 10);
    })(),
    idFactory: () => "run-1",
    ...opts,
  });
  return { agent, llm, events, runs };
}

test("extractJson：代码围栏与前后噪声", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('前缀 {"a":1} 后缀'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}\n{"b":2}'), { a: 1 });
  assert.deepEqual(extractJson('错误 {"a":{"b":2}} 尾巴 }'), { a: { b: 2 } });
  assert.equal(extractJson("nope"), null);
});

test("validatePlan：未知技能 / 超量 / 缺字段", () => {
  assert.equal(validatePlan('{"tasks":[{"skill":"nope","input":"x"}]}', registry).reason, "unknown_skill:nope");
  const many = { tasks: Array.from({ length: 4 }, () => ({ skill: "plot-writer", input: "x" })) };
  assert.equal(validatePlan(JSON.stringify(many), registry).reason, "too_many_tasks");
  assert.equal(validatePlan('{"tasks":[{"skill":"plot-writer"}]}', registry).reason, "task_missing_input");
});

test("run：合法计划 → 顺序执行两个技能并落库", async () => {
  const { agent, llm, events, runs } = harness([
    '{"tasks":[{"skill":"wake-character","input":"雨停了"},{"skill":"plot-writer","input":"窗边"}]}',
    "雨停了，正好。",
    "她在窗边站了一会儿。",
  ]);
  const out = await agent.run("回应雨停");
  assert.equal(out.ok, true);
  assert.equal(out.tasks.length, 2);
  assert.equal(out.tasks[0].output, "雨停了，正好。");
  assert.equal(out.tasks[1].output, "她在窗边站了一会儿。");
  assert.equal(llm.calls.length, 3);
  assert.equal(llm.calls[0].json, true);
  assert.equal(llm.calls[1].cls, "character");
  assert.deepEqual(
    events.map((e) => e.kind),
    [
      "agent:agent_start",
      "agent:turn_start",
      "agent:message_end",
      "agent:tool_execution_start",
      "agent:tool_execution_end",
      "agent:tool_execution_start",
      "agent:tool_execution_end",
      "agent:turn_end",
      "agent:agent_end",
    ],
  );
  assert.equal(runs.length, 1);
  assert.equal(runs[0].ok, true);
});

test("run：非法 JSON → plan_rejected，不执行技能", async () => {
  const { agent, llm, events, runs } = harness(["这不是 JSON"]);
  const out = await agent.run("随便");
  assert.equal(out.ok, false);
  assert.equal(out.reason, "plan_not_object");
  assert.equal(llm.calls.length, 1);
  assert.ok(events.some((e) => e.kind === "agent:plan_rejected"));
  assert.equal(runs[0].ok, false);
});

test("run：未知技能 → plan_rejected", async () => {
  const { agent } = harness(['{"tasks":[{"skill":"ghost","input":"x"}]}']);
  const out = await agent.run("x");
  assert.equal(out.reason, "unknown_skill:ghost");
});

test("run：技能 JSON 输出非法 → 任务失败，整体 ok=false", async () => {
  const { agent } = harness(['{"tasks":[{"skill":"json-skill","input":"x"}]}', "not json"]);
  const out = await agent.run("x");
  assert.equal(out.ok, false);
  assert.equal(out.tasks[0].ok, false);
  assert.equal(out.tasks[0].error, "invalid_json_output");
});

test("run：真实注册表变量齐全（character-wake / plot）", async () => {
  const { registry: real } = await buildRegistry(path.resolve(import.meta.dirname, ".."));
  const reg = createRegistryFromData(real);
  const llm = scripted([
    '{"tasks":[{"skill":"wake-character","input":"雨停了"},{"skill":"plot-writer","input":"窗边"}]}',
    "雨停了，正好。",
    '{"text":"她在窗边站了一会儿。","event":"窗边","place":"living","mood":{},"imageQuery":"window"}',
  ]);
  const agent = createManagerAgent({
    llm,
    registry: reg,
    appendEvent: async () => {},
    saveRun: async () => {},
    now: () => 1000,
    idFactory: () => "r",
  });
  const out = await agent.run("回应雨停", {
    mood: "calm",
    place: "客厅",
    memory: "暂无",
    desires: "[]",
    behaviors: "暂无",
    history: "[]",
    map: "房间：living",
    map_pool: "[]",
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.tasks.length, 2);
});

test("run：LLM 失败 → llm_failed", async () => {
  const { agent } = harness([new Error("network down")]);
  const out = await agent.run("x");
  assert.equal(out.reason, "llm_failed");
});
