import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanupTombstones,
  DEFAULT_OWNERSHIP,
  mergeBatch,
  mergeRecord,
} from "../www/js/core/sync/merge.js";

const rec = (over = {}) => ({
  id: "r1",
  updated_at: 100,
  origin: "device",
  fields: { valence: 0.5, text: "a" },
  ...over,
});

test("insert / 幂等", () => {
  const a = mergeRecord(null, rec());
  assert.equal(a.decision, "insert");
  const b = mergeRecord(a.record, rec());
  assert.equal(b.changed, false);
  assert.equal(b.decision, "unchanged");
});

test("LWW：updated_at 大者胜；同时间 pc 优先", () => {
  const local = rec({ updated_at: 100, origin: "device", fields: { text: "old" } });
  const inc = rec({ updated_at: 200, origin: "pc", fields: { text: "new" } });
  assert.equal(mergeRecord(local, inc).record.fields.text, "new");

  const tie = mergeRecord(
    rec({ updated_at: 100, origin: "device", fields: { text: "device" } }),
    rec({ updated_at: 100, origin: "pc", fields: { text: "pc" } }),
  );
  assert.equal(tie.record.fields.text, "pc");
});

test("字段所有权：mood 归设备，pc 更新也不覆盖", () => {
  const local = rec({ updated_at: 100, origin: "device", fields: { mood: 0.2 } });
  const inc = rec({ updated_at: 999, origin: "pc", fields: { mood: 0.9 } });
  const r = mergeRecord(local, inc);
  assert.equal(r.record.fields.mood, 0.2);
  assert.equal(DEFAULT_OWNERSHIP.mood, "device");
});

test("tombstone：新删除胜出，旧删除不覆盖新更新", () => {
  const local = rec({ updated_at: 100 });
  const del = rec({ updated_at: 200, deleted: true, deleted_at: 200, fields: {} });
  const r = mergeRecord(local, del);
  assert.equal(r.record.deleted, true);
  assert.equal(r.decision, "deleted");

  const oldDel = rec({ updated_at: 50, deleted: true, deleted_at: 50, fields: {} });
  const newer = rec({ updated_at: 300, fields: { text: "new" } });
  const r2 = mergeRecord(oldDel, newer);
  assert.equal(r2.record.deleted, false);
  assert.equal(r2.decision, "resurrected");
});

test("mergeBatch：批量与 map 更新", () => {
  const map = new Map();
  const out = mergeBatch(map, [rec({ id: "a" }), rec({ id: "b", fields: { text: "b" } })]);
  assert.equal(out.length, 2);
  assert.equal(map.size, 2);
  assert.equal(map.get("a").fields.text, "a");
});

test("cleanupTombstones：30 天清理", () => {
  const now = 100 * 24 * 3600_000;
  const rows = [
    { id: "a", deleted: true, deleted_at: now - 31 * 24 * 3600_000 },
    { id: "b", deleted: true, deleted_at: now - 10 * 24 * 3600_000 },
    { id: "c", deleted: false },
  ];
  assert.deepEqual(cleanupTombstones(rows, { now }).map((r) => r.id), ["b", "c"]);
});
