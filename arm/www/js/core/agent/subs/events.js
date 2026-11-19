// 事件池扩展（W14+）：让剧情 Agent 定时生成新的日常事件。
// 输出写入 kv event_pool，与内置 EVENT_POOL 合并后供剧情挑选。

import { MOOD_DIMENSIONS } from "../../machine/life.js";
import { extractJson } from "../json.js";
import { ROOMS, similarity } from "./plot.js";

export function validateEvent(e, { existing = [] } = {}) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return "not_object";
  const text = String(e.text ?? "").trim();
  if (text.length < 4 || text.length > 24) return "bad_text";
  if (!Array.isArray(e.hours) || !e.hours.length) return "bad_hours";
  if (e.hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) return "bad_hours";
  if (!ROOMS.has(e.place)) return "bad_place";
  if (!e.mood || typeof e.mood !== "object" || Array.isArray(e.mood)) return "bad_mood";
  for (const [k, v] of Object.entries(e.mood)) {
    if (!MOOD_DIMENSIONS.includes(k)) return `bad_mood_dim:${k}`;
    if (!Number.isFinite(v) || Math.abs(v) > 0.3) return `bad_mood_delta:${k}`;
  }
  if (typeof e.imageQuery !== "string" || e.imageQuery.trim().length < 2 || e.imageQuery.length > 60) {
    return "bad_image_query";
  }
  if (existing.some((t) => similarity(text, t) >= 0.6)) return "duplicate";
  return null;
}

export function createEventPoolAgent({ llm, registry, now = () => Date.now() } = {}) {
  if (!llm) throw new Error("createEventPoolAgent 需要 llm");
  if (!registry) throw new Error("createEventPoolAgent 需要 registry");

  async function refresh({ existing = [], count = 6 } = {}) {
    const skill = registry.getSkill("event-pool");
    if (!skill) return { ok: false, reason: "skill_missing", events: [], rejected: [] };
    const prompt = registry.render("event-pool", {
      existing: existing.slice(0, 40).join(" / ") || "（无）",
      count: String(count),
    });
    let res;
    try {
      res = await llm.complete({
        messages: [{ role: "user", content: prompt }],
        maxTokens: skill.maxTokens,
        temperature: skill.temperature,
        json: true,
        cls: "work",
        kind: "event-pool",
      });
    } catch (err) {
      return { ok: false, reason: "llm_failed", error: err.message, events: [], rejected: [] };
    }
    const obj = extractJson(res.text);
    if (!obj || !Array.isArray(obj.events)) {
      return { ok: false, reason: "bad_json", events: [], rejected: [] };
    }
    const ts = now();
    const accepted = [];
    const rejected = [];
    for (const raw of obj.events.slice(0, count)) {
      const reason = validateEvent(raw, {
        existing: [...existing, ...accepted.map((a) => a.text)],
      });
      if (reason) {
        rejected.push({ text: String(raw?.text ?? "").slice(0, 40), reason });
        continue;
      }
      accepted.push({
        id: `gen-${ts.toString(36)}-${accepted.length}`,
        text: raw.text.trim(),
        hours: [...new Set(raw.hours)].sort((a, b) => a - b),
        place: raw.place,
        mood: { ...raw.mood },
        imageQuery: raw.imageQuery.trim(),
        source: "llm",
        createdAt: ts,
      });
    }
    return { ok: accepted.length > 0, events: accepted, rejected };
  }

  return { refresh };
}
