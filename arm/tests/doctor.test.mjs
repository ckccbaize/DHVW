import test from "node:test";
import assert from "node:assert/strict";

import { createDoctor, DOCTOR_ACTIONS, parseDiagnosis, runChecks } from "../www/js/core/doctor.js";
import { createRegistryFromData } from "../www/js/core/agent/registry.js";

test("runChecks：常见异常", () => {
  const issues = runChecks({
    governor: { tier: "P2" },
    sched: { failed: 9 },
    log: { dropped: 200, lastSeq: 1000 },
    sync: { ackedSeq: 100 },
    budget: { softAlert: true, outTokens: 60000 },
    memory: { count: 0 },
    wake: { noResponseStreak: 4 },
    llm: { stats: { failed: 5 } },
    wakeRuntime: { events: 60 },
  });
  const codes = issues.map((i) => i.code);
  for (const c of ["governor_tier", "sched_failed", "log_dropped", "sync_lag", "budget_soft", "memory_empty", "wake_streak", "llm_failed", "wake_events"]) {
    assert.ok(codes.includes(c), c);
  }
  assert.deepEqual(runChecks({ governor: { tier: "P4" }, sched: { failed: 0 } }), []);
});

test("parseDiagnosis：白名单与坏 JSON", () => {
  const r = parseDiagnosis(
    JSON.stringify({
      diagnosis: "事件积压",
      actions: [{ type: "clear_event_log" }, { type: "rm -rf /" }, { type: "pause_agent" }],
      safeMode: true,
    }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.actions.map((a) => a.type), ["clear_event_log", "pause_agent"]);
  assert.deepEqual(r.rejected, ["rm -rf /"]);
  assert.equal(r.safeMode, true);
  assert.equal(parseDiagnosis("nope").reason, "not_object");
  assert.equal(DOCTOR_ACTIONS.has("exec_shell"), false);
});

const registry = createRegistryFromData({
  version: 1,
  skills: {
    doctor: { name: "doctor", description: "诊断", class: "work", prompt: "doctor", maxTokens: 400, temperature: 0.2, tools: [], output: "json", body: "" },
  },
  prompts: { doctor: "{{issues}} {{state}} {{logs}}" },
});

function scripted(texts) {
  const calls = [];
  return {
    calls,
    async complete(opts) {
      calls.push(opts);
      return { text: texts[Math.min(calls.length - 1, texts.length - 1)] };
    },
  };
}

test("doctor：发现问题 → 诊断 → 执行白名单动作", async () => {
  const llm = scripted([
    JSON.stringify({
      diagnosis: "记忆为空，先保存快照",
      actions: [{ type: "snapshot_save" }, { type: "enter_safe_mode" }],
    }),
  ]);
  const applied = [];
  const doctor = createDoctor({
    llm,
    registry,
    getSnapshot: () => ({ memory: { count: 0 }, logs: [] }),
    applyAction: async (type) => applied.push(type),
    now: () => 1,
  });
  const r = await doctor.check();
  assert.equal(r.issues.length, 1);
  assert.equal(r.diagnosis.ok, true);
  assert.deepEqual(applied, ["snapshot_save", "enter_safe_mode"]);
  assert.equal(doctor.state.safeMode, true);
});

test("doctor：无问题时不动 LLM", async () => {
  const llm = scripted(["{}"]);
  const doctor = createDoctor({ llm, registry, getSnapshot: () => ({ memory: { count: 3 } }) });
  const r = await doctor.check();
  assert.deepEqual(r.issues, []);
  assert.equal(llm.calls.length, 0);
});
