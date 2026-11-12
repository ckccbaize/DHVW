// 剧情子 Agent（W14）：随机日常事件 → 30–80 字小记 + 结构化驱动字段。
// 输出同时决定：地图/场景提示、背景图搜索词、心情增量（W15/W16/W33）。
// 工艺约束取自 howells/fiction 与 alt-code fiction-writing-story-development：
// 一次只写一个微小变化、具体感官细节、不写台词、不总结道理。

import { tokenize } from "../../memory/index.js";
import { MOOD_DIMENSIONS } from "../../machine/life.js";
import { extractJson } from "../json.js";

const TIME_WORDS = {
  清晨: ["清晨", "早上", "早晨", "天亮", "拂晓"],
  上午: ["上午", "早上", "早晨"],
  中午: ["中午", "正午", "午后"],
  下午: ["下午", "午后", "傍晚"],
  傍晚: ["傍晚", "黄昏", "入夜", "晚上"],
  夜里: ["夜里", "夜晚", "晚上", "深夜"],
  深夜: ["深夜", "夜里", "凌晨"],
};

export const ROOMS = new Set(["living", "hall", "bedroom", "bath", "balcony", "kitchen"]);

/** 日常事件池：按时段过滤，避免连续重复。 */
export const EVENT_POOL = [
  { id: "rain-window", text: "雨停后开窗，潮气涌进来", hours: [6, 7, 8, 17, 18, 19, 20], place: "living", mood: { valence: 0.06, energy: 0.02 }, imageQuery: "rain window evening" },
  { id: "boil-noodles", text: "锅里水开了，她下面条", hours: [11, 12, 13, 17, 18, 19], place: "kitchen", mood: { valence: 0.08, energy: 0.05 }, imageQuery: "noodles pot steam kitchen" },
  { id: "fold-laundry", text: "收下晾干的衣服，一件件叠好", hours: [9, 10, 11, 15, 16, 17], place: "balcony", mood: { valence: 0.05, focus: 0.04 }, imageQuery: "folded laundry sunlight" },
  { id: "water-plants", text: "给窗台的绿植浇水，扶正歪掉的叶子", hours: [7, 8, 9, 16, 17, 18], place: "balcony", mood: { valence: 0.07, energy: 0.03 }, imageQuery: "watering plants window" },
  { id: "neighbor-knock", text: "邻居敲门借酱油，她翻出半瓶", hours: [10, 11, 12, 18, 19, 20], place: "hall", mood: { social: 0.12, valence: 0.03 }, imageQuery: "apartment door hallway" },
  { id: "old-photos", text: "翻抽屉找电池，翻出一叠旧照片", hours: [14, 15, 16, 21, 22], place: "bedroom", mood: { valence: 0.04, energy: -0.05 }, imageQuery: "old photographs drawer" },
  { id: "fix-lamp", text: "台灯闪了两下，她拧开底座重接", hours: [19, 20, 21, 22], place: "bedroom", mood: { focus: 0.1, energy: -0.03 }, imageQuery: "repair desk lamp tools" },
  { id: "empty-fridge", text: "冰箱空了，她在便签上列清单", hours: [8, 9, 10, 20, 21], place: "kitchen", mood: { focus: 0.06 }, imageQuery: "empty fridge grocery list" },
  { id: "mop-floor", text: "拖地拖到墙角，抹布拧出灰水", hours: [9, 10, 14, 15, 16], place: "living", mood: { energy: -0.08, focus: 0.05 }, imageQuery: "mopping floor bucket" },
  { id: "sun-quilt", text: "把被子抱到阳台晒，拍了两下灰", hours: [10, 11, 12, 13, 14], place: "balcony", mood: { valence: 0.09, energy: 0.04 }, imageQuery: "quilt drying balcony sun" },
  { id: "kids-downstairs", text: "楼下孩子追跑，笑声一阵一阵", hours: [16, 17, 18, 19], place: "living", mood: { social: 0.05, valence: 0.05 }, imageQuery: "children playing street evening" },
  { id: "insomnia", text: "半夜睡不着，她起来倒了杯水", hours: [0, 1, 2, 3, 23], place: "kitchen", mood: { energy: -0.1, valence: -0.04 }, imageQuery: "glass of water night kitchen" },
  { id: "sleep-in", text: "闹钟响过两遍，她才把脸从枕头里抬起来", hours: [7, 8, 9], place: "bedroom", mood: { energy: -0.06, valence: -0.02 }, imageQuery: "morning bed sunlight curtain" },
  { id: "parcel", text: "快递到了，纸箱比想象中轻", hours: [10, 11, 14, 15, 16, 17], place: "hall", mood: { valence: 0.1, energy: 0.05 }, imageQuery: "cardboard parcel doorstep" },
  { id: "phone-dead", text: "手机没电了，她翻出充电线", hours: [9, 12, 15, 18, 21, 22], place: "living", mood: { focus: 0.04 }, imageQuery: "phone charging cable table" },
  { id: "sew-button", text: "衬衫扣子松了，她穿针补了两针", hours: [15, 16, 17, 20, 21], place: "bedroom", mood: { focus: 0.09, energy: -0.02 }, imageQuery: "sewing button shirt needle" },
  { id: "wipe-window", text: "擦窗时看见对面楼亮着一盏灯", hours: [8, 9, 10, 16, 17, 18], place: "living", mood: { valence: 0.03, focus: 0.05 }, imageQuery: "wiping window apartment" },
  { id: "coffee", text: "磨豆机停了，屋里全是咖啡味", hours: [7, 8, 9, 14, 15], place: "kitchen", mood: { energy: 0.1, valence: 0.06 }, imageQuery: "coffee grinder morning kitchen" },
  { id: "old-ticket", text: "书里掉出一张旧车票，日期已经模糊", hours: [13, 14, 15, 21, 22], place: "living", mood: { valence: 0.03, energy: -0.03 }, imageQuery: "old train ticket book" },
  { id: "no-reply", text: "给朋友发的消息一直没回，她把手机扣在桌上", hours: [11, 12, 19, 20, 21, 22], place: "living", mood: { social: -0.1, valence: -0.05 }, imageQuery: "phone face down table" },
];

