// 记忆管线（W23）：事件预筛 → LLM 归纳 → 事实 → 本地记忆 + PC 候选。
import { extractJson } from "../agent/json.js";

const EXCLUDE = new Set([
  "debug",
  "core_ready",
  "governor:tier",
  "doctor:action",
  "wake:silent",
  "heartbeat",
]);

export function prefilter(events = [], { limit = 40 } = {}) {
  return events
    .filter((e) => e && e.kind && !EXCLUDE.has(e.kind))
    .slice(-limit);
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function validateFacts(facts = []) {
  const out = [];
  const rejected = [];
  for (const f of facts) {
    const text = String(f?.text || "").trim();
    if (text.length < 10 || text.length > 120) {
      rejected.push({ text: text.slice(0, 20), reason: "bad_length" });
      continue;
    }
    out.push({ text, tier: f.tier === "L1" ? "L1" : "L2" });
  }
  return { facts: out, rejected };
}

const norm = (s) => String(s || "").replace(/[\s\p{P}\p{S}]+/gu, "");

function grams(s) {
  const out = new Set();
  const chars = [...s];
  if (chars.length < 2) return out;
  for (let i = 0; i < chars.length - 1; i++) out.add(chars[i] + chars[i + 1]);
  return out;
}

function similar(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 6 || y.length < 6) return false;
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const g of gx) if (gy.has(g)) hit += 1;
  return hit / Math.max(gx.size, gy.size) >= 0.9;
}

export function createMemoryPipeline({
  llm,
  registry,
  localMemory,
  sendCandidates = () => {},
  now = () => Date.now(),
  seen = new Set(),
} = {}) {
  if (!llm) throw new Error("createMemoryPipeline 需要 llm");
  if (!registry) throw new Error("createMemoryPipeline 需要 registry");

  async function run(events = []) {
    const selected = prefilter(events);
    if (selected.length < 3) return { ok: false, reason: "not_enough_events", count: selected.length };
    const skill = registry.getSkill("memory-summarize");
    if (!skill) return { ok: false, reason: "skill_missing" };
    const existing = localMemory ? localMemory.search("", { k: 5 }).map((h) => h.text) : [];
    const prompt = registry.render("memory-summarize", {
      events: JSON.stringify(
        selected.map((e) => ({ kind: e.kind, payload: e.payload, t: e.t_local })),
      ),
      existing: JSON.stringify(existing.slice(0, 10)),
    });
    let res;
    try {
      res = await llm.complete({
        messages: [{ role: "user", content: prompt }],
        json: true,
        maxTokens: skill.maxTokens,
        temperature: skill.temperature,
        cls: "work",
        kind: "memory-summarize",
      });
    } catch (err) {
      return { ok: false, reason: "llm_failed", error: err.message };
    }
    const obj = extractJson(res.text);
    if (!obj || !Array.isArray(obj.facts)) return { ok: false, reason: "invalid_json" };
    const { facts, rejected } = validateFacts(obj.facts);
    const accepted = [];
    const known = localMemory ? localMemory.all() : [];
    for (const f of facts) {
      const key = fnv1a(f.text.replace(/\s+/g, ""));
      if (seen.has(key)) continue;
      if (known.some((d) => similar(d.text, f.text))) continue;
      seen.add(key);
      const doc = { id: `fact-${key}`, text: f.text, t: now(), tier: f.tier, meta: { source: "pipeline" } };
      if (localMemory) await localMemory.add(doc);
      known.push(doc);
      accepted.push(doc);
    }
    if (localMemory && localMemory.count > 200) {
      const all = localMemory.all().sort((a, b) => a.t - b.t);
      for (const d of all.slice(0, localMemory.count - 200)) await localMemory.remove(d.id);
    }
    if (accepted.length) sendCandidates({ facts: accepted, events: selected.slice(-20) });
    return { ok: true, facts: accepted, rejected, scanned: selected.length };
  }

  return { run, seen };
}
