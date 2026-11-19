// forge.worker：端侧轻资产生成（M11-T17/T18/T19/T20 / PROJECT-PLAN §10.7.3）。
// 剧情文法 + 背景 Canvas 合成 + 场景光照变体。0 token / 0 GPU / 0 网络（除读本地资源包）。
// 单任务切片 ≤5s，片间检查让位标志；挂起时队列保留不丢。

import { generatePlot } from "../js/forge/grammar.js";

let suspended = false;
let busy = false;
let queue = [];
let recentPlots = []; // 24h 内已产出的剧情文本

const LIGHT_PALETTE = {
  dawn: { top: "#2f3a55", mid: "#8f6f7a", bot: "#e8a06a", tint: "rgba(255,180,120,0.20)", sun: "#ffd9a0" },
  day: { top: "#7fb4c9", mid: "#b6d3d9", bot: "#dfe9ec", tint: "rgba(255,240,210,0.06)", sun: "#fff3cf" },
  dusk: { top: "#3a2f4a", mid: "#8a5a6a", bot: "#e08a5a", tint: "rgba(255,140,90,0.22)", sun: "#ffb27a" },
  night: { top: "#0d1526", mid: "#1b2740", bot: "#243352", tint: "rgba(90,120,220,0.30)", sun: "#dfe8ff" },
  rain: { top: "#3d4a55", mid: "#5d6b76", bot: "#8a9aa5", tint: "rgba(120,150,180,0.22)", sun: "#c9d6e0" },
  snow: { top: "#c9d6e0", mid: "#dde7ee", bot: "#eef3f7", tint: "rgba(230,240,255,0.30)", sun: "#ffffff" },
};

function emit(msg) {
  self.postMessage(msg);
}

/** 让出主线程：切片用。挂起时抛错，任务留在队列里等 resume 重跑。 */
const yieldTick = async () => {
  await new Promise((r) => setTimeout(r, 0));
  if (suspended) throw new Error("suspended");
};

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

async function toBlob(canvas) {
  const blob = await new Promise((res) => canvas.convertToBlob({ type: "image/webp", quality: 0.82 }).then(res, () => null));
  if (blob) return blob;
  return canvas.convertToBlob({ type: "image/png" });
}

/** 闸门：非单色（亮度方差）+ 尺寸。 */
function imageGate(canvas, minVar = 6) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const stepX = Math.max(1, Math.floor(width / 32));
  const stepY = Math.max(1, Math.floor(height / 18));
  const data = ctx.getImageData(0, 0, width, height).data;
  let n = 0;
  let sum = 0;
  let sum2 = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const i = (y * width + x) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      sum2 += lum * lum;
      n += 1;
    }
  }
  const mean = sum / n;
  const variance = sum2 / n - mean * mean;
  if (variance < minVar) return { ok: false, reason: `flat:${variance.toFixed(1)}` };
  return { ok: true, mean, variance };
}

/** 背景合成：天空 → 远景 → 建筑 → 地面 → 天气 → 暗角。960×540。 */
async function composeBackground(ctx) {
  const W = 960;
  const H = 540;
  const light = LIGHT_PALETTE[ctx.light] || LIGHT_PALETTE.day;
  const seed = hashStr(`${ctx.seed}|bg|${ctx.light}`);
  const rand = rng(seed);

  const canvas = new OffscreenCanvas(W, H);
  const c = canvas.getContext("2d");

  const sky = c.createLinearGradient(0, 0, 0, H * 0.72);
  sky.addColorStop(0, light.top);
  sky.addColorStop(0.55, light.mid);
  sky.addColorStop(1, light.bot);
  c.fillStyle = sky;
  c.fillRect(0, 0, W, H);
  await yieldTick();

  // 太阳/月亮
  const sunX = W * (0.18 + rand() * 0.64);
  const sunY = H * (0.16 + rand() * 0.18);
  c.fillStyle = light.sun;
  c.globalAlpha = 0.85;
  c.beginPath();
  c.arc(sunX, sunY, 34, 0, Math.PI * 2);
  c.fill();
  c.globalAlpha = 1;
  await yieldTick();

  // 远景山脊（两层）
  for (let layer = 0; layer < 2; layer++) {
    const baseY = H * (0.52 + layer * 0.07);
    c.fillStyle = layer === 0 ? "rgba(40,52,66,0.55)" : "rgba(28,38,50,0.75)";
    c.beginPath();
    c.moveTo(0, H);
    c.lineTo(0, baseY);
    for (let x = 0; x <= W; x += 60) {
      const y = baseY - 30 - rand() * 70;
      c.lineTo(x, y);
    }
    c.lineTo(W, H);
    c.closePath();
    c.fill();
  }
  await yieldTick();

  // 建筑剪影 + 窗光
  const buildings = 5 + Math.floor(rand() * 4);
  for (let i = 0; i < buildings; i++) {
    const bw = 60 + rand() * 90;
    const bh = 90 + rand() * 160;
    const bx = (W / buildings) * i + rand() * 20;
    const by = H * 0.66 - bh;
    c.fillStyle = "rgba(24,30,40,0.82)";
    c.fillRect(bx, by, bw, bh + 40);
    const cols = Math.max(1, Math.floor(bw / 22));
    const rows = Math.max(1, Math.floor(bh / 26));
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        if (rand() > 0.55) continue;
        c.fillStyle = ctx.light === "night" ? "rgba(255,214,140,0.75)" : "rgba(180,205,225,0.35)";
        c.fillRect(bx + 8 + cx * 22, by + 10 + cy * 26, 9, 12);
      }
    }
  }
  await yieldTick();

  // 地面
  const groundY = H * 0.66;
  const ground = c.createLinearGradient(0, groundY, 0, H);
  ground.addColorStop(0, "rgba(46,54,44,0.95)");
  ground.addColorStop(1, "rgba(26,32,28,0.98)");
  c.fillStyle = ground;
  c.fillRect(0, groundY, W, H - groundY);
  c.strokeStyle = "rgba(255,255,255,0.05)";
  for (let i = 0; i < 40; i++) {
    const y = groundY + rand() * (H - groundY);
    c.beginPath();
    c.moveTo(rand() * W, y);
    c.lineTo(rand() * W, y + 1);
    c.stroke();
  }
  await yieldTick();

  // 天气层
  if (ctx.light === "rain" || ctx.weather === "rain") {
    c.strokeStyle = "rgba(200,220,240,0.35)";
    c.lineWidth = 1;
    for (let i = 0; i < 220; i++) {
      const x = rand() * W;
      const y = rand() * H;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x - 4, y + 14);
      c.stroke();
    }
  } else if (ctx.light === "snow" || ctx.weather === "snow") {
    c.fillStyle = "rgba(255,255,255,0.75)";
    for (let i = 0; i < 160; i++) {
      const x = rand() * W;
      const y = rand() * H;
      c.fillRect(x, y, 2, 2);
    }
  }
  await yieldTick();

  // 时间色调 + 暗角
  c.fillStyle = light.tint;
  c.fillRect(0, 0, W, H);
  const vig = c.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.86);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.42)");
  c.fillStyle = vig;
  c.fillRect(0, 0, W, H);

  const gate = imageGate(canvas, 8);
  if (!gate.ok) throw new Error(`bg_gate_${gate.reason}`);

  const blob = await toBlob(canvas);
  return {
    blob,
    width: W,
    height: H,
    meta: { light: ctx.light || "day", weather: ctx.weather || "clear", variance: +gate.variance.toFixed(1) },
  };
}

