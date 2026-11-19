// 心情可视化数据（W20）：4 维采样环形序列 + 来源统计，供 PC 画曲线/雷达。
// 设备只负责产生与推送；渲染在 PC。

export const MOOD_DIMS = Object.freeze(["energy", "valence", "social", "focus"]);

export function createMoodSeries({ backend, cap = 480, now = () => Date.now() } = {}) {
  if (!backend) throw new Error("createMoodSeries 需要 backend");
  let rows = [];

  return {
    async init() {
      const saved = await backend.get("mood_series");
      if (saved && Array.isArray(saved.rows)) rows = saved.rows;
      return this.stats();
    },
    async sample({ minute = 0, mood = {}, band = "calm", source = "tick", reason = "" } = {}) {
      const rec = {
        t: now(),
        minute,
        band,
        source,
        reason,
        mood: Object.fromEntries(MOOD_DIMS.map((k) => [k, Number(mood[k]) || 0])),
      };
      const last = rows[rows.length - 1];
      if (last && last.minute === minute && last.source === source && last.band === band) {
        rows[rows.length - 1] = rec;
      } else {
        rows.push(rec);
      }
      if (rows.length > cap) rows.splice(0, rows.length - cap);
      await backend.put("mood_series", { rows });
      return rec;
    },
    history({ since = 0, limit = 240 } = {}) {
      return rows.filter((r) => r.t > since).slice(-limit);
    },
    latest(n = 1) {
      return rows.slice(-n);
    },
    stats() {
      return { count: rows.length, last: rows[rows.length - 1] || null };
    },
    async clear() {
      rows = [];
      await backend.put("mood_series", { rows });
      return this.stats();
    },
  };
}

/** 来源统计：最近 moodLog 按 source 计数。 */
export function sourceCounts(moodLog = [], limit = 50) {
  const out = {};
  for (const e of moodLog.slice(-limit)) {
    const s = e?.source || "system";
    out[s] = (out[s] || 0) + 1;
  }
  return out;
}

/** PC 可视化载荷：当前值 + 最近序列 + 来源分布。 */
export function buildMoodView({
  now = Date.now(),
  minute = 0,
  mood = {},
  band = "calm",
  series = [],
  moodLog = [],
  limit = 120,
} = {}) {
  return {
    v: 1,
    ts: now,
    minute,
    band,
    dims: Object.fromEntries(MOOD_DIMS.map((k) => [k, Number(mood[k]) || 0])),
    series: series.slice(-limit).map((r) => ({ t: r.t, minute: r.minute, band: r.band, mood: r.mood })),
    sources: sourceCounts(moodLog),
  };
}
