// 巡演形象库：每换一次场景就换一套立绘（whale → atri → miku 循环）。
// 纯函数部分（序号→形象名）抽在这里，便于单测；加载与绘制的副作用留在 tour.js。
export const LOOKS = ["whale", "atri", "miku"];

/**
 * 场景序号 → 形象名。
 *
 * 序号从**家**算起（`world.cur`），不是从街景首段算起：
 * 否则家和书店都拿第 0 套，第一次换场看不出变化（2026-11-20 实测）。
 *
 * @param {number} index 场景在巡演序列里的下标（0 = 家）
 * @param {string[]} [looks] 可用形象名列表
 * @returns {string} 该场景该用的形象名
 */
export function lookFor(index, looks = LOOKS) {
  const list = Array.isArray(looks) && looks.length ? looks : LOOKS;
  const i = Math.trunc(Number(index) || 0);
  return list[((i % list.length) + list.length) % list.length];
}
