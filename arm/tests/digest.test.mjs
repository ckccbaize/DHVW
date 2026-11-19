import test from "node:test";
import assert from "node:assert/strict";

import { buildDigest, createDigestStore } from "../www/js/core/digest.js";
import { createMemoryKvBackend } from "../www/js/core/kv.js";

test("buildDigest：字段齐全且可 JSON 化", () => {
  const d = buildDigest({
    now: 123,
    seq: 9,
    clock: { day: "2026-11-13", minute: 480, phase: "morning" },
    world: { display: "overview", conn: "up", tier: "idle" },
    life: { minute: 480, mood: { valence: 0.5 } },
    agenda: [{ id: "a1", kind: "plot", status: "done" }],
    sceneRequests: [{ id: "s1", mapSpec: { kind: "street" }, status: "pending" }],
    pcActions: [{ id: "p1", action: "map.generate", status: "queued" }],
    recentEvents: [{ seq: 9, kind: "plot:generated" }],
  });
  assert.equal(d.v, 1);
  assert.equal(d.ts, 123);
  assert.equal(d.seq, 9);
  assert.equal(d.agenda.length, 1);
  assert.equal(d.sceneRequests[0].status, "pending");
  assert.equal(d.pcActions[0].action, "map.generate");
  assert.equal(JSON.parse(JSON.stringify(d)).clock.day, "2026-11-13");
});

test("createDigestStore：落 kv 并 POST 到壳", async () => {
  const backend = createMemoryKvBackend();
  const calls = [];
  const store = createDigestStore({
    backend,
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
      return { ok: true };
    },
    now: () => 555,
  });
  const d = buildDigest({ now: 1, agenda: [{ id: "a" }] });
  await store.save(d);
  assert.equal((await backend.get("digest")).agenda.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/__digest");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].body.agenda[0].id, "a");
  assert.equal(store.lastSavedAt, 555);
});

test("createDigestStore：壳不可用不抛错", async () => {
  const backend = createMemoryKvBackend();
  const store = createDigestStore({
    backend,
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  const d = await store.save(buildDigest({ now: 2 }));
  assert.equal(d.ts, 2);
  assert.equal((await backend.get("digest")).ts, 2);
});
