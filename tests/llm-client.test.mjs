import test from "node:test";
import assert from "node:assert/strict";

import { createLlmClient } from "../www/js/core/llm/client.js";

const provider = (over = {}) => ({
  baseUrl: "https://api.test/v1",
  apiKey: "sk-test",
  model: "m",
  timeoutMs: 1000,
  maxAttempts: 3,
  retryBaseMs: 1,
  reasoningEffort: "none",
  useProxy: false,
  ...over,
});

const okResponse = (content = "hello", usage = { prompt_tokens: 10, completion_tokens: 5 }) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ choices: [{ message: { content } }], usage, model: "m" }),
});

const errResponse = (status, body = "err") => ({
  ok: false,
  status,
  text: async () => body,
});

function clientWith(responses, over = {}) {
  let i = 0;
  const calls = [];
  const c = createLlmClient({
    getProvider: () => provider(over),
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return typeof r === "function" ? r(url, opts) : r;
    },
    sleep: async () => {},
  });
  return { c, calls };
}

test("成功：解析 content/usage，attempts=1", async () => {
  const { c, calls } = clientWith([okResponse("hi")]);
  const out = await c.complete({ messages: [{ role: "user", content: "x" }] });
  assert.equal(out.text, "hi");
  assert.equal(out.attempts, 1);
  assert.equal(out.usage.completion_tokens, 5);
  assert.equal(calls[0].url, "https://api.test/v1/chat/completions");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, "m");
  assert.equal(body.reasoning_effort, "none");
  assert.equal(c.stats.ok, 1);
});

test("429 后成功：重试一次", async () => {
  const { c } = clientWith([errResponse(429), okResponse("ok")]);
  const out = await c.complete({ messages: [] });
  assert.equal(out.attempts, 2);
  assert.equal(c.stats.retries, 1);
});

test("500 连续失败：用尽 attempts 后抛错", async () => {
  const { c, calls } = clientWith([errResponse(500)]);
  await assert.rejects(c.complete({ messages: [] }), (e) => e.code === "http_500");
  assert.equal(calls.length, 3);
  assert.equal(c.stats.failed, 1);
});

test("401 不重试", async () => {
  const { c, calls } = clientWith([errResponse(401)]);
  await assert.rejects(c.complete({ messages: [] }), (e) => e.code === "http_401");
  assert.equal(calls.length, 1);
});

test("超时：重试后抛 timeout", async () => {
  const { c } = clientWith(
    [
      (url, opts) =>
        new Promise((_, reject) => {
          opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    ],
    { timeoutMs: 10, maxAttempts: 2 },
  );
  await assert.rejects(c.complete({ messages: [] }), (e) => e.code === "timeout");
  assert.equal(c.stats.calls, 2);
});

test("坏 JSON：重试后抛 bad_json", async () => {
  const { c } = clientWith([{ ok: true, status: 200, text: async () => "not json" }], { maxAttempts: 2 });
  await assert.rejects(c.complete({ messages: [] }), (e) => e.code === "bad_json");
  assert.equal(c.stats.calls, 2);
});

test("网络错误：归一为 network 并重试", async () => {
  const { c, calls } = clientWith([
    () => Promise.reject(new TypeError("Failed to fetch")),
  ], { maxAttempts: 2 });
  await assert.rejects(c.complete({ messages: [] }), (e) => e.code === "network");
  assert.equal(calls.length, 2);
  assert.equal(c.stats.retries, 1);
});

test("未配置：直接抛 not_configured", async () => {
  const c = createLlmClient({ getProvider: () => ({ baseUrl: "", model: "" }), fetchImpl: async () => okResponse() });
  await assert.rejects(c.complete({ messages: [] }), (e) => e.code === "not_configured");
});

test("默认走本地代理：包装 baseUrl/apiKey/body", async () => {
  const { c, calls } = clientWith([okResponse("pong")], { useProxy: true });
  const out = await c.complete({ messages: [{ role: "user", content: "x" }] });
  assert.equal(out.text, "pong");
  assert.equal(calls[0].url, "/__llm/chat/completions");
  const wrapper = JSON.parse(calls[0].opts.body);
  assert.equal(wrapper.baseUrl, "https://api.test/v1");
  assert.equal(wrapper.apiKey, "sk-test");
  assert.equal(wrapper.body.model, "m");
  assert.equal(calls[0].opts.headers.Authorization, undefined);
});

test("json 模式带 response_format", async () => {
  const { c, calls } = clientWith([okResponse("{}")]);
  await c.complete({ messages: [], json: true });
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.response_format, { type: "json_object" });
});
