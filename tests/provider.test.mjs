import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PROVIDER,
  normalizeProvider,
  maskKey,
  isConfigured,
  createProviderStore,
} from "../www/js/core/llm/provider.js";
import { createMemoryKvBackend } from "../www/js/core/kv.js";

test("normalizeProvider：URL 规整、非法拒绝、数值截断", () => {
  const p = normalizeProvider({ baseUrl: "https://api.x.com/v1/", model: "m" });
  assert.equal(p.baseUrl, "https://api.x.com/v1");
  assert.equal(p.model, "m");
  assert.throws(() => normalizeProvider({ baseUrl: "ftp://x" }), /http/);
  const q = normalizeProvider({ timeoutMs: 1, maxAttempts: 99, retryBaseMs: 1 });
  assert.equal(q.timeoutMs, 1000);
  assert.equal(q.maxAttempts, 5);
  assert.equal(q.retryBaseMs, 100);
  assert.equal(normalizeProvider({}).model, DEFAULT_PROVIDER.model);
  assert.equal(normalizeProvider({}).useProxy, true);
  assert.equal(normalizeProvider({ useProxy: false }).useProxy, false);
});

test("maskKey / isConfigured", () => {
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("short"), "***");
  assert.equal(maskKey("sk-1234567890abcd"), "sk-***abcd");
  assert.equal(isConfigured({ baseUrl: "https://x", model: "m" }), true);
  assert.equal(isConfigured({ baseUrl: "", model: "m" }), false);
});

test("ProviderStore：持久化与重启恢复", async () => {
  const backend = createMemoryKvBackend();
  const s1 = createProviderStore({ backend });
  await s1.init();
  assert.equal(s1.get().baseUrl, "");
  await s1.set({ baseUrl: "https://api.x.com/v1", apiKey: "sk-abcdefgh", model: "m1" });
  assert.equal(s1.get().model, "m1");

  const s2 = createProviderStore({ backend });
  await s2.init();
  assert.equal(s2.get().baseUrl, "https://api.x.com/v1");
  assert.equal(s2.get().apiKey, "sk-abcdefgh");
  assert.equal(s2.masked.apiKey, "sk-***efgh");

  await s2.clear();
  assert.equal(s2.get().baseUrl, "");
});

test("ProviderStore：坏配置回退默认", async () => {
  const backend = createMemoryKvBackend();
  await backend.put("llm_provider", { baseUrl: "ftp://bad", model: "m" });
  const s = createProviderStore({ backend });
  await s.init();
  assert.equal(s.get().baseUrl, "");
});
