// 设备档唤醒运行时（W26）：严格 JSON、三结局、world_event 租约、线头上限、residue。
// 协议事实见 skill dhvw-waketrace-protocol-facts；格式错误 = 失败，不能冒充 silent。

import { extractJson } from "../agent/json.js";

export const OUTCOMES = new Set(["silent", "trace", "message"]);

export function parseWakeJson(text) {
  const obj = extractJson(text);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, reason: "not_object" };
  if (!OUTCOMES.has(obj.outcome)) return { ok: false, reason: "bad_outcome" };
  if (typeof obj.fact !== "string" || !obj.fact.trim()) return { ok: false, reason: "missing_fact" };
  if (obj.fact.length > 200) return { ok: false, reason: "fact_too_long" };
  if (typeof obj.content !== "string" || !obj.content.trim()) return { ok: false, reason: "missing_content" };
  if (obj.outcome === "message" && (typeof obj.share !== "string" || !obj.share.trim())) {
    return { ok: false, reason: "message_without_share" };
  }
  if (obj.outcome === "silent" && typeof obj.share === "string" && obj.share.trim()) {
    return { ok: false, reason: "silent_with_share" };
  }
  if (typeof obj.share === "string" && obj.share.length > 40) return { ok: false, reason: "share_too_long" };
  if (obj.residue !== undefined && typeof obj.residue !== "string") return { ok: false, reason: "bad_residue" };
  const nw = obj.next_wake;
  if (!nw || typeof nw !== "object" || Array.isArray(nw)) return { ok: false, reason: "missing_next_wake" };
  if (!Number.isFinite(nw.min_minutes) || !Number.isFinite(nw.max_minutes)) {
    return { ok: false, reason: "bad_next_wake" };
  }
  if (nw.min_minutes < 1 || nw.max_minutes < nw.min_minutes) return { ok: false, reason: "bad_next_wake" };
  return {
    ok: true,
    wake: {
      outcome: obj.outcome,
      fact: obj.fact.trim(),
      content: obj.content.trim(),
      share: typeof obj.share === "string" ? obj.share.trim() : "",
      residue: typeof obj.residue === "string" ? obj.residue.trim() : "",
      next_wake: { min_minutes: nw.min_minutes, max_minutes: nw.max_minutes, reason: String(nw.reason || "") },
      thread: typeof obj.thread === "string" ? obj.thread.trim() : "",
      artifact: obj.artifact && typeof obj.artifact === "object" ? obj.artifact : null,
    },
  };
}

export function clampNextWake(nw, { minMinutes = 45, maxMinutes = 90 } = {}) {
  const clamp = (v) => Math.min(maxMinutes, Math.max(minMinutes, Math.round(v)));
  let min = clamp(nw.min_minutes);
  let max = clamp(nw.max_minutes);
  if (max < min) max = min;
  return { min, max, reason: nw.reason || "" };
}

