// 并发合并（W24）：字段所有权 + LWW + tombstone + 幂等。
// 规则见 WORLD-CORE-SPEC.md §6。

export const ORIGIN_RANK = { pc: 2, device: 1 };

export const DEFAULT_OWNERSHIP = Object.freeze({
  mood: "device",
  life: "device",
  world: "device",
  scene: "pc",
  memory: "pc",
});

const norm = (r) => ({
  id: r.id,
  updated_at: Number(r.updated_at) || 0,
  origin: r.origin === "pc" ? "pc" : "device",
  deleted: !!r.deleted,
  deleted_at: Number(r.deleted_at) || 0,
  fields: { ...(r.fields || {}) },
});

function pickField(field, a, b, ownership) {
  const owner = ownership[field] || "lww";
  if (owner === "pc") return b.origin === "pc" ? b.fields[field] : a.fields[field];
  if (owner === "device") return a.origin === "device" ? a.fields[field] : b.fields[field];
  if (a.updated_at !== b.updated_at) return a.updated_at > b.updated_at ? a.fields[field] : b.fields[field];
  return (ORIGIN_RANK[a.origin] || 0) >= (ORIGIN_RANK[b.origin] || 0) ? a.fields[field] : b.fields[field];
}

export function mergeRecord(local, incoming, { ownership = DEFAULT_OWNERSHIP } = {}) {
  if (!incoming || !incoming.id) return { ok: false, reason: "missing_id" };
  const b = norm(incoming);
  if (!local) return { ok: true, record: b, changed: true, decision: "insert" };
  const a = norm(local);
  if (a.id !== b.id) return { ok: false, reason: "id_mismatch" };

  // tombstone：删除时间不早于对方更新时间则删除胜出
  if (b.deleted && (!a.deleted || b.deleted_at >= a.updated_at)) {
    if (a.deleted && a.deleted_at === b.deleted_at) {
      return { ok: true, record: a, changed: false, decision: "unchanged" };
    }
    return { ok: true, record: b, changed: true, decision: "deleted" };
  }
  if (a.deleted) {
    if (a.deleted_at > b.updated_at) return { ok: true, record: a, changed: false, decision: "tombstone_wins" };
    // 对方更新晚于删除：复活
  }

  const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
  const fields = {};
  const decisions = {};
  let changed = false;
  for (const k of keys) {
    const v = pickField(k, a, b, ownership);
    fields[k] = v;
    decisions[k] = v === a.fields[k] ? "local" : "incoming";
    if (v !== a.fields[k]) changed = true;
  }
  const updated_at = Math.max(a.updated_at, b.updated_at);
  const origin = a.updated_at === updated_at && a.origin === "pc" ? "pc" : b.origin;
  const record = { id: a.id, updated_at, origin, deleted: false, deleted_at: 0, fields };
  if (!changed && updated_at === a.updated_at && !a.deleted) {
    return { ok: true, record: a, changed: false, decision: "unchanged" };
  }
  return { ok: true, record, changed: true, decision: a.deleted ? "resurrected" : "merged", decisions };
}

export function mergeBatch(localById, incoming = [], opts = {}) {
  const out = [];
  for (const inc of incoming) {
    const local = localById.get ? localById.get(inc.id) : localById[inc.id];
    const r = mergeRecord(local, inc, opts);
    out.push(r);
    if (r.ok && r.changed) {
      if (localById.set) localById.set(inc.id, r.record);
      else localById[inc.id] = r.record;
    }
  }
  return out;
}

export function cleanupTombstones(records = [], { now = Date.now(), ttlMs = 30 * 24 * 3600_000 } = {}) {
  return records.filter((r) => !(r.deleted && now - (r.deleted_at || 0) > ttlMs));
}
