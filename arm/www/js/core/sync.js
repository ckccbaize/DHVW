// 与 PC 同步（W19）：事件批 ACK、重连重发、事实合并回执。
// 契约：CONTRACTS.md §3；PC 侧职责见 PC-INTEGRATION.md。

export function createSyncManager({
  eventLog,
  send,
  backend,
  now = () => Date.now(),
  batchSize = 200,
  ackTimeoutMs = 8000,
} = {}) {
  if (!eventLog) throw new Error("createSyncManager 需要 eventLog");
  if (typeof send !== "function") throw new Error("createSyncManager 需要 send");

  let ackedSeq = 0;
  let inFlight = null;
  const stats = { batches: 0, acked: 0, retries: 0, sent: 0, lastAckAt: 0, lastError: null };

  async function persist() {
    if (!backend) return;
    try {
      await backend.put("sync_state", { ackedSeq, updatedAt: now() });
    } catch {
      /* 持久化失败不阻塞同步 */
    }
  }

  return {
    async init() {
      if (backend) {
        const saved = await backend.get("sync_state");
        if (saved && Number.isFinite(saved.ackedSeq)) ackedSeq = saved.ackedSeq;
      }
      return ackedSeq;
    },
    get ackedSeq() {
      return ackedSeq;
    },
    get stats() {
      return { ...stats, ackedSeq, inFlight: inFlight ? inFlight.lastSeq : null };
    },
    async flush() {
      if (inFlight && now() - inFlight.at < ackTimeoutMs) return 0;
      if (inFlight) {
        stats.retries += 1;
        inFlight = null;
      }
      const events = await eventLog.since(ackedSeq, batchSize);
      if (!events.length) return 0;
      const ok = send({
        type: "events:batch",
        payload: { events, from_seq: ackedSeq, batch_id: `b-${now().toString(36)}` },
      });
      if (!ok) {
        stats.lastError = "not_routed";
        return 0;
      }
      inFlight = { at: now(), lastSeq: events[events.length - 1].seq };
      stats.batches += 1;
      stats.sent += events.length;
      return events.length;
    },
    onAck(payload = {}) {
      const seq = Number(payload.seq);
      if (!Number.isFinite(seq) || seq < ackedSeq) return false;
      ackedSeq = seq;
      inFlight = null;
      stats.acked += 1;
      stats.lastAckAt = now();
      void persist();
      return true;
    },
    onReconnect() {
      inFlight = null;
    },
    reset() {
      ackedSeq = 0;
      inFlight = null;
      void persist();
    },
  };
}

/** 合并 PC 回传事实：按 id 去重，空文本拒绝。 */
export function mergeFacts(facts = [], { seen = new Set(), now = () => Date.now() } = {}) {
  const accepted = [];
  const merged = [];
  const rejected = [];
  for (const f of facts) {
    if (!f || typeof f !== "object") {
      rejected.push({ id: null, reason: "bad_fact" });
      continue;
    }
    const id = String(f.id || "").trim();
    const text = String(f.text || "").trim();
    if (!id || !text) {
      rejected.push({ id: id || null, reason: "missing_id_or_text" });
      continue;
    }
    if (seen.has(id)) {
      merged.push(id);
      continue;
    }
    seen.add(id);
    accepted.push({
      id,
      text,
      t: Number(f.t) || now(),
      tier: f.tier || "L2",
      meta: f.meta || null,
    });
  }
  return { accepted, merged, rejected };
}
