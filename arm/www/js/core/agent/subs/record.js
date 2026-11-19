// 行为留档（W27+）：角色 LLM 写一条"做了什么 + 心情变化"的短记录。
import { extractJson } from "../json.js";

export function validateRecord(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "not_object";
  const summary = String(obj.summary ?? "").trim();
  if (summary.length < 10 || summary.length > 80) return "bad_summary";
  if (typeof obj.mood !== "string" || !obj.mood.trim() || obj.mood.length > 60) return "bad_mood";
  if (obj.evidence !== undefined && typeof obj.evidence !== "string") return "bad_evidence";
  return null;
}

export function createRecordAgent({ llm, registry, now = () => Date.now() } = {}) {
  if (!llm) throw new Error("createRecordAgent 需要 llm");
  if (!registry) throw new Error("createRecordAgent 需要 registry");

  async function run({ behavior, before = {}, after = {}, place = "", detail = "" } = {}) {
    if (!behavior) return { ok: false, reason: "missing_behavior" };
    const skill = registry.getSkill("behavior-record");
    if (!skill) return { ok: false, reason: "skill_missing" };
    const prompt = registry.render("behavior-record", {
      name: behavior.name,
      kind: behavior.kind,
      place: place || "家里",
      detail: detail || behavior.name,
      before: JSON.stringify(before),
      after: JSON.stringify(after),
    });
    let res;
    try {
      res = await llm.complete({
        messages: [{ role: "user", content: prompt }],
        json: true,
        maxTokens: skill.maxTokens,
        temperature: skill.temperature,
        cls: "character",
        kind: "behavior-record",
      });
    } catch (err) {
      return { ok: false, reason: "llm_failed", error: err.message };
    }
    const obj = extractJson(res.text);
    const reason = obj ? validateRecord(obj) : "invalid_json";
    if (reason) return { ok: false, reason };
    return {
      ok: true,
      summary: obj.summary.trim(),
      mood: obj.mood.trim(),
      evidence: typeof obj.evidence === "string" ? obj.evidence.trim() : "",
      ts: now(),
    };
  }

  return { run };
}
