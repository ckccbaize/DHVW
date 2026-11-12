// 剧情子 Agent（W14）：30–80 字小记，带时间锚点、去重、失败重写。
// 工艺约束取自 howells/fiction 与 alt-code fiction-writing-story-development：
// 一次只写一个微小变化、具体感官细节、不写台词、不总结道理。

import { tokenize } from "../../memory/index.js";

const TIME_WORDS = {
  清晨: ["清晨", "早上", "早晨", "天亮", "拂晓"],
  上午: ["上午", "早上", "早晨"],
  中午: ["中午", "正午", "午后"],
  下午: ["下午", "午后", "傍晚"],
  傍晚: ["傍晚", "黄昏", "入夜", "晚上"],
  夜里: ["夜里", "夜晚", "晚上", "深夜"],
  深夜: ["深夜", "夜里", "凌晨"],
};

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

export function createPlotAgent({ llm, registry, now = () => Date.now(), maxAttempts = 3 } = {}) {
  if (!llm) throw new Error("createPlotAgent 需要 llm");
  if (!registry) throw new Error("createPlotAgent 需要 registry");

  async function run({ input = "", place = "", mood = "", recent = [], hour } = {}) {
    const skill = registry.getSkill("plot-writer");
    if (!skill) return { ok: false, reason: "skill_missing", attempts: 0 };
    const ts = now();
    const h = Number.isFinite(hour) ? hour : new Date(ts).getHours();
    const period = periodOf(h);
    const recentText = recent.slice(0, 5).join(" / ") || "（无）";
    let draft = "";
    let reason = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt =
        attempt === 1
          ? registry.render("plot", {
              input,
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
          cls: "work",
          kind: "plot",
        });
      } catch (err) {
        return { ok: false, reason: "llm_failed", error: err.message, attempts: attempt };
      }
      draft = String(res.text ?? "")
        .trim()
        .replace(/^["“「]|["”」]$/g, "")
        .trim();
      reason = validatePlot(draft, { hour: h, recent });
      if (!reason) return { ok: true, text: draft, attempts: attempt };
    }
    return { ok: false, reason, text: draft, attempts: maxAttempts };
  }

  return { run };
}
