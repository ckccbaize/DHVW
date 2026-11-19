import test from "node:test";
import assert from "node:assert/strict";

import { createEventPoolAgent, validateEvent } from "../www/js/core/agent/subs/events.js";
import { createPlotAgent, pickDailyEvent } from "../www/js/core/agent/subs/plot.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const registry = createRegistryFromData({
  version: 1,
  skills: {
    "event-pool": {
      name: "event-pool",
      description: "事件池",
      class: "work",
      prompt: "event-pool",
      maxTokens: 600,
      temperature: 0.9,
      tools: [],
      output: "json",
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
      output: "json",
      body: "",
    },
  },
  prompts: {
    "event-pool": "已有：{{existing}} 生成 {{count}} 条",
    plot: "事件：{{input}} 时段：{{period}}",
    "plot-repair": "重写：{{reason}}",
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

const good = {
  text: "她把阳台的鞋一双双摆正",
  hours: [9, 10],
  place: "balcony",
  mood: { valence: 0.04 },
  imageQuery: "shoes balcony morning",
};

test("validateEvent：字段与重复", () => {
  assert.equal(validateEvent(good), null);
  assert.equal(validateEvent({ ...good, text: "短" }), "bad_text");
  assert.equal(validateEvent({ ...good, hours: [] }), "bad_hours");
  assert.equal(validateEvent({ ...good, hours: [24] }), "bad_hours");
  assert.equal(validateEvent({ ...good, place: "moon" }), "bad_place");
  assert.equal(validateEvent({ ...good, mood: { anger: 0.1 } }), "bad_mood_dim:anger");
  assert.equal(validateEvent({ ...good, mood: { valence: 0.8 } }), "bad_mood_delta:valence");
  assert.equal(validateEvent({ ...good, imageQuery: "" }), "bad_image_query");
  assert.equal(validateEvent(good, { existing: [good.text] }), "duplicate");
});

test("refresh：接受合法、拒绝重复与坏字段", async () => {
  const llm = scripted([
    JSON.stringify({
      events: [
        good,
        { ...good, text: good.text },
        { ...good, text: "她在门口擦鞋底", place: "moon" },
      ],
    }),
  ]);
  const agent = createEventPoolAgent({ llm, registry, now: () => 1000 });
  const r = await agent.refresh({ existing: ["她在厨房洗杯子"], count: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].source, "llm");
  assert.equal(r.rejected.length, 2);
  assert.equal(llm.calls[0].json, true);
});

test("refresh：坏 JSON / LLM 失败", async () => {
  const bad = createEventPoolAgent({ llm: scripted(["nope"]), registry });
  assert.equal((await bad.refresh()).reason, "bad_json");
  const fail = createEventPoolAgent({ llm: scripted([new Error("net")]), registry });
  assert.equal((await fail.refresh()).reason, "llm_failed");
});

test("pickDailyEvent：扩展池参与挑选", () => {
  const extra = { id: "gen-1", text: "她在窗边给表上弦", hours: [22], place: "living", mood: {}, imageQuery: "clock" };
  const picked = pickDailyEvent({ hour: 22, pool: [extra], random: () => 0 });
  assert.equal(picked.id, "gen-1");
});

test("plot：extraEvents 作为默认种子", async () => {
  const extra = { id: "gen-1", text: "她在窗边给表上弦", hours: [22], place: "living", mood: {}, imageQuery: "clock" };
  const llm = scripted([
    JSON.stringify({
      text: "夜里，她在窗边给旧表上弦，秒针重新走起来。桌上的水凉了，她端起来喝了一口。",
      event: "给表上弦",
      place: "living",
      scene: "living",
      mood: { focus: 0.05 },
      imageQuery: "old clock window night",
    }),
  ]);
  const agent = createPlotAgent({ llm, registry, now: () => new Date(2026, 10, 12, 22, 0).getTime() });
  const r = await agent.run({ extraEvents: [extra], random: () => 0 });
  assert.equal(r.ok, true);
  assert.match(llm.calls[0].messages[0].content, /给表上弦/);
});
