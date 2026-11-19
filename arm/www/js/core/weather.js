// 独立天气系统：按游戏日生成，不依赖场景/光照。
// 一天一种天气；同一天内不变，换天时重新随机（按 day 确定性，刷新不跳变）。

export const WEATHER_STATES = Object.freeze(["clear", "cloudy", "rain", "snow", "fog", "storm"]);

function hash(n) {
  let x = n >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** 当天天气：state / temp / wind / block。minute 仅为兼容旧调用，不参与变化。 */
export function weatherAt(day = 1, minute = 0) {
  const h = hash(day * 100003 + 7919);
  const r = (h % 1000) / 1000;
  let state;
  if (r < 0.38) state = "clear";
  else if (r < 0.62) state = "cloudy";
  else if (r < 0.78) state = "rain";
  else if (r < 0.86) state = "snow";
  else if (r < 0.94) state = "fog";
  else state = "storm";

  const temp = Math.round(8 + (hash(h + 1) % 220) / 10); // 8–30℃
  const wind = Math.round((hash(h + 2) % 60) / 10); // 0–6
  return { state, temp, wind, block: 0 };
}

/** 当天天气状态。 */
export function weatherForDay(day = 1) {
  return weatherAt(day).state;
}
