import test from "node:test";
import assert from "node:assert/strict";

import { normalizePresentUrl, probePresent } from "../www/js/view/present-host.js";

test("normalizePresentUrl：协议与尾斜杠", () => {
  assert.equal(normalizePresentUrl("https://pc.local:8443/present/"), "https://pc.local:8443/present");
  assert.equal(normalizePresentUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(normalizePresentUrl("ftp://x"), null);
  assert.equal(normalizePresentUrl("not a url"), null);
  assert.equal(normalizePresentUrl(""), null);
});

test("probePresent：成功/非 2xx/不可达/超时", async () => {
  const ok = await probePresent("https://pc.local/present", {
    fetchImpl: async (url) => ({ ok: url.endsWith("/health"), status: 200 }),
  });
  assert.equal(ok.ok, true);

  const bad = await probePresent("https://pc.local/present", {
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 503);

  const down = await probePresent("https://pc.local/present", {
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(down.reason, "unreachable");

  const slow = await probePresent("https://pc.local/present", {
    timeoutMs: 20,
    fetchImpl: (url, opts) =>
      new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  });
  assert.equal(slow.reason, "timeout");
});

test("probePresent：非法 URL 不发请求", async () => {
  let called = false;
  const r = await probePresent("file:///etc/passwd", {
    fetchImpl: async () => {
      called = true;
      return { ok: true };
    },
  });
  assert.equal(r.reason, "bad_url");
  assert.equal(called, false);
});
