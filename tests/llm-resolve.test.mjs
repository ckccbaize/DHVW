import assert from "node:assert/strict";
import test from "node:test";
import { resolveRemoteLlmConfig } from "../www/js/core/llm/resolve.js";

test("api mode keeps cloud endpoint and disables shell proxy flag", () => {
  const out = resolveRemoteLlmConfig(
    {
      mode: "api",
      baseUrl: "https://codex.mintcat.work",
      apiKey: "sk-real",
      model: "gpt-4o-mini",
    },
    "wss://192.168.1.10:8443/ws/orchestrator?token=gw-tok-123",
  );
  assert.equal(out.mode, "api");
  assert.equal(out.baseUrl, "https://codex.mintcat.work/v1");
  assert.equal(out.apiKey, "sk-real");
  assert.equal(out.useShellProxy, false);
});

test("local mode over paired wss gateway rewrites loopback baseUrl to gateway /llm/v1", () => {
  const out = resolveRemoteLlmConfig(
    {
      mode: "local",
      baseUrl: "http://127.0.0.1:8089",
      apiKey: "local-llama",
      model: "nemotron-3.5-bolt-e4b",
    },
    "wss://192.168.1.10:8443/ws/orchestrator?token=gw-tok-123",
  );
  assert.equal(out.mode, "local");
  assert.equal(out.baseUrl, "https://192.168.1.10:8443/llm/v1");
  assert.equal(out.apiKey, "gw-tok-123");
  assert.equal(out.reasoningEffort, false);
  assert.equal(out.useShellProxy, true);
});

test("local mode over direct LAN ws orchestrator uses /dhvw/llm/v1 relay", () => {
  const out = resolveRemoteLlmConfig(
    {
      mode: "local",
      baseUrl: "http://127.0.0.1:8089/v1",
      model: "nemotron-3.5-bolt-e4b",
      localProxyPath: "/dhvw/llm/v1",
    },
    "ws://192.168.1.10:8877/dhvw",
  );
  assert.equal(out.mode, "local");
  assert.equal(out.baseUrl, "http://192.168.1.10:8877/dhvw/llm/v1");
  assert.equal(out.apiKey, "local-llama");
  assert.equal(out.reasoningEffort, false);
  assert.equal(out.useShellProxy, true);
});
