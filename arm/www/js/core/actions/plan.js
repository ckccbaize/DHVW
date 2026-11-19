// 行为挑选（W27）：时段 + 冷却 + 心情权重，伪随机。
import { MOOD_BASE } from "../machine/life.js";

export function moodFit(behavior, mood = {}) {
  const m = { ...MOOD_BASE, ...mood };
  let w = 1;
  switch (behavior.kind) {
    case "travel":
      w *= 1 + (1 - m.social) * 0.8 + (1 - m.valence) * 0.5;
      break;
    case "network":
      w *= 1 + m.focus * 0.8;
      break;
    case "rest":
      w *= 1 + (1 - m.energy) * 1.2;
      break;
    case "home":
      w *= 1 + (1 - m.energy) * 0.3;
      break;
    default:
      break;
  }
  return w;
}

export function pickBehavior({
  registry,
  now = Date.now(),
  mood = {},
  recent = [],
  network = false,
  random = Math.random,
} = {}) {
  const hour = new Date(now).getHours();
  const lastAt = new Map();
  for (const r of recent) lastAt.set(r.id, Math.max(lastAt.get(r.id) || 0, r.at || 0));

  const pool = registry.list().filter((b) => {
    if (!b.hours.includes(hour)) return false;
    if (b.requires?.network && !network) return false;
    const last = lastAt.get(b.id);
    if (last && now - last < (b.cooldownMin || 0) * 60_000) return false;
    return true;
  });
  if (!pool.length) return null;

  const weights = pool.map((b) => Math.max(0.01, b.weight * moodFit(b, mood)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return { behavior: pool[i], weight: weights[i], candidates: pool.length };
  }
  return { behavior: pool[pool.length - 1], weight: weights[weights.length - 1], candidates: pool.length };
}
