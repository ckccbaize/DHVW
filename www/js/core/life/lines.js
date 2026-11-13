// 生活短句池（L2）：分桶 + 天气插句 + 24h 去重。
// 端侧只产短句，不产台词。

export const LINES = {
  sleep: ["把被子拉到肩上。", "翻了个身，又安静下来。", "夜里醒了一次，很快又睡着。"],
  wake: ["窗帘没拉开，光已经进来了。", "坐起来发了会儿呆。", "把拖鞋踢正，慢慢站起来。"],
  morning: [
    "把窗开了一条缝。",
    "水烧开了，屋子里有点雾。",
    "今天的光比昨天软一些。",
    "把昨晚的杯子收进水槽。",
    "在窗边站了一会儿，看楼下的人。",
  ],
  noon: ["热了点东西吃。", "把碗筷摞好。", "坐在桌边慢慢吃完。", "把剩下的收进冰箱。"],
  afternoon: [
    "翻了两页书，又合上。",
    "把地毯拍了两下。",
    "猫又跳到窗台上了。",
    "写着写着，笔停了。",
    "把椅子挪到有光的地方。",
  ],
  evening: ["开了盏小灯。", "把窗帘拉了一半。", "锅里的水开始响。", "靠着沙发坐了一会儿。"],
  night: ["把灯关到只剩一盏。", "刷了会儿手机。", "把明天要穿的衣服放好。"],
  weather: {
    rain: ["雨点敲在窗上。", "外面湿了，屋里更安静。", "把晾着的衣服收了进来。"],
    snow: ["雪落得很慢。", "窗台积了薄薄一层。", "把手贴在玻璃上，凉。"],
    clear: ["天很干净。", "阳光斜着进来，落在桌角。"],
    cloudy: ["云压得低，屋里暗了一点。", "把灯提前打开了。"],
  },
};

/** 同一天同一天气（L3）。 */
export function weatherForDay(day) {
  const h = (day * 2654435761) >>> 0;
  const r = (h % 100) / 100;
  if (r < 0.55) return "clear";
  if (r < 0.78) return "cloudy";
  if (r < 0.93) return "rain";
  return "snow";
}

/** 活动度 → tick 间隔（L4）。 */
export function tickInterval(activity, baseMs = 1000) {
  if (activity === "asleep") return 60000;
  return baseMs;
}

/**
 * 挑一句：phase 桶 + 45% 天气插句；24h 内不重复。
 * recent: [{text, day, minute}]
 */
export function pickLine({ phase = "afternoon", weather = "clear", day = 1, minute = 0, recent = [], random = Math.random } = {}) {
  const pool = [...(LINES[phase] || LINES.afternoon)];
  const w = LINES.weather[weather];
  if (w && random() < 0.45) pool.push(...w);
  const nowMin = day * 1440 + minute;
  const seen = new Set(
    recent
      .filter((r) => nowMin - (r.day * 1440 + r.minute) < 1440)
      .map((r) => r.text),
  );
  const fresh = pool.filter((t) => !seen.has(t));
  if (!fresh.length) return null;
  return fresh[Math.floor(random() * fresh.length) % fresh.length];
}
