// 资源治理（W17）：内存/事件量水位 → P4/P3/P2 降级 + 看门狗。
// 语义见 WORLD-CORE-SPEC.md §9；P4 正常，P3 减负，P2 只保留生活/唤醒。

export const TIER_RANK = { P4: 4, P3: 3, P2: 2 };

export const DEFAULT_THRESHOLDS = Object.freeze({
  heapP3: 0.65,
  heapP2: 0.82,
  eventsP3: 1200,
  eventsP2: 1800,
  upgradeHits: 2,
  upgradeMargin: 0.08,
});

/** 按水位分类；返回目标档位与原因。 */
export function classify({ heapRatio = 0, eventCount = 0, queue = 0 } = {}, t = DEFAULT_THRESHOLDS) {
  const reasons = [];
  if (heapRatio >= t.heapP2) reasons.push(`heap:${heapRatio.toFixed(2)}`);
  if (eventCount >= t.eventsP2) reasons.push(`events:${eventCount}`);
  if (reasons.length) return { tier: "P2", reasons };
  if (heapRatio >= t.heapP3) reasons.push(`heap:${heapRatio.toFixed(2)}`);
  if (eventCount >= t.eventsP3) reasons.push(`events:${eventCount}`);
  if (queue >= 20) reasons.push(`queue:${queue}`);
  if (reasons.length) return { tier: "P3", reasons };
  return { tier: "P4", reasons: [] };
}

/** 某档位允许执行的生成类任务。 */
export function allowedAt(tier, kind) {
  if (tier === "P2") return kind === "life" || kind === "wake";
  if (tier === "P3") return kind !== "bg";
  return true;
}

export function createGovernor({
  getMetrics = () => ({}),
  now = () => Date.now(),
  thresholds = DEFAULT_THRESHOLDS,
  onTier = () => {},
} = {}) {
  let tier = "P4";
  let calm = 0;

  function check() {
    const metrics = getMetrics();
    const c = classify(metrics, thresholds);
    let next = c.tier;

    if (next === "P4" && tier !== "P4") {
      // 完全恢复需要连续 calm 次，且内存低于 P3 阈值留出余量；
      // P2 → P3 属于脱离紧急态，立即生效。
      const heapOk = (metrics.heapRatio || 0) <= thresholds.heapP3 - thresholds.upgradeMargin;
      calm = heapOk ? calm + 1 : 0;
      if (calm < thresholds.upgradeHits) next = tier === "P2" ? "P3" : tier;
    } else {
      calm = 0;
    }

    const changed = next !== tier;
    tier = next;
    const out = { tier, changed, reasons: c.reasons, metrics, at: now() };
    if (changed) onTier(out);
    return out;
  }

  return {
    check,
    get tier() {
      return tier;
    },
    reset() {
      tier = "P4";
      calm = 0;
    },
  };
}

/** 主线程/外部看门狗：心跳超时判定。 */
export function checkWatchdog({ lastBeatAt = 0, now = Date.now(), timeoutMs = 30000 } = {}) {
  const age = Math.max(0, now - lastBeatAt);
  return { stale: age > timeoutMs, age, timeoutMs };
}
