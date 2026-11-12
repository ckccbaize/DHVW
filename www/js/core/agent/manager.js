// 管理层 Agent（W13）：意图 → 计划 → 派发 → 校验 → 落库。
// 事件名沿用 pi 的 agent/turn/message/tool_execution 结构，写入设备事件日志。

export function extractJson(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function validatePlan(raw, registry, maxTasks = 3) {
  const plan = extractJson(raw);
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { ok: false, reason: "plan_not_object" };
  if (!Array.isArray(plan.tasks)) return { ok: false, reason: "tasks_not_array" };
  if (plan.tasks.length > maxTasks) return { ok: false, reason: "too_many_tasks" };
  const tasks = [];
  for (const t of plan.tasks) {
    if (!t || typeof t !== "object" || Array.isArray(t)) return { ok: false, reason: "task_not_object" };
    if (typeof t.skill !== "string" || !t.skill) return { ok: false, reason: "task_missing_skill" };
    if (typeof t.input !== "string") return { ok: false, reason: "task_missing_input" };
    if (!registry.getSkill(t.skill)) return { ok: false, reason: `unknown_skill:${t.skill}` };
    tasks.push({ skill: t.skill, input: t.input, reason: typeof t.reason === "string" ? t.reason : "" });
  }
  return { ok: true, tasks };
}

export function createManagerAgent({
  llm,
  registry,
  appendEvent = async () => {},
  saveRun = async () => {},
  now = () => Date.now(),
  maxTasks = 3,
  subAgents = {},
  idFactory = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (!llm) throw new Error("createManagerAgent 需要 llm");
  if (!registry) throw new Error("createManagerAgent 需要 registry");

  async function run(intent, ctx = {}) {
    if (typeof intent !== "string" || !intent.trim()) return { ok: false, reason: "empty_intent" };
    if (!registry.loaded) return { ok: false, reason: "registry_not_loaded" };

    const id = idFactory();
    const t0 = now();
    const emit = (kind, payload) => appendEvent(`agent:${kind}`, { runId: id, ...payload });

    await emit("agent_start", { intent });
    await emit("turn_start", { turn: 1 });

    const skills = registry
      .list()
      .map((s) => `- ${s.name} (${s.class}): ${s.description}`)
      .join("\n");
    const prompt = registry.render("manager-plan", {
      intent,
      now: new Date(now()).toISOString(),
      skills,
    });

    let raw;
    try {
      const res = await llm.complete({
        messages: [
          { role: "system", content: "你是严格 JSON 输出器，只输出 JSON。" },
          { role: "user", content: prompt },
        ],
        json: true,
        maxTokens: 400,
        temperature: 0.2,
        cls: "work",
        kind: "manager",
      });
      raw = res.text;
    } catch (err) {
      await emit("agent_end", { ok: false, reason: "llm_failed", msg: err.message });
      await saveRun({ id, intent, ts: t0, ok: false, reason: "llm_failed", tasks: [] });
      return { ok: false, id, reason: "llm_failed" };
    }

    await emit("message_end", { role: "assistant", text: String(raw).slice(0, 2000) });

    const plan = validatePlan(raw, registry, maxTasks);
    if (!plan.ok) {
      await emit("plan_rejected", { reason: plan.reason, raw: String(raw).slice(0, 500) });
      await emit("agent_end", { ok: false, reason: plan.reason });
      await saveRun({ id, intent, ts: t0, ok: false, reason: plan.reason, tasks: [] });
      return { ok: false, id, reason: plan.reason };
    }

    const results = [];
    for (const task of plan.tasks) {
      const skill = registry.getSkill(task.skill);
      const started = now();
      await emit("tool_execution_start", { tool: task.skill, input: task.input });
      try {
        let output;
        const sub = subAgents[task.skill];
        if (sub) {
          const r = await sub({ input: task.input, intent, ctx });
          if (!r.ok) throw new Error(r.reason || "subagent_failed");
          output = r.text ?? r.output;
        } else {
          const text = registry.render(skill.prompt, {
            ...ctx,
            intent,
            input: task.input,
            now: new Date(now()).toISOString(),
            place: ctx.place ?? "",
            mood: ctx.mood ?? "",
            period: ctx.period ?? "",
            recent: ctx.recent ?? "（无）",
          });
          const res = await llm.complete({
            messages: [{ role: "user", content: text }],
            maxTokens: skill.maxTokens,
            temperature: skill.temperature,
            json: skill.output === "json",
            cls: skill.class,
            kind: skill.name,
          });
          output = res.text;
          if (skill.output === "json") {
            const parsed = extractJson(output);
            if (!parsed) throw new Error("invalid_json_output");
            output = parsed;
          }
        }
        const ms = now() - started;
        results.push({ skill: task.skill, input: task.input, ok: true, output, ms });
        await emit("tool_execution_end", { tool: task.skill, ok: true, ms });
      } catch (err) {
        const ms = now() - started;
        results.push({ skill: task.skill, input: task.input, ok: false, error: err.message, ms });
        await emit("tool_execution_end", { tool: task.skill, ok: false, error: err.message, ms });
      }
    }

    const ok = results.every((r) => r.ok);
    await emit("turn_end", { ok });
    await emit("agent_end", { ok, tasks: results.length });
    await saveRun({ id, intent, ts: t0, ok, plan: plan.tasks, tasks: results });
    return { ok, id, tasks: results };
  }

  return { run };
}
