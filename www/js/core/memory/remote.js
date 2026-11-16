// PC 记忆代理（W8）：memory:query 请求 + 超时 + 结果关联。
// 契约：CONTRACTS.md §3（payload 带 req_id）；PC 侧见 PC-INTEGRATION.md §5.4。

export function createRemoteMemory({ send, timeoutMs = 200, now = () => Date.now() } = {}) {
  if (typeof send !== "function") throw new Error("createRemoteMemory 需要 send");
  const pending = new Map();
  let stats = { queries: 0, ok: 0, timeouts: 0, failed: 0, lastMs: 0 };

  function query(text, k = 5, opts = {}) {
    return new Promise((resolve, reject) => {
      const req_id = `mq-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const t0 = now();
      const waitMs = Number.isFinite(opts?.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : timeoutMs;
      const timer = setTimeout(() => {
        pending.delete(req_id);
        stats.timeouts += 1;
        reject(Object.assign(new Error("memory:query timeout"), { code: "timeout" }));
      }, waitMs);

      pending.set(req_id, {
        timer,
        resolve: (payload) => {
          stats.ok += 1;
          stats.lastMs = now() - t0;
          resolve(payload);
        },
      });
      stats.queries += 1;

      const payload = { req_id, text, k };
      if (opts?.mood && typeof opts.mood === "object") payload.mood = opts.mood;
      if (opts?.includeL0) payload.include_l0 = true;

      let ok = false;
      try {
        ok = send({ type: "memory:query", payload });
      } catch {
        ok = false;
      }
      if (!ok) {
        clearTimeout(timer);
        pending.delete(req_id);
        stats.failed += 1;
        reject(Object.assign(new Error("host not connected"), { code: "not_routed" }));
      }
    });
  }

  /** host 桥收到 memory:result 时调用；返回是否命中未决请求。 */
  function handle(payload) {
    if (!payload || !payload.req_id) return false;
    const p = pending.get(payload.req_id);
    if (!p) return false;
    pending.delete(payload.req_id);
    clearTimeout(p.timer);
    p.resolve(payload);
    return true;
  }

  return {
    query,
    handle,
    get stats() {
      return { ...stats };
    },
    get pending() {
      return pending.size;
    },
  };
}
