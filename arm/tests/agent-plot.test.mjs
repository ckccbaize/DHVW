import test from "node:test";
import assert from "node:assert/strict";

import {
  createPlotAgent,
  hasTimeAnchor,
  periodOf,
  pickDailyEvent,
  similarity,
  validatePlot,
  validatePlotResult,
} from "../www/js/core/agent/subs/plot.js";
import { createManagerAgent } from "../www/js/core/agent/manager.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const V = "夜里，她坐在窗边数雨点，数到三十七就停了。杯子里的水凉了，她起身去续，又坐回原处。";
const V2 = "深夜，她把洗好的碗一只只倒扣在架上，水滴沿着瓷沿往下走。窗外的车灯扫过墙面，又退回去。";

const J = (text = V, extra = {}) =>
  JSON.stringify({
    text,
    event: "雨停开窗",
    place: "living",
    scene: "living",
    mood: { valence: 0.05, energy: -0.02 },
    imageQuery: "rain window night",
    ...extra,
  });

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
      output: "json",
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

const atNight = () => new Date(2026, 10, 12, 22, 0).getTime();

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

test("validatePlotResult：字段与增量边界", () => {
  assert.equal(validatePlotResult(JSON.parse(J()), { hour: 22 }), null);
  assert.equal(validatePlotResult(JSON.parse(J(V, { place: "moon" })), { hour: 22 }), "bad_place");
  assert.equal(validatePlotResult(JSON.parse(J(V, { mood: { anger: 0.1 } })), { hour: 22 }), "bad_mood_dim:anger");
  assert.equal(validatePlotResult(JSON.parse(J(V, { mood: { valence: 0.9 } })), { hour: 22 }), "bad_mood_delta:valence");
  assert.equal(validatePlotResult(JSON.parse(J(V, { imageQuery: "" })), { hour: 22 }), "bad_image_query");
  assert.equal(validatePlotResult(JSON.parse(J(V, { event: "" })), { hour: 22 }), "bad_event");
});

test("pickDailyEvent：按时段过滤并避开最近事件", () => {
  const night = pickDailyEvent({ hour: 22, random: () => 0 });
  assert.ok(night.hours.includes(22));
  const avoid = pickDailyEvent({ hour: 22, recent: [night.id], random: () => 0 });
  assert.notEqual(avoid.id, night.id);
  const morning = pickDailyEvent({ hour: 7, random: () => 0 });
  assert.ok(morning.hours.includes(7));
});

test("similarity：相同文本为 1，无关文本低", () => {
  assert.equal(similarity(V, V), 1);
  assert.ok(similarity(V, V2) < 0.6);
});

test("run：首稿合格 → 结构化字段返回", async () => {
  const llm = scripted([J()]);
  const agent = createPlotAgent({ llm, registry, now: atNight });
  const r = await agent.run({ input: "雨停了" });
  assert.equal(r.ok, true);
  assert.equal(r.event, "雨停开窗");
  assert.equal(r.place, "living");
  assert.deepEqual(r.mood, { valence: 0.05, energy: -0.02 });
  assert.equal(r.imageQuery, "rain window night");
  assert.equal(r.attempts, 1);
  assert.equal(llm.calls[0].json, true);
});

test("run：首稿太短 → 带原因重写", async () => {
  const llm = scripted([J("太短。"), J()]);
  const agent = createPlotAgent({ llm, registry, now: atNight });
  const r = await agent.run({ input: "雨停了" });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.match(llm.calls[1].messages[0].content, /too_short/);
});

test("run：重复 → 重写；三次仍不合格 → 失败", async () => {
  const llm = scripted([J(), J(V2)]);
  const agent = createPlotAgent({ llm, registry, now: atNight });
  const r = await agent.run({ input: "雨停了", recent: [V] });
  assert.equal(r.ok, true);
  assert.equal(r.text, V2);

  const bad = createPlotAgent({ llm: scripted([J("短。")]), registry, now: atNight });
  const f = await bad.run({ input: "x" });
  assert.equal(f.ok, false);
  assert.equal(f.reason, "too_short");
  assert.equal(f.attempts, 3);
});

test("run：非法 JSON → invalid_json 后重写", async () => {
  const llm = scripted(["不是 JSON", J()]);
  const agent = createPlotAgent({ llm, registry, now: atNight });
  const r = await agent.run({ input: "x" });
  assert.equal(r.ok, true);
  assert.match(llm.calls[1].messages[0].content, /invalid_json/);
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
