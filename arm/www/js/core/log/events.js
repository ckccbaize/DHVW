// 事件日志（W5）：append-only + seq + 环形上限 + 幂等 + 可插拔后端。
// 契约：docs/WORLD-CORE-SPEC.md §6；后端：内存（测试）/ IndexedDB（设备）。

export const DEFAULT_CAP = 2000;

let uuidFallback = 0;
export function defaultUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  uuidFallback += 1;
  return `ev-${Date.now().toString(36)}-${uuidFallback}`;
}

/** 内存后端：测试与无 IndexedDB 时的降级。 */
export function createMemoryBackend() {
  const rows = new Map(); // seq -> record
  const byUuid = new Map(); // uuid -> seq

  return {
    async append(rec) {
      if (byUuid.has(rec.uuid)) return false;
      rows.set(rec.seq, rec);
      byUuid.set(rec.uuid, rec.seq);
      return true;
    },
    async count() {
      return rows.size;
    },
    async lastSeq() {
      let max = 0;
      for (const seq of rows.keys()) if (seq > max) max = seq;
      return max;
    },
    async oldest(n) {
      return [...rows.values()].sort((a, b) => a.seq - b.seq).slice(0, n);
    },
    async latest(n) {
      return [...rows.values()].sort((a, b) => b.seq - a.seq).slice(0, n);
    },
    async since(seq, limit = 200) {
      return [...rows.values()]
        .filter((r) => r.seq > seq)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
    },
    async deleteSeqs(seqs) {
      for (const seq of seqs) {
        const rec = rows.get(seq);
        if (!rec) continue;
        rows.delete(seq);
        byUuid.delete(rec.uuid);
      }
    },
    async clear() {
      rows.clear();
      byUuid.clear();
    },
  };
}

/**
 * 事件日志：seq 单调递增；uuid 幂等；超过 cap 删最旧。
 * 所有方法异步（后端可能是 IndexedDB）。
 */
export function createEventLog({
  backend,
  cap = DEFAULT_CAP,
  now = () => Date.now(),
  genUuid = defaultUuid,
  origin = "device",
} = {}) {
  if (!backend) throw new Error("createEventLog 需要 backend");
  let lastSeq = 0;
  let initialized = false;
  let stats = { count: 0, lastSeq: 0, dropped: 0 };

  async function init() {
    if (initialized) return stats;
    lastSeq = await backend.lastSeq();
    stats = { count: await backend.count(), lastSeq, dropped: 0 };
    initialized = true;
    return stats;
  }

  async function append({ kind, payload = {}, uuid, t_local, t_corrected, src = origin } = {}) {
    if (!kind) throw new Error("事件缺少 kind");
    if (!initialized) await init();
    const rec = {
      seq: lastSeq + 1,
      uuid: uuid || genUuid(),
      t_local: t_local ?? now(),
      kind,
      payload,
      src,
    };
    if (t_corrected !== undefined) rec.t_corrected = t_corrected;

    const ok = await backend.append(rec);
    if (!ok) return { duplicate: true, uuid: rec.uuid };

    lastSeq = rec.seq;
    let count = await backend.count();
    if (count > cap) {
      const overflow = count - cap;
      const oldest = await backend.oldest(overflow);
      await backend.deleteSeqs(oldest.map((r) => r.seq));
      count -= oldest.length;
      stats.dropped += oldest.length;
    }
    stats = { count, lastSeq, dropped: stats.dropped };
    return { duplicate: false, record: rec };
  }

  return {
    init,
    append,
    get lastSeq() {
      return lastSeq;
    },
    get stats() {
      return { ...stats };
    },
    count: () => backend.count(),
    latest: (n = 20) => backend.latest(n),
    oldest: (n = 20) => backend.oldest(n),
    since: (seq, limit = 200) => backend.since(seq, limit),
    clear: async () => {
      await backend.clear();
      lastSeq = 0;
      stats = { count: 0, lastSeq: 0, dropped: 0 };
    },
  };
}
