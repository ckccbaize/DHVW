import test from "node:test";
import assert from "node:assert/strict";

import { createEventLog, createMemoryBackend, DEFAULT_CAP } from "../www/js/core/log/events.js";

const make = (opts = {}) => createEventLog({ backend: createMemoryBackend(), ...opts });

test("append：seq 单调递增、计数正确", async () => {
  const log = make();
  const a = await log.append({ kind: "wake" });
  const b = await log.append({ kind: "move", payload: { x: 1 } });
  assert.equal(a.duplicate, false);
  assert.equal(a.record.seq, 1);
  assert.equal(b.record.seq, 2);
  assert.equal(await log.count(), 2);
  assert.equal(log.lastSeq, 2);
  assert.equal(log.stats.count, 2);
});

test("append：uuid 幂等，重复不占 seq", async () => {
  const log = make();
  await log.append({ kind: "a", uuid: "u1" });
  const dup = await log.append({ kind: "a", uuid: "u1" });
  assert.equal(dup.duplicate, true);
  assert.equal(await log.count(), 1);
  assert.equal(log.lastSeq, 1);
});

test("append：缺少 kind 抛错", async () => {
  const log = make();
  await assert.rejects(log.append({}), /kind/);
});

test("环形上限：超出删最旧并计数 dropped", async () => {
  const log = make({ cap: 3 });
  for (let i = 0; i < 5; i++) await log.append({ kind: "tick", payload: { i } });
  assert.equal(await log.count(), 3);
  assert.equal(log.stats.dropped, 2);
  const latest = await log.latest(3);
  assert.deepEqual(latest.map((r) => r.seq), [5, 4, 3]);
  const oldest = await log.oldest(1);
  assert.equal(oldest[0].seq, 3);
});

test("latest / oldest / since", async () => {
  const log = make();
  for (let i = 0; i < 5; i++) await log.append({ kind: "e", payload: { i } });
  assert.deepEqual((await log.latest(2)).map((r) => r.seq), [5, 4]);
  assert.deepEqual((await log.oldest(2)).map((r) => r.seq), [1, 2]);
  assert.deepEqual((await log.since(2, 10)).map((r) => r.seq), [3, 4, 5]);
  assert.deepEqual((await log.since(5, 10)).map((r) => r.seq), []);
});

test("重启：同一后端重新 init，seq 连续", async () => {
  const backend = createMemoryBackend();
  const a = createEventLog({ backend });
  await a.append({ kind: "x" });
  await a.append({ kind: "y" });

  const b = createEventLog({ backend });
  await b.init();
  assert.equal(b.lastSeq, 2);
  const r = await b.append({ kind: "z" });
  assert.equal(r.record.seq, 3);
});

test("t_corrected 保留，src 默认 device", async () => {
  const log = make();
  const { record } = await log.append({ kind: "e", t_local: 1000, t_corrected: 6000 });
  assert.equal(record.t_local, 1000);
  assert.equal(record.t_corrected, 6000);
  assert.equal(record.src, "device");
});

test("clear：清空并重置 seq", async () => {
  const log = make();
  await log.append({ kind: "a" });
  await log.clear();
  assert.equal(await log.count(), 0);
  assert.equal(log.lastSeq, 0);
  const r = await log.append({ kind: "b" });
  assert.equal(r.record.seq, 1);
});

test("默认上限 2000", () => {
  assert.equal(DEFAULT_CAP, 2000);
});