/** 场景光照变体：在本地家园图（640×480）上合成时间色调。 */
async function runTask(task) {
  const seedStr = `${task.seed}|${task.kind}|${task.ctx?.light || ""}|${task.ctx?.room || ""}`;
  const seed = hashStr(seedStr);

  if (task.kind === "plot") {
    const r = generatePlot({ ...task.ctx, seed, recent: recentPlots });
    if (!r.ok) throw new Error(`plot_gate_${r.reason}`);
    recentPlots.push(r.text);
    if (recentPlots.length > 40) recentPlots.shift();
    return {
      kind: "plot",
      origin: "forge-grammar",
      text: r.text,
      size: new TextEncoder().encode(r.text).length,
      meta: { phase: task.ctx.phase, room: task.ctx.room, act: task.ctx.act },
    };
  }
  if (task.kind === "bg") {
    const out = await composeBackground(task.ctx || {});
    return {
      kind: "bg",
      origin: "forge-procedural",
      blob: out.blob,
      size: out.blob.size,
      meta: { ...out.meta, width: out.width, height: out.height },
    };
  }
  throw new Error(`unknown_kind_${task.kind}`);
}

async function pump() {
  if (busy || suspended) return;
  if (!queue.length) return;
  busy = true;
  const task = queue[0];
  try {
    const out = await runTask(task);
    const id = seedId(task);
    emit({ type: "asset", asset: { ...out, id, seed: id, tier: "edge", created_at: Date.now() } });
    queue.shift();
  } catch (err) {
    if (String(err.message || err).includes("suspended")) {
      // 保留任务，稍后重试
    } else {
      emit({ type: "fail", kind: task.kind, reason: String(err.message || err) });
      queue.shift();
    }
  } finally {
    busy = false;
    emit({ type: "queue", pending: queue.length, busy: false });
    if (!suspended && queue.length) setTimeout(pump, 0);
  }
}

const seedId = (task) => hashStr(`${task.seed}|${task.kind}|${JSON.stringify(task.ctx || {})}`);

self.onmessage = (e) => {
  const msg = e.data || {};
  switch (msg.type) {
    case "init": {
      if (msg.recentPlots) recentPlots = msg.recentPlots.slice(-40);
      emit({ type: "ready" });
      break;
    }
    case "enqueue": {
      queue.push({ kind: msg.kind, seed: msg.seed ?? Date.now(), ctx: msg.ctx || {} });
      emit({ type: "queue", pending: queue.length, busy });
      pump();
      break;
    }
    case "suspend": {
      suspended = true;
      emit({ type: "queue", pending: queue.length, busy, suspended: true });
      break;
    }
    case "resume": {
      suspended = false;
      emit({ type: "queue", pending: queue.length, busy, suspended: false });
      pump();
      break;
    }
    case "clear": {
      queue = [];
      emit({ type: "queue", pending: 0, busy });
      break;
    }
    default:
      break;
  }
};

emit({ type: "boot" });
