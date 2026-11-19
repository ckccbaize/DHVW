import test from "node:test";
import assert from "node:assert/strict";

import {
  createBrowsePlanner,
  DEFAULT_HOSTS,
  pickSearchResult,
  targetUrl,
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
  prompts: { "browse-plan": "{{threads}} {{recent}} {{mood}} {{hosts}}" },
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

test("validateBrowseTarget：URL 安全与白名单", () => {
  assert.equal(validateBrowseTarget({ url: "https://www.weather.com.cn/weather/101010100.shtml" }), null);
  assert.equal(validateBrowseTarget({ url: "https://cn.bing.com/search?q=x" }), null);
  assert.equal(validateBrowseTarget({ url: "http://127.0.0.1/x" }), "private_host");
  assert.equal(validateBrowseTarget({ url: "http://192.168.1.2/x" }), "private_host");
  assert.equal(validateBrowseTarget({ url: "http://169.254.169.254/latest" }), "private_host");
  assert.equal(validateBrowseTarget({ url: "https://evil.example.com/x" }), "host_not_allowed");
  assert.equal(validateBrowseTarget({ url: "ftp://weather.com.cn/x" }), "bad_scheme");
  assert.equal(validateBrowseTarget({ url: "https://user:pass@weather.com.cn/x" }), "has_credentials");
  assert.equal(validateBrowseTarget({ topic: "北京天气" }), null);
  assert.equal(validateBrowseTarget({ topic: "" }), "bad_topic");
});

test("validateBrowseTarget：query 自由搜索", () => {
  assert.equal(validateBrowseTarget({ query: "北京 明天 天气" }), null);
  assert.equal(validateBrowseTarget({ query: "" }), "bad_query");
  assert.equal(validateBrowseTarget({ query: "x".repeat(81) }), "bad_query");
});

test("validatePublicUrl / pickSearchResult", () => {
  assert.equal(validatePublicUrl("https://example.com/a"), null);
  assert.equal(validatePublicUrl("http://127.0.0.1/a"), "private_host");
  const picked = pickSearchResult([
    { url: "http://10.0.0.1/x", title: "内网" },
    { url: "https://example.com/ok", title: "可用" },
  ]);
  assert.equal(picked.url, "https://example.com/ok");
});

test("targetUrl：无 url 时拼 Bing 搜索", () => {
  assert.equal(targetUrl({ topic: "北京 天气" }), "https://cn.bing.com/search?q=%E5%8C%97%E4%BA%AC%20%E5%A4%A9%E6%B0%94");
  assert.equal(targetUrl({ url: "https://cn.bing.com/x" }), "https://cn.bing.com/x");
});

test("planner：合法目标", async () => {
  const llm = scripted([
    JSON.stringify({ topic: "北京天气", url: "https://www.weather.com.cn/weather/101010100.shtml", reason: "想知道要不要带伞" }),
  ]);
  const p = createBrowsePlanner({ llm, registry, now: () => 1 });
  const r = await p.plan({ threads: ["想看天气"], mood: { focus: 0.6 } });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://www.weather.com.cn/weather/101010100.shtml");
  assert.equal(r.reason, "想知道要不要带伞");
  assert.equal(llm.calls[0].json, true);
});

test("planner：非法域名/坏 JSON/LLM 失败", async () => {
  const badHost = createBrowsePlanner({
    llm: scripted([JSON.stringify({ url: "https://evil.example.com/x" })]),
    registry,
  });
  assert.equal((await badHost.plan()).reason, "host_not_allowed");

  const badJson = createBrowsePlanner({ llm: scripted(["nope"]), registry });
  assert.equal((await badJson.plan()).reason, "invalid_json");

  const fail = createBrowsePlanner({ llm: scripted([new Error("net")]), registry });
  assert.equal((await fail.plan()).reason, "llm_failed");
});

test("planner：query 模式交给搜索", async () => {
  const p = createBrowsePlanner({
    llm: scripted([JSON.stringify({ query: "北京 明天 天气", reason: "想知道带不带伞" })]),
    registry,
  });
  const r = await p.plan();
  assert.equal(r.ok, true);
  assert.equal(r.mode, "search");
  assert.equal(r.query, "北京 明天 天气");
});

test("planner：只给主题时生成搜索 URL", async () => {
  const p = createBrowsePlanner({
    llm: scripted([JSON.stringify({ topic: "秋天 落叶", reason: "想看看" })]),
    registry,
  });
  const r = await p.plan();
  assert.equal(r.ok, true);
  assert.match(r.url, /^https:\/\/cn\.bing\.com\/search\?q=/);
});

test("DEFAULT_HOSTS 不含内网", () => {
  for (const h of DEFAULT_HOSTS) assert.ok(!h.includes("127.") && !h.includes("192.168."));
});
