// 家具落位 Agent（W31+）：AI 给 props，校验失败带原因重试。
import { extractJson } from "../json.js";
import { validatePlacement } from "../../../forge/placement.js";
import { FURNITURE_IDS, FURNITURE_SIZES } from "../../../forge/furniture.js";

export function createPlaceAgent({ llm, registry, maxAttempts = 3 } = {}) {
  if (!llm) throw new Error("createPlaceAgent 需要 llm");
  if (!registry) throw new Error("createPlaceAgent 需要 registry");

  async function run({ layout, intent = "", furnitureDefs = {} } = {}) {
    const skill = registry.getSkill("furniture-plan");
    if (!skill) return { ok: false, reason: "skill_missing" };
    const available = [...new Set([...FURNITURE_IDS, ...Object.keys(furnitureDefs)])]
      .map((id) => {
        const [w, h] = furnitureDefs[id]?.size || FURNITURE_SIZES[id] || [1, 1];
        return `${id}(${w}x${h})`;
      })
      .join(", ");
    let lastErrors = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const prompt =
        registry.render("furniture-plan", {
          rooms: JSON.stringify(layout.rooms),
          doors: JSON.stringify(layout.doors),
          furniture: available,
          intent: intent || "布置得舒服、能走动",
        }) + (lastErrors.length ? `\n上一次不合格：${lastErrors.slice(0, 5).join("; ")}` : "");
      let res;
      try {
        res = await llm.complete({
          messages: [{ role: "user", content: prompt }],
          json: true,
          maxTokens: skill.maxTokens,
          temperature: skill.temperature,
          cls: "work",
          kind: "furniture-plan",
        });
      } catch (err) {
        return { ok: false, reason: "llm_failed", error: err.message, attempts: attempt };
      }
      const obj = extractJson(res.text);
      if (!obj || !Array.isArray(obj.props)) {
        lastErrors = ["invalid_json"];
        continue;
      }
      const errors = validatePlacement({
        rooms: layout.rooms,
        doors: layout.doors,
        props: obj.props,
        furnitureDefs,
      });
      if (!errors.length) return { ok: true, props: obj.props, attempts: attempt };
      lastErrors = errors;
    }
    return { ok: false, reason: "placement_invalid", errors: lastErrors, attempts: maxAttempts };
  }

  return { run };
}
