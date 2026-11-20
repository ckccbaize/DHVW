import test from "node:test";
import assert from "node:assert/strict";

import {
  createBrowsePlanner,
  pickSearchCandidates,
  searchBing,
  validateBrowseTarget,
  validatePublicUrl,
} from "../www/js/core/actions/browse.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

const registry = createRegistryFromData({
  version: 1,
  skills: {
    "browse-plan": {
      name: "browse-plan",
      description: "浏览目标",
      class: "work",
      prompt: "browse-plan",
      maxTokens: 300,
      temperature: 0.8,
      tools: [],
      output: "json",
      body: "",
    },
  },
  prompts: { "browse-plan": "{{threads}} {{recent}} {{mood}}" },
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

test("validateBrowseTarget：只接受搜索词", () => {
  assert.equal(validateBrowseTarget({ query: "北京 明天 天气" }), null);
  assert.equal(validateBrowseTarget({ query: "" }), "bad_query");
  assert.equal(validateBrowseTarget({ query: "x".repeat(81) }), "bad_query");
  assert.equal(validateBrowseTarget({}), "bad_query");
  assert.equal(validateBrowseTarget(null), "not_object");
  // 目标必须由搜索产生：直接给页面地址或主题都被拒
  assert.equal(validateBrowseTarget({ url: "https://www.weather.com.cn/weather/101010100.shtml" }), "not_search");
  assert.equal(validateBrowseTarget({ topic: "秋天 落叶" }), "not_search");
  assert.equal(validateBrowseTarget({ query: "秋季 落叶 公园", url: "https://cn.bing.com/x" }), "not_search");
});

test("validatePublicUrl：拒绝内网与凭据", () => {
  assert.equal(validatePublicUrl("https://example.com/a"), null);
  assert.equal(validatePublicUrl("http://127.0.0.1/a"), "private_host");
  assert.equal(validatePublicUrl("http://192.168.1.2/x"), "private_host");
  assert.equal(validatePublicUrl("http://169.254.169.254/latest"), "private_host");
  assert.equal(validatePublicUrl("ftp://example.com/x"), "bad_scheme");
  assert.equal(validatePublicUrl("https://user:pass@example.com/x"), "has_credentials");
});

test("searchBing：走 /__search 并返回结果", async () => {
  const seen = [];
  const r = await searchBing("北京 天气", {
    n: 3,
    fetchImpl: async (url) => {
      seen.push(url);
      return { ok: true, json: async () => ({ results: [{ url: "https://example.com/a", title: "天气" }] }) };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.match(seen[0], /^\/__search\?q=%E5%8C%97%E4%BA%AC%20%E5%A4%A9%E6%B0%94&n=3$/);
});

test("planner：合法搜索词", async () => {
  const llm = scripted([JSON.stringify({ query: "北京 明天 天气", reason: "想知道要不要带伞" })]);
  const p = createBrowsePlanner({ llm, registry, now: () => 1 });
  const r = await p.plan({ threads: ["想看天气"], mood: { focus: 0.6 } });
  assert.equal(r.ok, true);
  assert.equal(r.query, "北京 明天 天气");
  assert.equal(r.reason, "想知道要不要带伞");
  assert.equal(r.ts, 1);
  assert.equal(llm.calls[0].json, true);
  assert.equal(llm.calls[0].maxTokens, 300);
});

test("planner：直接给 URL 或主题一律拒绝", async () => {
  const byUrl = createBrowsePlanner({
    llm: scripted([JSON.stringify({ url: "https://www.weather.com.cn/weather/101010100.shtml" })]),
    registry,
  });
  assert.equal((await byUrl.plan()).reason, "not_search");

  const byTopic = createBrowsePlanner({
    llm: scripted([JSON.stringify({ topic: "秋天 落叶", reason: "想看看" })]),
    registry,
  });
  assert.equal((await byTopic.plan()).reason, "not_search");
});

test("planner：坏 JSON / LLM 失败", async () => {
  const badJson = createBrowsePlanner({ llm: scripted(["nope"]), registry });
  assert.equal((await badJson.plan()).reason, "invalid_json");

  const fail = createBrowsePlanner({ llm: scripted([new Error("net")]), registry });
  assert.equal((await fail.plan()).reason, "llm_failed");
});

test("planner：prompt 不再暴露域名白名单", async () => {
  const llm = scripted([JSON.stringify({ query: "秋季 落叶" })]);
  const p = createBrowsePlanner({ llm, registry });
  await p.plan({ threads: ["秋天"], mood: {} });
  const text = llm.calls[0].messages[0].content;
  assert.ok(!/weather\.com\.cn|cn\.bing\.com|zh\.wikipedia\.org/.test(text));
});

test("pickSearchCandidates：过滤内网；全看过时复用而不是空", () => {
  const mixed = [
    { url: "http://10.0.0.1/x", title: "内网" },
    { url: "https://ok.example.com/a", title: "可用" },
  ];
  assert.deepEqual(pickSearchCandidates(mixed, { random: () => 0 }).map((r) => r.title), ["可用"]);
  const all = [{ url: "https://ok.example.com/a", title: "可用" }];
  assert.deepEqual(
    pickSearchCandidates(all, { recent: [{ url: "https://ok.example.com/a", topic: "可用" }], random: () => 0 }).map((r) => r.title),
    ["可用"],
  );
  assert.deepEqual(pickSearchCandidates([{ url: "http://127.0.0.1/x", title: "x" }]), []);
  assert.deepEqual(pickSearchCandidates([]), []);
  assert.deepEqual(pickSearchCandidates(null), []);
});

test("pickSearchCandidates：随机起点轮转，保留后备", () => {
  const results = [
    { url: "https://a.example.com/1", title: "A1" },
    { url: "https://b.example.com/2", title: "B2" },
    { url: "https://c.example.com/3", title: "C3" },
  ];
  assert.deepEqual(
    pickSearchCandidates(results, { random: () => 0 }).map((r) => r.title),
    ["A1", "B2", "C3"],
  );
  assert.deepEqual(
    pickSearchCandidates(results, { random: () => 0.5 }).map((r) => r.title),
    ["B2", "C3", "A1"],
  );
  assert.deepEqual(
    pickSearchCandidates(results, { random: () => 0.99 }).map((r) => r.title),
    ["C3", "A1", "B2"],
  );
  // 看过 A 后从剩余的随机起点开始，A 不再出现在前面
  assert.deepEqual(
    pickSearchCandidates(results, { recent: [{ url: "https://a.example.com/1", topic: "A1" }], random: () => 0 }).map((r) => r.title),
    ["B2", "C3"],
  );
  assert.deepEqual(pickSearchCandidates(results, { limit: 2, random: () => 0 }).map((r) => r.title), ["A1", "B2"]);
});
