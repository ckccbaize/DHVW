// 行为耗时（L1+）：创建意图时确定，到达后按游戏分钟占用。
export const ACT_DURATION = Object.freeze({
  sleep: 480,
  wake: 10,
  dress: 10,
  read: 25,
  eat: 30,
  cook: 35,
  work: 45,
  write: 40,
  rest: 20,
  watch: 30,
  bath: 25,
  wash: 10,
  laundry: 40,
  water: 10,
  play: 15,
  sit: 10,
  light: 5,
  toilet: 5,
});

export function pickDuration(act, random = Math.random) {
  const base = ACT_DURATION[act] || 15;
  const jitter = 0.7 + random() * 0.6; // 0.7–1.3
  return Math.max(1, Math.round(base * jitter));
}