export function periodOf(hour) {
  if (hour >= 5 && hour < 8) return "清晨";
  if (hour >= 8 && hour < 11) return "上午";
  if (hour >= 11 && hour < 14) return "中午";
  if (hour >= 14 && hour < 17) return "下午";
  if (hour >= 17 && hour < 20) return "傍晚";
  if (hour >= 20 && hour < 23) return "夜里";
  return "深夜";
}

export function hasTimeAnchor(text, hour) {
  const words = TIME_WORDS[periodOf(hour)] || [];
  return words.some((w) => text.includes(w));
}

export function similarity(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit += 1;
  return hit / (A.size + B.size - hit);
}

export function validatePlot(text, { hour, recent = [] } = {}) {
  const s = String(text ?? "").trim();
  const n = [...s.replace(/\s/g, "")].length;
  if (n < 30) return "too_short";
  if (n > 80) return "too_long";
  if (/[“”"「」『』]/.test(s)) return "has_dialogue";
  if (!hasTimeAnchor(s, hour)) return "no_time_anchor";
  for (const prev of recent) {
    if (similarity(s, prev) >= 0.6) return "duplicate";
  }
  return null;
}

/** 校验结构化剧情；返回 null 表示合格。 */
export function validatePlotResult(obj, { hour, recent = [] } = {}) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "not_object";
  const textReason = validatePlot(obj.text, { hour, recent });
  if (textReason) return textReason;
  if (typeof obj.event !== "string" || obj.event.trim().length < 2 || obj.event.length > 24) return "bad_event";
  if (!ROOMS.has(obj.place)) return "bad_place";
  if (obj.scene !== undefined && !ROOMS.has(obj.scene)) return "bad_scene";
  if (!obj.mood || typeof obj.mood !== "object" || Array.isArray(obj.mood)) return "bad_mood";
  for (const [k, v] of Object.entries(obj.mood)) {
    if (!MOOD_DIMENSIONS.includes(k)) return `bad_mood_dim:${k}`;
    if (!Number.isFinite(v) || Math.abs(v) > 0.3) return `bad_mood_delta:${k}`;
  }
  if (typeof obj.imageQuery !== "string" || obj.imageQuery.trim().length < 2 || obj.imageQuery.length > 60) {
    return "bad_image_query";
  }
  return null;
}

/** 按时段与最近事件挑一个日常事件；random 可注入以便测试。 */
export function pickDailyEvent({ hour = new Date().getHours(), recent = [], random = Math.random } = {}) {
  const recentIds = new Set(recent);
  let pool = EVENT_POOL.filter((e) => e.hours.includes(hour) && !recentIds.has(e.id));
  if (!pool.length) pool = EVENT_POOL.filter((e) => !recentIds.has(e.id));
  if (!pool.length) pool = EVENT_POOL;
  return pool[Math.floor(random() * pool.length) % pool.length];
}

export function createPlotAgent({ llm, registry, now = () => Date.now(), maxAttempts = 3 } = {}) {
  if (!llm) throw new Error("createPlotAgent 需要 llm");
  if (!registry) throw new Error("createPlotAgent 需要 registry");

  async function run({
    input = "",
    place = "",
    mood = "",
    recent = [],
    recentEvents = [],
    hour,
    random = Math.random,
  } = {}) {
    const skill = registry.getSkill("plot-writer");
    if (!skill) return { ok: false, reason: "skill_missing", attempts: 0 };
    const ts = now();
    const h = Number.isFinite(hour) ? hour : new Date(ts).getHours();
    const period = periodOf(h);
    const seed = input || pickDailyEvent({ hour: h, recent: recentEvents, random });
    const seedText = typeof seed === "string" ? seed : seed.text;
    const recentText = recent.slice(0, 5).join(" / ") || "（无）";
    let draft = "";
    let reason = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt =
        attempt === 1
          ? registry.render("plot", {
              input: seedText,
              place,
              mood,
              period,
              now: new Date(ts).toISOString(),
              recent: recentText,
            })
          : registry.render("plot-repair", { draft, reason, recent: recentText });
      let res;
      try {
        res = await llm.complete({
          messages: [{ role: "user", content: prompt }],
          maxTokens: skill.maxTokens,
          temperature: skill.temperature,
          json: true,
          cls: "work",
          kind: "plot",
        });
      } catch (err) {
        return { ok: false, reason: "llm_failed", error: err.message, attempts: attempt };
      }
      draft = String(res.text ?? "").trim();
      const obj = extractJson(draft);
      reason = obj ? validatePlotResult(obj, { hour: h, recent }) : "invalid_json";
      if (!reason) {
        return {
          ok: true,
          text: obj.text.trim(),
          event: obj.event.trim(),
          place: obj.place,
          scene: obj.scene ?? obj.place,
          mood: obj.mood,
          imageQuery: obj.imageQuery.trim(),
          attempts: attempt,
        };
      }
    }
    return { ok: false, reason, text: draft, attempts: maxAttempts };
  }

  return { run };
}
