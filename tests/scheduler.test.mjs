import test from "node:test";
import assert from "node:assert/strict";

import { createScheduler, createMemoryJobBackend } from "../www/js/core/sched/scheduler.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("优先级：数字小的先跑", async () => {
  const order = [];
  const s = createScheduler({ backend: createMemoryJobBackend() });
  s.setActivity("idle");
  s.register("t", async (payload) => {
    order.push(payload.n);
  });
  s.enqueue({ kind: "t", priority: 5, payload: { n: 5 } });
  s.enqueue({ kind: "t", priority: 1, payload: { n: 1 } });
  s.enqueue({ kind: "t", priority: 3, payload: { n: 3 } });
  await s.whenIdle();
  assert.deepEqual(order, [1, 3, 5]);
  assert.equal(s.stats.done, 3);
});

test("活跃期不跑；转 idle 后开始", async () => {
  let ran = 0;
  const s = createScheduler({ backend: createMemoryJobBackend() });
  s.register("t", async () => {
    ran += 1;
  });
  s.enqueue({ kind: "t", priority: 1 });
  await s.whenIdle();
  assert.equal(ran, 0);
  assert.equal(s.queue.length, 1);

  s.setActivity("idle");
  await s.whenIdle();
  assert.equal(ran, 1);
  assert.equal(s.queue.length, 0);
});

test("present / safeMode / pause 都会阻塞", async () => {
  let ran = 0;
  const s = createScheduler({ backend: createMemoryJobBackend() });
  s.register("t", async () => {
    ran += 1;
  });
  s.setActivity("idle");
  s.setPresent(true);
  s.enqueue({ kind: "t" });
  await s.whenIdle();
  assert.equal(ran, 0);

  s.setPresent(false);
  s.setSafeMode(true);
  await s.whenIdle();
  assert.equal(ran, 0);

  s.setSafeMode(false);
  s.pause();
  await s.whenIdle();
  assert.equal(ran, 0);

  s.resume();
  await s.whenIdle();
  assert.equal(ran, 1);
});

test("切片让位：超时抛 yield，任务重新排队并最终完成", async () => {
  let calls = 0;
  const s = createScheduler({ backend: createMemoryJobBackend(), maxSliceMs: 5 });
  s.setActivity("idle");
  s.register("slow", async (payload, { shouldYield }) => {
    calls += 1;
    for (;;) {
      if (payload.done >= 3) return "ok";
      if (shouldYield()) throw Object.assign(new Error("yield"), { code: "yield" });
      await sleep(6);
      payload.done += 1;
    }
  });
  s.enqueue({ kind: "slow", priority: 1, payload: { done: 0 } });
  await s.whenIdle();
  assert.ok(calls >= 3, `calls=${calls}`);
  assert.equal(s.stats.done, 1);
  assert.equal(s.queue.length, 0);
});

test("失败：标记 failed 并出队", async () => {
  const s = createScheduler({ backend: createMemoryJobBackend() });
  s.setActivity("idle");
  s.register("bad", async () => {
    throw new Error("boom");
  });
  s.enqueue({ kind: "bad" });
  await s.whenIdle();
  assert.equal(s.stats.failed, 1);
  assert.equal(s.queue.length, 0);
});

test("缺少 runner 也算失败", async () => {
  const s = createScheduler({ backend: createMemoryJobBackend() });
  s.setActivity("idle");
  s.enqueue({ kind: "nope" });
  await s.whenIdle();
  assert.equal(s.stats.failed, 1);
});

test("cancel：从队列移除", async () => {
  const s = createScheduler({ backend: createMemoryJobBackend() });
  const job = s.enqueue({ kind: "t" });
  assert.equal(s.cancel(job.id), true);
  assert.equal(s.queue.length, 0);
  assert.equal(s.cancel(job.id), false);
});

test("持久化：重启后恢复 queued，running 标为 interrupted", async () => {
  const backend = createMemoryJobBackend();
  const s1 = createScheduler({ backend });
  s1.pause();
  s1.enqueue({ kind: "t", priority: 2, payload: { a: 1 } });
  await sleep(5);

  const s2 = createScheduler({ backend });
  const n = await s2.init();
  assert.equal(n, 1);
  assert.equal(s2.queue[0].kind, "t");

  await backend.put({
    id: "j-run",
    kind: "t",
    priority: 1,
    payload: {},
    status: "running",
    createdAt: 1,
  });
  const s3 = createScheduler({ backend });
  await s3.init();
  assert.equal(s3.stats.interrupted, 1);
  assert.equal(s3.queue.length, 1); // 只剩 queued 那条
});
