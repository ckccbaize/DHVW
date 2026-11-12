import test from "node:test";
import assert from "node:assert/strict";

import { PROTO, makeMsg, validateMsg, errorMsg, replyMsg, createTracker } from "../www/js/core/bus.js";
import { createCoreClient } from "../www/js/core/client.js";

class FakeWorker {
  static instances = [];
  constructor(url, opts) {
    this.url = String(url);
    this.opts = opts;
    this.posted = [];
    this.terminated = false;
    FakeWorker.instances.push(this);
  }
  postMessage(m) {
    this.posted.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  emit(msg) {
    this.onmessage && this.onmessage({ data: msg });
  }
}

test("makeMsg / validateMsg：信封合法", () => {
  const m = makeMsg("core:init", { a: 1 });
  assert.equal(m.v, PROTO);
  assert.equal(m.type, "core:init");
  assert.deepEqual(m.payload, { a: 1 });
  assert.ok(m.id);
  assert.equal(validateMsg(m).ok, true);
});

test("validateMsg：版本/字段错误", () => {
  assert.equal(validateMsg(null).code, "bad_payload");
  assert.equal(validateMsg({ ...makeMsg("x", {}), v: 99 }).code, "bad_version");
  assert.equal(validateMsg({ ...makeMsg("x", {}), id: "" }).code, "bad_payload");
  assert.equal(validateMsg({ ...makeMsg("x", {}), type: "" }).code, "bad_payload");
  assert.equal(validateMsg({ ...makeMsg("x", {}), payload: null }).code, "bad_payload");
});

test("tracker：reply 结算、error 拒绝、超时拒绝", async () => {
  const t = createTracker({ timeoutMs: 20 });
  const p = t.track("a");
  assert.equal(t.settle(replyMsg("a", { ok: true })), true);
  assert.deepEqual(await p, { ok: true });

  const p2 = t.track("b");
  t.settle(errorMsg("b", "bad_type", "nope"));
  await assert.rejects(p2, (e) => e.code === "bad_type");

  const p3 = t.track("c", { timeout: 10 });
  await assert.rejects(p3, (e) => e.code === "timeout");
  assert.equal(t.size, 0);
});

test("client：request 收到 reply 解析", async () => {
  FakeWorker.instances = [];
  const c = createCoreClient({ WorkerImpl: FakeWorker, timeoutMs: 50 });
  c.start();
  const w = FakeWorker.instances[0];
  const p = c.request("core:init", { scene: { id: "home" } });
  assert.equal(w.posted.length, 1);
  w.emit(replyMsg(w.posted[0].id, { ok: true, scene: "home" }));
  assert.deepEqual(await p, { ok: true, scene: "home" });
  c.stop();
  assert.equal(w.terminated, true);
});

test("client：error 回复 → reject(code)", async () => {
  FakeWorker.instances = [];
  const c = createCoreClient({ WorkerImpl: FakeWorker });
  c.start();
  const w = FakeWorker.instances[0];
  const p = c.request("core:nope", {});
  w.emit(errorMsg(w.posted[0].id, "bad_type", "core:nope"));
  await assert.rejects(p, (e) => e.code === "bad_type");
  c.stop();
});

test("client：推送走 onMessage，不结算请求", () => {
  FakeWorker.instances = [];
  const seen = [];
  const c = createCoreClient({ WorkerImpl: FakeWorker, onMessage: (m) => seen.push(m) });
  c.start();
  const w = FakeWorker.instances[0];
  w.emit(makeMsg("core:health", { ok: true }));
  w.emit(makeMsg("core:state", { patch: { conn: "up" } }));
  assert.equal(seen.length, 2);
  assert.equal(seen[1].payload.patch.conn, "up");
  c.stop();
});

test("client：stop 拒绝未决请求", async () => {
  FakeWorker.instances = [];
  const c = createCoreClient({ WorkerImpl: FakeWorker, timeoutMs: 1000 });
  c.start();
  const p = c.request("core:snapshot", {});
  c.stop();
  await assert.rejects(p, /stopped/);
});

test("client：未 start 时 request 拒绝", async () => {
  const c = createCoreClient({ WorkerImpl: FakeWorker });
  await assert.rejects(c.request("core:snapshot", {}), /not started/);
});
