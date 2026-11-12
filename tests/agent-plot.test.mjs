import test from "node:test";
import assert from "node:assert/strict";

import {
  createPlotAgent,
  hasTimeAnchor,
  periodOf,
  similarity,
  validatePlot,
} from "../www/js/core/agent/subs/plot.js";
import { createManagerAgent } from "../www/js/core/agent/manager.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const V = "夜里，她坐在窗边数雨点，数到三十七就停了。杯子里的水凉了，她起身去续，又坐回原处。";
const V2 = "深夜，她把洗好的碗一只只倒扣在架上，水滴沿着瓷沿往下走。窗外的车灯扫过墙面，又退回去。";

const registry = createRegistryFromData({
  version: 1,
  skills: {
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
  },
  prompts: {
    plot: "写小记 {{input}} {{period}} {{recent}}",
    "plot-repair": "重写：{{reason}} 上一稿：{{draft}} 最近：{{recent}}",
    "manager-plan": "技能：{{skills}} 目标：{{intent}}",
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

test("periodOf / hasTimeAnchor", () => {
  assert.equal(periodOf(7), "清晨");
  assert.equal(periodOf(15), "下午");
  assert.equal(periodOf(22), "夜里");
  assert.equal(periodOf(2), "深夜");
  assert.equal(hasTimeAnchor(V, 22), true);
  assert.equal(hasTimeAnchor("她坐了一会儿。", 22), false);
});

test("validatePlot：长度/台词/时间锚点/重复", () => {
  assert.equal(validatePlot("太短。", { hour: 22 }), "too_short");
  assert.equal(validatePlot("夜".repeat(81), { hour: 22 }), "too_long");
  assert.equal(validatePlot("夜里，她说“走吧”，然后把门关上，屋里只剩下雨声和钟摆的声音。", { hour: 22 }), "has_dialogue");
  assert.equal(validatePlot("她坐在窗边数雨点，数到三十七就停了。杯子里的水凉了，她起身去续。", { hour: 22 }), "no_time_anchor");
  assert.equal(validatePlot(V, { hour: 22, recent: [V] }), "duplicate");
  assert.equal(validatePlot(V, { hour: 22 }), null);
});

test("similarity：相同文本为 1，无关文本低", () => {
  assert.equal(similarity(V, V), 1);
  assert.ok(similarity(V, V2) < 0.6);
});

test("run：首稿合格 → 一次调用", async () => {
  const llm = scripted([V]);
  const agent = createPlotAgent({ llm, registry, now: () => new Date(2026, 10, 12, 22, 0).getTime() });
  const r = await agent.run({ input: "雨停了", place: "客厅", mood: "平静" });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(llm.calls.length, 1);
});

test("run：首稿太短 → 带原因重写", async () => {
  const llm = scripted(["太短了。", V]);
  const agent = createPlotAgent({ llm, registry, now: () => new Date(2026, 10, 12, 22, 0).getTime() });
  const r = await agent.run({ input: "雨停了" });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.match(llm.calls[1].messages[0].content, /too_short/);
});

test("run：重复 → 重写；三次仍不合格 → 失败", async () => {
  const llm = scripted([V, V2]);
  const agent = createPlotAgent({ llm, registry, now: () => new Date(2026, 10, 12, 22, 0).getTime() });
  const r = await agent.run({ input: "雨停了", recent: [V] });
  assert.equal(r.ok, true);
  assert.equal(r.text, V2);

  const bad = createPlotAgent({
    llm: scripted(["短。"]),
    registry,
    now: () => new Date(2026, 10, 12, 22, 0).getTime(),
  });
  const f = await bad.run({ input: "x" });
  assert.equal(f.ok, false);
  assert.equal(f.reason, "too_short");
  assert.equal(f.attempts, 3);
});

test("manager：plot-writer 走子 Agent，不再直接调 LLM", async () => {
  const llm = scripted(['{"tasks":[{"skill":"plot-writer","input":"雨停了"}]}']);
  const seen = [];
  const agent = createManagerAgent({
    llm,
    registry,
    subAgents: {
      "plot-writer": async (args) => {
        seen.push(args);
        return { ok: true, text: V };
      },
    },
    appendEvent: async () => {},
    saveRun: async () => {},
    now: () => 1000,
    idFactory: () => "r",
  });
  const out = await agent.run("写一段");
  assert.equal(out.ok, true);
  assert.equal(out.tasks[0].output, V);
  assert.equal(llm.calls.length, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input, "雨停了");
});
