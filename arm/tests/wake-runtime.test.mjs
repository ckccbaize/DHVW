import test from "node:test";
import assert from "node:assert/strict";

import { clampNextWake, createWakeRuntime, parseWakeJson } from "../www/js/core/wake/runtime.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const registry = createRegistryFromData({
  version: 1,
  skills: {
    wake: { name: "wake", description: "醒来", class: "character", prompt: "wake", maxTokens: 600, temperature: 0.8, tools: [], output: "json", body: "" },
  },
  prompts: {
    wake: "事件：{{seed}} 上下文：{{context}} 线头：{{threads}} 余念：{{residue}}",
  },
});

const good = (over = {}) =>
  JSON.stringify({
    outcome: "trace",
    fact: "雨停了，她开了窗",
    content: "她站在窗边看了一会儿",
    share: "",
    residue: "窗还开着",
    next_wake: { min_minutes: 50, max_minutes: 80, reason: "刚醒" },
    ...over,
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

test("parseWakeJson：三结局与不变量", () => {
  assert.equal(parseWakeJson(good()).ok, true);
  assert.equal(parseWakeJson(good({ outcome: "silent", share: "不该有" })).reason, "silent_with_share");
  assert.equal(parseWakeJson(good({ outcome: "message", share: "" })).reason, "message_without_share");
  assert.equal(parseWakeJson(good({ outcome: "talk" })).reason, "bad_outcome");
  assert.equal(parseWakeJson(good({ fact: "" })).reason, "missing_fact");
  assert.equal(parseWakeJson(good({ content: "" })).reason, "missing_content");
  assert.equal(parseWakeJson(good({ next_wake: null })).reason, "missing_next_wake");
  assert.equal(parseWakeJson("不是 JSON").reason, "not_object");
  assert.equal(parseWakeJson(good({ outcome: "message", share: "雨停了" })).ok, true);
});

test("clampNextWake：45–90 分钟", () => {
  assert.deepEqual(clampNextWake({ min_minutes: 10, max_minutes: 200, reason: "x" }), { min: 45, max: 90, reason: "x" });
  assert.deepEqual(clampNextWake({ min_minutes: 70, max_minutes: 60 }), { min: 70, max: 70, reason: "" });
});

test("runtime：事件租约 → 成功 → 完成并推进", async () => {
  let t = 1000;
  const llm = scripted([good()]);
  const rt = createWakeRuntime({ llm, registry, now: () => (t += 10) });
  await rt.init();
  rt.addEvent({ id: "e1", dueAt: 0, text: "雨停了" });
  const r = await rt.run({ context: { mood: "calm" } });
  assert.equal(r.ok, true);
  assert.equal(r.seed, "world_event");
  assert.equal(r.wake.outcome, "trace");
  assert.deepEqual(r.nextWake, { min: 50, max: 80, reason: "刚醒" });
  assert.equal(rt.listEvents().length, 0);
  assert.equal(rt.residue().text, "窗还开着");
});

test("runtime：格式错误判失败并释放租约", async () => {
  let t = 1000;
  const llm = scripted(["垃圾"]);
  const rt = createWakeRuntime({ llm, registry, now: () => (t += 10) });
  await rt.init();
  rt.addEvent({ id: "e1", dueAt: 0, text: "x" });
  const r = await rt.run();
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_object");
  const ev = rt.listEvents()[0];
  assert.equal(ev.leaseUntil, 0);
});

test("runtime：message 缺 share / artifact 无证据都失败", async () => {
  const rt = createWakeRuntime({ llm: scripted([good({ outcome: "message", share: "" })]), registry });
  await rt.init();
  assert.equal((await rt.run()).reason, "message_without_share");

  const rt2 = createWakeRuntime({ llm: scripted([good({ artifact: { id: "a1" } })]), registry });
  await rt2.init();
  assert.equal((await rt2.run()).reason, "artifact_without_evidence");
});

test("runtime：线头上限 5", async () => {
  const rt = createWakeRuntime({ llm: scripted([good({ thread: "新线头" })]), registry });
  await rt.init();
  for (let i = 0; i < 5; i++) assert.equal(rt.addThread({ text: `线头${i}` }).ok, true);
  assert.equal(rt.addThread({ text: "第六条" }).reason, "thread_cap");
  const r = await rt.run();
  assert.equal(r.reason, "thread_cap");
});

test("runtime：并发只允许一个醒来", async () => {
  let release;
  const slow = {
    complete: () =>
      new Promise((resolve) => {
        release = () => resolve({ text: good() });
      }),
  };
  const rt = createWakeRuntime({ llm: slow, registry });
  await rt.init();
  const first = rt.run();
  await new Promise((r) => setTimeout(r, 10));
  const second = await rt.run();
  assert.equal(second.reason, "wake_locked");
  release();
  assert.equal((await first).ok, true);
});
