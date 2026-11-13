import test from "node:test";
import assert from "node:assert/strict";

import { createSyncManager, mergeFacts } from "../www/js/core/sync.js";
import { createMemoryKvBackend } from "../www/js/core/kv.js";

function fakeLog(rows) {
  return {
    async since(seq, limit = 200) {
      return rows.filter((r) => r.seq > seq).slice(0, limit);
    },
  };
}

const rows = Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, uuid: `u${i + 1}`, kind: "k" }));

test("flush：发送未确认事件，ack 后推进", async () => {
  const sent = [];
  let t = 1000;
  const sync = createSyncManager({
    eventLog: fakeLog(rows),
    send: (m) => {
      sent.push(m);
      return true;
    },
    backend: createMemoryKvBackend(),
    now: () => t,
  });
  await sync.init();
  assert.equal(await sync.flush(), 5);
  assert.equal(sent[0].type, "events:batch");
  assert.equal(sent[0].payload.events.length, 5);
  assert.equal(sync.ackedSeq, 0);

  sync.onAck({ seq: 3 });
  assert.equal(sync.ackedSeq, 3);
  assert.equal(await sync.flush(), 2);
  assert.deepEqual(sent[1].payload.events.map((e) => e.seq), [4, 5]);
});

test("flush：超时重发、未连接不排队", async () => {
  const sent = [];
  let t = 1000;
  let online = true;
  const sync = createSyncManager({
    eventLog: fakeLog(rows),
    send: (m) => {
      if (!online) return false;
      sent.push(m);
      return true;
    },
    now: () => t,
    ackTimeoutMs: 5000,
  });
  await sync.init();
  assert.equal(await sync.flush(), 5);
  assert.equal(await sync.flush(), 0); // 未超时
  t += 6000;
  assert.equal(await sync.flush(), 5); // 重发
  assert.equal(sync.stats.retries, 1);
  assert.equal(sent.length, 2);

  const offline = createSyncManager({ eventLog: fakeLog(rows), send: () => false });
  await offline.init();
  assert.equal(await offline.flush(), 0);
  assert.equal(offline.stats.lastError, "not_routed");
});

test("ack：旧 seq 忽略", async () => {
  const sync = createSyncManager({ eventLog: fakeLog(rows), send: () => true });
  await sync.init();
  sync.onAck({ seq: 4 });
  assert.equal(sync.onAck({ seq: 2 }), false);
  assert.equal(sync.ackedSeq, 4);
});

test("持久化：重启恢复 ackedSeq", async () => {
  const backend = createMemoryKvBackend();
  const a = createSyncManager({ eventLog: fakeLog(rows), send: () => true, backend });
  await a.init();
  a.onAck({ seq: 3 });
  await new Promise((r) => setTimeout(r, 5));
  const b = createSyncManager({ eventLog: fakeLog(rows), send: () => true, backend });
  await b.init();
  assert.equal(b.ackedSeq, 3);
});

test("mergeFacts：按 id 去重、拒绝空事实", () => {
  const seen = new Set(["f1"]);
  const r = mergeFacts(
    [
      { id: "f1", text: "旧" },
      { id: "f2", text: "新事实" },
      { id: "", text: "x" },
      { id: "f3", text: "" },
      null,
    ],
    { seen, now: () => 1 },
  );
  assert.deepEqual(r.accepted.map((f) => f.id), ["f2"]);
  assert.deepEqual(r.merged, ["f1"]);
  assert.equal(r.rejected.length, 3);
  assert.equal(r.accepted[0].t, 1);
});
