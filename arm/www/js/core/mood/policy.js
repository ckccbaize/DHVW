// 心情外部引导（W33）：来源优先级、TTL、限频、setpoint/bias、可解释日志。
// 规则见 WORLD-CORE-SPEC.md §3.4。

export const MOOD_PRIORITY = Object.freeze({
  doctor: 6,
  user: 5,
  wake: 4,
  interaction: 3,
  plot: 2,
  system: 1,
});

export const POLICY_DEFAULTS = Object.freeze({
  rateWindowMs: 10 * 60_000,
  rateMax: 3,
  logCap: 50,
});

export function createMoodPolicy({ now = () => Date.now(), ...cfg } = {}) {
  const conf = { ...POLICY_DEFAULTS, ...cfg };
  const effects = [];
  const log = [];
  const rate = new Map();

  function prune(ts) {
    for (let i = effects.length - 1; i >= 0; i--) {
      if (effects[i].expiresAt && effects[i].expiresAt <= ts) effects.splice(i, 1);
    }
  }

  function active() {
    prune(now());
    return effects.map((e) => ({ ...e }));
  }

  return {
    apply({ source = "system", reason = "", deltas = null, setpoint = null, ttlMs = 0 } = {}) {
      const ts = now();
      prune(ts);
      if (!MOOD_PRIORITY[source]) return { ok: false, reason: "bad_source" };
      if (!reason || typeof reason !== "string") return { ok: false, reason: "missing_reason" };
      if (setpoint && (!ttlMs || ttlMs <= 0)) return { ok: false, reason: "setpoint_needs_ttl" };

      const hits = (rate.get(source) || []).filter((t) => ts - t < conf.rateWindowMs);
      if (hits.length >= conf.rateMax) {
        log.push({ t: ts, source, reason, rejected: "rate_limited" });
        if (log.length > conf.logCap) log.shift();
        return { ok: false, reason: "rate_limited" };
      }
      hits.push(ts);
      rate.set(source, hits);

      const priority = MOOD_PRIORITY[source];
      const top = effects.filter((e) => e.expiresAt).reduce((m, e) => Math.max(m, e.priority), 0);
      if (priority < top) {
        log.push({ t: ts, source, reason, rejected: "lower_priority" });
        if (log.length > conf.logCap) log.shift();
        return { ok: false, reason: "lower_priority" };
      }

      const effect = {
        source,
        reason,
        priority,
        deltas: deltas || null,
        setpoint: setpoint || null,
        at: ts,
        expiresAt: ttlMs > 0 ? ts + ttlMs : 0,
      };
      effects.push(effect);
      log.push({ t: ts, source, reason, priority, deltas, setpoint, ttlMs });
      if (log.length > conf.logCap) log.shift();
      return { ok: true, mode: setpoint ? "setpoint" : "bias", effect };
    },
    active,
    resolve() {
      prune(now());
      const topSet = effects.filter((e) => e.setpoint).sort((a, b) => b.priority - a.priority)[0];
      const bias = {};
      for (const e of effects) {
        if (!e.deltas) continue;
        for (const [k, v] of Object.entries(e.deltas)) bias[k] = (bias[k] || 0) + Number(v || 0);
      }
      return { setpoint: topSet ? { ...topSet.setpoint } : null, bias, effects: active() };
    },
    log() {
      return log.map((r) => ({ ...r }));
    },
    stats() {
      return { effects: effects.length, log: log.length, active: active() };
    },
    reset() {
      effects.length = 0;
      log.length = 0;
      rate.clear();
    },
  };
}