export function createWakeRuntime({
  llm,
  registry,
  now = () => Date.now(),
  config = {},
  store = null,
  lock = null,
} = {}) {
  if (!llm) throw new Error("createWakeRuntime 需要 llm");
  if (!registry) throw new Error("createWakeRuntime 需要 registry");
  const cfg = { minMinutes: 45, maxMinutes: 90, leaseMs: 15 * 60_000, threadCap: 5, residueTtlMs: 6 * 3600_000, ...config };
  let state = { events: [], threads: [], residue: null, lastWakeAt: 0, nextWakeAt: 0, wakes: 0 };
  let locked = false;
  let lockRelease = null;

  async function persist() {
    if (store) await store.put("wake_runtime", state);
  }

  function claimEvent(ts) {
    const ev = state.events.find((e) => (e.dueAt || 0) <= ts && (!e.leaseUntil || e.leaseUntil < ts));
    if (!ev) return null;
    ev.leaseUntil = ts + cfg.leaseMs;
    ev.attempts = (ev.attempts || 0) + 1;
    void persist();
    return ev;
  }

  function releaseEvent(id) {
    const ev = state.events.find((e) => e.id === id);
    if (ev) ev.leaseUntil = 0;
    void persist();
  }

  function completeEvent(id) {
    state.events = state.events.filter((e) => e.id !== id);
    void persist();
  }

  function activeThreads(ts) {
    return state.threads.filter((t) => !t.closedAt && (!t.resurfaceAt || t.resurfaceAt <= ts || t.open));
  }

  async function acquire() {
    if (lock && typeof lock.request === "function") {
      return await new Promise((resolve) => {
        lock.request("dhvw-wake", async (held) => {
          if (!held) {
            resolve(false);
            return;
          }
          resolve(true);
          await new Promise((r) => {
            lockRelease = r;
          });
        }).catch(() => resolve(false));
      });
    }
    if (locked) return false;
    locked = true;
    return true;
  }

  function release() {
    if (lockRelease) {
      const r = lockRelease;
      lockRelease = null;
      r();
    }
    locked = false;
  }

  function residueView() {
    const r = state.residue;
    if (!r) return null;
    if (r.expiresAt && r.expiresAt < now()) return null;
    return { ...r };
  }

  return {
    async init() {
      if (store) {
        const saved = await store.get("wake_runtime");
        if (saved && typeof saved === "object") state = { ...state, ...saved };
      }
      return this.state;
    },
    get state() {
      return { ...state, threads: state.threads.map((t) => ({ ...t })) };
    },
    addEvent({ id, dueAt = 0, text = "", payload = {} } = {}) {
      if (!id) return { ok: false, reason: "missing_id" };
      state.events.push({ id, dueAt, text, payload, attempts: 0, leaseUntil: 0 });
      void persist();
      return { ok: true, count: state.events.length };
    },
    addThread({ text = "" } = {}) {
      if (!text) return { ok: false, reason: "missing_text" };
      if (state.threads.filter((t) => !t.closedAt).length >= cfg.threadCap) {
        return { ok: false, reason: "thread_cap" };
      }
      const t = { id: `th-${now().toString(36)}-${state.threads.length}`, text, openedAt: now(), closedAt: 0 };
      state.threads.push(t);
      void persist();
      return { ok: true, thread: t };
    },
    listEvents() {
      return state.events.map((e) => ({ ...e }));
    },
    threads() {
      return state.threads.map((t) => ({ ...t }));
    },
    residue: residueView,
    async run({ context = {}, toolEvidence = null } = {}) {
      const ts = now();
      if (!(await acquire())) return { ok: false, reason: "wake_locked" };
      try {
        const ev = claimEvent(ts);
        const seed = ev
          ? { kind: "world_event", id: ev.id, text: ev.text, payload: ev.payload }
          : { kind: "free_window", day: new Date(ts).toISOString().slice(0, 10), hour: new Date(ts).getHours() };
        const skill = registry.getSkill("wake");
        if (!skill) return { ok: false, reason: "skill_missing" };
        const prompt = registry.render("wake", {
          seed: JSON.stringify(seed),
          context: JSON.stringify(context),
          threads: JSON.stringify(activeThreads(ts).map((t) => t.text)),
          residue: residueView()?.text || "",
        });
        let res;
        try {
          res = await llm.complete({
            messages: [{ role: "user", content: prompt }],
            json: true,
            maxTokens: skill.maxTokens,
            temperature: skill.temperature,
            cls: "character",
            kind: "wake",
          });
        } catch (err) {
          if (ev) releaseEvent(ev.id);
          return { ok: false, reason: "llm_failed", error: err.message };
        }
        const parsed = parseWakeJson(res.text);
        if (!parsed.ok) {
          if (ev) releaseEvent(ev.id);
          return { ok: false, reason: parsed.reason };
        }
        const wake = parsed.wake;
        if (wake.artifact && !toolEvidence) {
          if (ev) releaseEvent(ev.id);
          return { ok: false, reason: "artifact_without_evidence" };
        }
        const nw = clampNextWake(wake.next_wake, cfg);
        if (wake.thread) {
          const open = state.threads.filter((t) => !t.closedAt);
          if (open.length >= cfg.threadCap) {
            if (ev) releaseEvent(ev.id);
            return { ok: false, reason: "thread_cap" };
          }
          state.threads.push({ id: `th-${ts.toString(36)}`, text: wake.thread, openedAt: ts, closedAt: 0 });
        }
        if (wake.residue) {
          state.residue = { text: wake.residue, at: ts, expiresAt: ts + cfg.residueTtlMs };
        }
        if (ev) completeEvent(ev.id);
        state.lastWakeAt = ts;
        state.wakes += 1;
        state.nextWakeAt = ts + Math.round((nw.min + nw.max) / 2) * 60_000;
        await persist();
        return { ok: true, wake, seed: seed.kind, nextWake: nw, threadCount: state.threads.filter((t) => !t.closedAt).length };
      } finally {
        release();
      }
    },
    async closeThread(id) {
      const t = state.threads.find((x) => x.id === id);
      if (!t) return false;
      t.closedAt = now();
      await persist();
      return true;
    },
    async clear() {
      state = { events: [], threads: [], residue: null, lastWakeAt: 0, nextWakeAt: 0, wakes: 0 };
      await persist();
    },
  };
}
