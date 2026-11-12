// 资产优先级与配额淘汰（纯函数，§10.7.6 / M11-T21）。
// 设备侧只有 edge 与内置模板；host 资产由主机下发，这里保留优先级语义。

export const TIER_RANK = { host: 3, edge: 2, builtin: 1 };

/** 按 kind 取当前应消费的资产：tier 优先，其次 created_at 新者优先。 */
export function pickAsset(assets, kind, { hostOnly = false } = {}) {
  let best = null;
  for (const a of assets) {
    if (a.kind !== kind) continue;
    if (hostOnly && a.tier !== "host") continue;
    if (!best) {
      best = a;
      continue;
    }
    const ra = TIER_RANK[a.tier] || 0;
    const rb = TIER_RANK[best.tier] || 0;
    if (ra > rb || (ra === rb && (a.created_at || 0) > (best.created_at || 0))) best = a;
  }
  return best;
}

export function totalSize(assets) {
  return assets.reduce((n, a) => n + (a.size || 0), 0);
}

/**
 * 配额淘汰：只淘汰 edge，按「最久未消费 → 最旧」排序，直到总量回到配额内。
 * 返回应删除的 id 列表。host 永不淘汰（设备侧没有 host 文件，规则仍写死）。
 */
export function selectEvictions(assets, quotaBytes) {
  const total = totalSize(assets);
  if (total <= quotaBytes) return [];
  const candidates = assets
    .filter((a) => a.tier === "edge")
    .sort((a, b) => {
      const ca = a.consumed_at || 0;
      const cb = b.consumed_at || 0;
      if (ca !== cb) return ca - cb;
      return (a.created_at || 0) - (b.created_at || 0);
    });
  const out = [];
  let size = total;
  for (const a of candidates) {
    if (size <= quotaBytes) break;
    out.push(a.id);
    size -= a.size || 0;
  }
  return out;
}
