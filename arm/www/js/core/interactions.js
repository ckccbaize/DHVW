// 交互层：interactions.json 的注册、条件解析、效果应用。
// 纯函数，设备只执行数据；不在代码里写死 prop→act。

export const EFFECT_KINDS = new Set([
  "mood", "set_flag", "clear_flag", "advance_time", "event",
  "produce_artifact", "travel", "say", "door",
]);
export const REQUIRE_KINDS = new Set([
  "place", "time", "weather", "mood", "flag", "prop_state", "network", "budget", "cooldown",
]);

const clockMinutes = (text) => {
  const m = String(text || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Math.max(0, Math.min(1439, Number(m[1]) * 60 + Number(m[2])));
};

export function createInteractionRegistry(interactions) {
  const errors = [];
  const acts = interactions?.acts;
  if (!interactions || interactions.schema_version !== 1) errors.push("schema_version");
  if (!acts || typeof acts !== "object") errors.push("acts");
  const byProp = new Map();
  if (!errors.length) {
    for (const [id, def] of Object.entries(acts)) {
      if (!def?.label) errors.push(`${id}.label`);
      if (!Array.isArray(def?.trigger?.props) || !def.trigger.props.length) errors.push(`${id}.trigger.props`);
      const anim = def?.perform?.animation;
      if (!anim) errors.push(`${id}.perform.animation`);
      const dur = Number(def?.perform?.duration_min);
      if (!Number.isFinite(dur) || dur < 1 || dur > 1440) errors.push(`${id}.duration_min`);
      for (const e of def?.effects || []) if (!EFFECT_KINDS.has(e.kind)) errors.push(`${id}.effect.${e.kind}`);
      for (const r of def?.requires || []) if (!REQUIRE_KINDS.has(r.kind)) errors.push(`${id}.require.${r.kind}`);
      for (const prop of def?.trigger?.props || []) {
        if (!byProp.has(prop)) byProp.set(prop, []);
        byProp.get(prop).push(id);
      }
    }
  }
  return { ok: errors.length === 0, errors, acts: acts || {}, byProp };
}

function checkRequires(reqs, state) {
  for (const r of reqs || []) {
    if (r.kind === "place") {
      if (!r.in?.includes(state.place)) return false;
    } else if (r.kind === "time") {
      const [a, b] = r.between || [];
      const start = clockMinutes(a);
      const end = clockMinutes(b);
      const now = Number(state.minute ?? 0);
      if (start == null || end == null) return false;
      const inside = start <= end ? now >= start && now < end : now >= start || now < end;
      if (!inside) return false;
    } else if (r.kind === "weather") {
      if (!r.in?.includes(state.weather)) return false;
    } else if (r.kind === "flag") {
      if (!state.flags?.[r.name]) return false;
    } else if (r.kind === "mood") {
      const v = Number(state.mood?.[r.target] ?? 0);
      if (r.min != null && v < r.min) return false;
      if (r.max != null && v > r.max) return false;
    } else if (r.kind === "cooldown") {
      const until = Number(state.cooldowns?.[r.name] ?? 0);
      if (Number(state.minute ?? 0) < until) return false;
    }
  }
  return true;
}

export function resolveInteraction({ registry, prop, act, state = {} }) {
  const ids = act ? [act] : registry.byProp.get(prop) || [];
  const candidates = [];
  for (const id of ids) {
    const def = registry.acts[id];
    if (!def) continue;
    if (prop && !def.trigger?.props?.includes(prop)) continue;
    if (!checkRequires(def.requires, state)) continue;
    candidates.push({ id, def, score: Number(def.priority ?? 5) });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

export function applyEffects(effects, state = {}) {
  const next = {
    ...state,
    mood: { ...(state.mood || {}) },
    flags: { ...(state.flags || {}) },
    cooldowns: { ...(state.cooldowns || {}) },
  };
  const events = [];
  for (const e of effects || []) {
    if (e.kind === "mood") {
      const target = e.target;
      const delta = Number(e.delta || 0);
      next.mood[target] = Math.max(-1, Math.min(1, Number(next.mood[target] || 0) + delta));
    } else if (e.kind === "set_flag") {
      next.flags[e.name] = true;
    } else if (e.kind === "clear_flag") {
      delete next.flags[e.name];
    } else if (e.kind === "advance_time") {
      next.minute = Number(next.minute || 0) + Number(e.minutes || 0);
    } else if (e.kind === "event") {
      events.push({ kind: "event", name: e.name, payload: e.payload || {} });
    } else if (e.kind === "say") {
      events.push({ kind: "say", text: e.text, ttl: e.ttl || 2600 });
    } else if (e.kind === "door") {
      next.flags[`door_${e.open ? "open" : "closed"}`] = true;
    }
  }
  return { state: next, events };
}
