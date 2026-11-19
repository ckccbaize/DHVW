import test from "node:test";
import assert from "node:assert/strict";

import { createRemoteMemory } from "../www/js/core/memory/remote.js";

test("query：发送 req_id/text/k，handle 结算", async () => {
  const sent = [];
  const mem = createRemoteMemory({ send: (m) => (sent.push(m), true), timeoutMs: 50 });
  const p = mem.query("京都枫叶", 3);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "memory:query");
  assert.ok(sent[0].payload.req_id);
  assert.equal(sent[0].payload.text, "京都枫叶");
  assert.equal(sent[0].payload.k, 3);

  const ok = mem.handle({ req_id: sent[0].payload.req_id, hits: [{ id: "pc-1" }], semantic: true });
  assert.equal(ok, true);
  const res = await p;
  assert.equal(res.semantic, true);
  assert.equal(res.hits[0].id, "pc-1");
  assert.equal(mem.stats.ok, 1);
});

test("query：超时拒绝，晚到的结果被忽略", async () => {
  let reqId = null;
  const mem = createRemoteMemory({
    send: (m) => {
      reqId = m.payload.req_id;
      return true;
    },
    timeoutMs: 10,
  });
  const p = mem.query("x", 1);
  await assert.rejects(p, (e) => e.code === "timeout");
  assert.equal(mem.stats.timeouts, 1);
  assert.equal(mem.handle({ req_id: reqId, hits: [] }), false);
});

test("query：主机未连接时立即拒绝", async () => {
  const mem = createRemoteMemory({ send: () => false, timeoutMs: 50 });
  await assert.rejects(mem.query("x", 1), (e) => e.code === "not_routed");
  assert.equal(mem.stats.failed, 1);
  assert.equal(mem.pending, 0);
});

test("handle：无 req_id 或未知 req_id 返回 false", () => {
  const mem = createRemoteMemory({ send: () => true });
  assert.equal(mem.handle(null), false);
  assert.equal(mem.handle({}), false);
  assert.equal(mem.handle({ req_id: "nope" }), false);
});

test("并发请求互不干扰", async () => {
  const sent = [];
  const mem = createRemoteMemory({ send: (m) => (sent.push(m), true), timeoutMs: 50 });
  const p1 = mem.query("a");
  const p2 = mem.query("b");
  assert.equal(mem.pending, 2);
  mem.handle({ req_id: sent[1].payload.req_id, hits: [{ id: "b" }], semantic: true });
  mem.handle({ req_id: sent[0].payload.req_id, hits: [{ id: "a" }], semantic: true });
  assert.equal((await p1).hits[0].id, "a");
  assert.equal((await p2).hits[0].id, "b");
  assert.equal(mem.pending, 0);
});
