// 自主行为池（W27）：能力白名单 + 可扩展注册表。
// 行为只描述"能做什么"，执行由核心机按类型分派（出门/上网/居家）。

export const BEHAVIOR_KINDS = new Set(["travel", "network", "home", "rest"]);
export const EFFECT_DIMS = new Set(["energy", "valence", "social", "focus"]);

export const BUILTIN_BEHAVIORS = [
  { id: "outing", name: "出门转转", kind: "travel", weight: 1.2, cooldownMin: 180, hours: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], effects: { valence: 0.06 }, requires: {} },
  { id: "browse", name: "上网看看", kind: "network", weight: 0.9, cooldownMin: 100, hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], effects: { focus: 0.04 }, requires: { network: true } },
  { id: "cook", name: "做点吃的", kind: "home", weight: 1.0, cooldownMin: 240, hours: [7, 8, 11, 12, 17, 18, 19], effects: { energy: 0.08, valence: 0.05 } },
  { id: "read", name: "看书", kind: "home", weight: 1.0, cooldownMin: 90, hours: [8, 9, 10, 14, 15, 16, 20, 21, 22], effects: { focus: 0.08 } },
  { id: "tidy", name: "收拾屋子", kind: "home", weight: 0.8, cooldownMin: 180, hours: [9, 10, 11, 15, 16, 17], effects: { focus: 0.05, energy: -0.05 } },
  { id: "plants", name: "浇花", kind: "home", weight: 0.6, cooldownMin: 360, hours: [7, 8, 9, 16, 17, 18], effects: { valence: 0.04 } },
  { id: "music", name: "听歌", kind: "home", weight: 0.7, cooldownMin: 60, hours: [9, 10, 14, 15, 20, 21, 22], effects: { valence: 0.05 } },
  { id: "nap", name: "打个盹", kind: "rest", weight: 0.5, cooldownMin: 300, hours: [13, 14, 15, 22, 23], effects: { energy: 0.12 } },
];

export function validateBehavior(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "not_object";
  if (typeof b.id !== "string" || !/^[a-z][a-z0-9_-]{1,23}$/.test(b.id)) return "bad_id";
  if (typeof b.name !== "string" || b.name.trim().length < 2 || b.name.length > 20) return "bad_name";
  if (!BEHAVIOR_KINDS.has(b.kind)) return "bad_kind";
  if (!Number.isFinite(b.weight) || b.weight <= 0 || b.weight > 5) return "bad_weight";
  if (!Number.isFinite(b.cooldownMin) || b.cooldownMin < 0 || b.cooldownMin > 1440) return "bad_cooldown";
  if (!Array.isArray(b.hours) || !b.hours.length || b.hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) return "bad_hours";
  if (b.effects !== undefined) {
    if (!b.effects || typeof b.effects !== "object" || Array.isArray(b.effects)) return "bad_effects";
    for (const [k, v] of Object.entries(b.effects)) {
      if (!EFFECT_DIMS.has(k)) return `bad_effect_dim:${k}`;
      if (!Number.isFinite(v) || Math.abs(v) > 0.3) return `bad_effect_delta:${k}`;
    }
  }
  if (b.requires !== undefined && (typeof b.requires !== "object" || Array.isArray(b.requires))) return "bad_requires";
  return null;
}

export function createBehaviorRegistry({ custom = [] } = {}) {
  const map = new Map();
  for (const b of BUILTIN_BEHAVIORS) map.set(b.id, { ...b, source: "builtin" });
  for (const b of custom) {
    if (validateBehavior(b) === null) map.set(b.id, { ...b, source: "custom" });
  }

  return {
    get(id) {
      return map.get(id) || null;
    },
    list() {
      return [...map.values()];
    },
    register(def) {
      const reason = validateBehavior(def);
      if (reason) return { ok: false, reason };
      map.set(def.id, { ...def, source: "custom" });
      return { ok: true, behavior: map.get(def.id) };
    },
    remove(id) {
      const b = map.get(id);
      if (!b || b.source === "builtin") return false;
      return map.delete(id);
    },
    custom() {
      return [...map.values()].filter((b) => b.source === "custom");
    },
  };
}
