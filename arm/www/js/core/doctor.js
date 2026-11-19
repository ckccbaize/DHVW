// Doctor（W32）：周期自检 → 日志交 LLM 诊断 → 只执行白名单动作 → 安全模式。
import { extractJson } from "./agent/json.js";

export const DOCTOR_ACTIONS = new Set([
  "clear_event_log",
  "trim_memory",
  "pause_agent",
  "resume_agent",
  "reset_budget",
  "enter_safe_mode",
  "exit_safe_mode",
  "snapshot_save",
]);

export function runChecks(s = {}) {
  const issues = [];
  const add = (level, code, msg) => issues.push({ level, code, msg });

  if (s.governor?.tier && s.governor.tier !== "P4") add("warn", "governor_tier", `档位 ${s.governor.tier}`);
  if ((s.sched?.failed || 0) > 5) add("error", "sched_failed", `调度失败 ${s.sched.failed}`);
  if ((s.log?.dropped || 0) > 100) add("warn", "log_dropped", `事件丢弃 ${s.log.dropped}`);
  if (s.sync && s.log && s.log.lastSeq - s.sync.ackedSeq > 500) {
    add("warn", "sync_lag", `未确认事件 ${s.log.lastSeq - s.sync.ackedSeq}`);
  }
  if (s.budget?.softAlert) add("info", "budget_soft", `日输出 ${s.budget.outTokens}`);
  if (s.memory && s.memory.count === 0) add("warn", "memory_empty", "本地记忆为空");
  if ((s.wake?.noResponseStreak || 0) >= 3) add("info", "wake_streak", `连续无回应 ${s.wake.noResponseStreak}`);
  if ((s.llm?.stats?.failed || 0) > 3) add("warn", "llm_failed", `LLM 失败 ${s.llm.stats.failed}`);
  if ((s.wakeRuntime?.events || 0) > 50) add("warn", "wake_events", `世界事件积压 ${s.wakeRuntime.events}`);
  return issues;
}

export function parseDiagnosis(text) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, reason: "not_object" };
  const actions = [];
  const rejected = [];
  for (const a of Array.isArray(obj.actions) ? obj.actions : []) {
    const type = a && typeof a.type === "string" ? a.type : "";
    if (!DOCTOR_ACTIONS.has(type)) {
      rejected.push(type || "unknown");
      continue;
    }
    actions.push({ type, args: a.args && typeof a.args === "object" ? a.args : {} });
  }
  return {
    ok: true,
    diagnosis: typeof obj.diagnosis === "string" ? obj.diagnosis : "",
    actions: actions.slice(0, 3),
    rejected,
    safeMode: !!obj.safeMode,
  };
}

export function createDoctor({
  llm,
  registry,
  getSnapshot = () => ({}),
  applyAction = async () => {},
  now = () => Date.now(),
  maxActions = 3,
} = {}) {
  let last = null;
  let safeMode = false;
  let running = false;

  async function diagnose(issues) {
    if (!llm || !registry) return { ok: false, reason: "not_configured" };
    const skill = registry.getSkill("doctor");
    if (!skill) return { ok: false, reason: "skill_missing" };
    const snap = getSnapshot();
    const prompt = registry.render("doctor", {
      issues: JSON.stringify(issues),
      state: JSON.stringify({
        governor: snap.governor,
        sched: snap.sched,
        log: snap.log,
        sync: snap.sync,
        budget: snap.budget,
        memory: snap.memory,
        wake: snap.wake,
        llm: snap.llm?.stats,
      }),
      logs: JSON.stringify((snap.logs || []).slice(-20)),
    });
    let res;
    try {
      res = await llm.complete({
        messages: [{ role: "user", content: prompt }],
        json: true,
        maxTokens: skill.maxTokens,
        temperature: skill.temperature,
        cls: "work",
        kind: "doctor",
      });
    } catch (err) {
      return { ok: false, reason: "llm_failed", error: err.message };
    }
    const parsed = parseDiagnosis(res.text);
    if (!parsed.ok) return parsed;
    const applied = [];
    for (const a of parsed.actions.slice(0, maxActions)) {
      try {
        await applyAction(a.type, a.args);
        applied.push(a.type);
        if (a.type === "enter_safe_mode") safeMode = true;
        if (a.type === "exit_safe_mode") safeMode = false;
      } catch (err) {
        applied.push(`${a.type}:failed:${err.message}`);
      }
    }
    if (parsed.safeMode) {
      await applyAction("enter_safe_mode", {});
      applied.push("enter_safe_mode");
      safeMode = true;
    }
    return { ok: true, diagnosis: parsed.diagnosis, applied, rejected: parsed.rejected };
  }

  return {
    async check() {
      if (running) return { ok: false, reason: "busy" };
      running = true;
      try {
        const issues = runChecks(getSnapshot());
        const out = { at: now(), issues, diagnosis: null };
        if (issues.length) out.diagnosis = await diagnose(issues);
        last = out;
        return out;
      } finally {
        running = false;
      }
    },
    get state() {
      return { safeMode, last };
    },
    setSafeMode(on) {
      safeMode = !!on;
    },
  };
}
