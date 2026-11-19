// LLM 预算账本（W25）：只统计 + 软告警，**不自动熔断**。
// 需求方口径：可以统计，但不能断闸；停用由用户手动决定。

const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const emptyTotals = () => ({ calls: 0, ok: 0, failed: 0, inTokens: 0, outTokens: 0 });

export function createBudgetLedger({ backend, now = () => Date.now(), softLimitOut = 50000 } = {}) {
  if (!backend) throw new Error("createBudgetLedger 需要 backend");
  const rows = new Map(); // `${day}|${cls}|${kind}` -> row
  let loaded = false;
  let limit = softLimitOut;

  async function init() {
    if (loaded) return;
    const saved = await backend.get("llm_budget");
    for (const row of saved?.rows || []) rows.set(row.key, row);
    loaded = true;
  }

  async function persist() {
    // 只保留最近 31 天
    const cutoff = new Date(now() - 31 * 86400000);
    const keep = [];
    for (const row of rows.values()) {
      if (new Date(row.day) >= new Date(dayKey(cutoff))) keep.push(row);
      else rows.delete(row.key);
    }
    await backend.put("llm_budget", { rows: keep });
  }

  return {
    async init() {
      await init();
      return this.stats();
    },
    /** 记录一次调用；usage 可能为空（失败时）。 */
    record({ cls = "work", kind = "generic", usage = null, ok = true, ts = now() } = {}) {
      const day = dayKey(ts);
      const key = `${day}|${cls}|${kind}`;
      const row =
        rows.get(key) || { key, day, cls, kind, ...emptyTotals() };
      row.calls += 1;
      if (ok) row.ok += 1;
      else row.failed += 1;
      if (usage) {
        row.inTokens += Number(usage.prompt_tokens) || 0;
        row.outTokens += Number(usage.completion_tokens) || 0;
      }
      rows.set(key, row);
      void persist();
      return { ...row };
    },
    history(days = 7) {
      const out = [];
      const base = new Date(now());
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        out.push(this.stats(dayKey(d.getTime())));
      }
      return out;
    },
    stats(day = dayKey(now())) {
      const totals = emptyTotals();
      const byClass = {};
      const byKind = {};
      for (const row of rows.values()) {
        if (row.day !== day) continue;
        for (const k of Object.keys(totals)) totals[k] += row[k];
        for (const [bucket, key] of [
          [byClass, row.cls],
          [byKind, row.kind],
        ]) {
          const b = bucket[key] || (bucket[key] = emptyTotals());
          for (const k of Object.keys(b)) b[k] += row[k];
        }
      }
      return {
        day,
        ...totals,
        byClass,
        byKind,
        softLimitOut: limit,
        softAlert: totals.outTokens > limit,
      };
    },
    setSoftLimit(n) {
      const v = Math.trunc(Number(n));
      if (Number.isFinite(v) && v >= 0) limit = v;
      return limit;
    },
    async reset(day = dayKey(now())) {
      for (const [key, row] of rows) if (row.day === day) rows.delete(key);
      await persist();
      return this.stats(day);
    },
    get softLimitOut() {
      return limit;
    },
  };
}
