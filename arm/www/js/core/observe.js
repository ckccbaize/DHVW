// 观测（W18）：状态变更日志 + 任务账本 + 健康摘要。
// 状态日志只记"什么变了"；任务账本记每次生成/Agent 的耗时与结果。

export function createStateLog({ backend, cap = 500, now = () => Date.now() } = {}) {
  if (!backend) throw new Error("createStateLog 需要 backend");
  let rows = [];
  let seq = 0;

  return {
    async init() {
      const saved = await backend.get("state_log");
      if (saved && Array.isArray(saved.rows)) {
        rows = saved.rows;
        seq = saved.seq || rows[rows.length - 1]?.seq || 0;
      }
      return this.stats();
    },
    async append({ kind, from = null, to = null, meta = null } = {}) {
      seq += 1;
      const rec = { seq, ts: now(), kind, from, to, meta };
      rows.push(rec);
      if (rows.length > cap) rows.splice(0, rows.length - cap);
      await backend.put("state_log", { seq, rows });
      return rec;
    },
    since(ts = 0) {
      return rows.filter((r) => r.ts > ts);
    },
    latest(n = 20) {
      return rows.slice(-n);
    },
    stats() {
      return { count: rows.length, lastSeq: seq, last: rows[rows.length - 1] || null };
    },
    async clear() {
      rows = [];
      await backend.put("state_log", { seq, rows });
      return this.stats();
    },
  };
}

export function createTaskLedger({ backend, cap = 100, now = () => Date.now() } = {}) {
  if (!backend) throw new Error("createTaskLedger 需要 backend");
  let rows = [];
  let totals = { done: 0, failed: 0 };

  return {
    async init() {
      const saved = await backend.get("task_ledger");
      if (saved) {
        rows = saved.rows || [];
        totals = saved.totals || totals;
      }
      return this.stats();
    },
    async record({ kind, ok = true, ms = 0, error = null, meta = null } = {}) {
      const rec = { id: `t-${now().toString(36)}-${rows.length}`, kind, ok, ms, error, meta, ts: now() };
      rows.push(rec);
      if (rows.length > cap) rows.splice(0, rows.length - cap);
      if (ok) totals.done += 1;
      else totals.failed += 1;
      await backend.put("task_ledger", { rows, totals });
      return rec;
    },
    latest(n = 20) {
      return rows.slice(-n);
    },
    stats() {
      const byKind = {};
      for (const r of rows) {
        const b = byKind[r.kind] || (byKind[r.kind] = { done: 0, failed: 0, lastMs: 0 });
        if (r.ok) b.done += 1;
        else b.failed += 1;
        b.lastMs = r.ms;
      }
      return { ...totals, count: rows.length, byKind, last: rows[rows.length - 1] || null };
    },
    async clear() {
      rows = [];
      totals = { done: 0, failed: 0 };
      await backend.put("task_ledger", { rows, totals });
      return this.stats();
    },
  };
}

/** 一条命令能看到状态机 + 队列 + 预算 + 索引。 */
export function summarizeHealth({ world, life, log, sched, budget, llm, governor, stateLog, ledger, heap } = {}) {
  return {
    world: world ? { display: world.display, tier: world.tier, conn: world.conn } : null,
    life: life ? { minute: life.minute, phase: life.phase, band: life.band, mood: life.mood } : null,
    log: log || null,
    sched: sched || null,
    budget: budget || null,
    llm: llm || null,
    governor: governor || null,
    stateLog: stateLog || null,
    ledger: ledger || null,
    heap: heap || null,
  };
}
