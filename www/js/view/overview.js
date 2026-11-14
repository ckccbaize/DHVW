// 总观视图：构建期烘焙图 + Canvas 2D 合成（PROJECT-PLAN §2.6.3 / §10.4）。
// 总观态**不创建 WebGL 上下文**；静止 8fps、行走 30fps；光罩层只在光照变化时重绘。

import { walkFrame } from "../core/pathagent.js";
import { isWalkable } from "../core/grid.js";

const LIGHT = {
  dawn: { top: "rgba(255,180,120,0.16)", bottom: "rgba(60,40,80,0.10)", vignette: 0.22 },
  day: { top: "rgba(255,240,210,0.05)", bottom: "rgba(0,0,0,0.02)", vignette: 0.12 },
  dusk: { top: "rgba(255,140,90,0.20)", bottom: "rgba(40,20,60,0.16)", vignette: 0.26 },
  night: { top: "rgba(40,60,140,0.34)", bottom: "rgba(10,16,40,0.30)", vignette: 0.42 },
  rain: { top: "rgba(90,120,150,0.26)", bottom: "rgba(30,40,60,0.22)", vignette: 0.34 },
  snow: { top: "rgba(220,235,250,0.22)", bottom: "rgba(120,140,170,0.14)", vignette: 0.20 },
};

const SKIN = "#f0c9a4";
const HAIR = "#3b2b33";
const SWEATER = "#c9626f";
const PANTS = "#3a3f4b";
const SHOE = "#2a2d36";

export function createOverview({ canvas, scene, store, sprites = [], showAgent = true }) {
  const cell = scene.grid.cell || 16;
  const scale = 1;
  const W = scene.grid.w * cell;
  const H = scene.grid.h * cell;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = false;

  let terrain = null;
  let charSheet = null;
  let charImg = null;
  let lightKey = null;
  let lightLayer = null;
  let lightCtx = null;
  let bubble = null;
  let lastDraw = 0;
  let fitted = { w: W, h: H };

  function fit() {
    // CSS 负责 contain 全窗口显示；这里只记录逻辑尺寸。
    fitted = { w: W, h: H, k: 1 };
  }
  fit();
  let frameTimes = [];
  let fps = 0;

  async function loadImage(url) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  }

  function buildLight(key) {
    if (!lightCtx) {
      lightLayer = document.createElement("canvas");
      lightLayer.width = W;
      lightLayer.height = H;
      lightCtx = lightLayer.getContext("2d");
    }
    const p = LIGHT[key] || LIGHT.day;
    lightCtx.clearRect(0, 0, W, H);
    const g = lightCtx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, p.top);
    g.addColorStop(1, p.bottom);
    lightCtx.fillStyle = g;
    lightCtx.fillRect(0, 0, W, H);
    const v = lightCtx.createRadialGradient(W / 2, H / 2, H * 0.34, W / 2, H / 2, H * 0.95);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, `rgba(0,0,0,${p.vignette})`);
    lightCtx.fillStyle = v;
    lightCtx.fillRect(0, 0, W, H);
    lightKey = key;
  }

  function dirName(dir = {}) {
    if (Math.abs(dir.x || 0) > Math.abs(dir.y || 0)) return dir.x >= 0 ? "E" : "W";
    return (dir.y || 0) <= 0 ? "N" : "S";
  }

  function drawSheetAgent(agent, now, actName) {
    const name = actName && charSheet.animations[actName] ? actName : agent.state === "walk" ? "walk" : "idle";
    const anim = charSheet.animations[name] || charSheet.animations.idle;
    const frames = anim.frames[dirName(agent.dir)] || anim.frames.S || [0];
    const idx = frames[Math.floor((now / 1000) * anim.fps) % frames.length];
    const fw = charSheet.frame.w;
    const fh = charSheet.frame.h;
    const sx = (idx % 4) * fw;
    const sy = Math.floor(idx / 4) * fh;
    const k = cell / 24;
    const dw = fw * k;
    const dh = fh * k;
    const x = agent.px * cell;
    const y = agent.py * cell + cell * 0.25;
    ctx.drawImage(charImg, sx, sy, fw, fh, x - dw / 2, y - dh, dw, dh);
  }

  function drawAgent(agent, palette = {}, now = performance.now(), actName = null) {
    const x = Math.round(agent.px * cell * scale);
    const y = Math.round(agent.py * cell * scale);
    const f = walkFrame(agent);
    const swing = agent.state === "walk" ? [0, 2, 0][f] : 0;
    if (charSheet && charImg) {
      drawSheetAgent(agent, now, actName || palette.act || null);
      return;
    }
    const skin = palette.skin || SKIN;
    const hair = palette.hair || HAIR;
    const sweater = palette.sweater || SWEATER;
    const pants = palette.pants || PANTS;
    const shoe = palette.shoe || SHOE;
    const px = (n) => Math.round(n * scale);

    // 影子
    ctx.fillStyle = "rgba(0,0,0,0.26)";
    ctx.beginPath();
    ctx.ellipse(x, y + px(6), px(7), px(2.5), 0, 0, Math.PI * 2);
    ctx.fill();

    // 腿 + 鞋
    ctx.fillStyle = pants;
    ctx.fillRect(x - px(5), y - px(1) + swing, px(4), px(7));
    ctx.fillRect(x + px(1), y - px(1) - swing, px(4), px(7));
    ctx.fillStyle = shoe;
    ctx.fillRect(x - px(5), y + px(5) + swing, px(4), px(2));
    ctx.fillRect(x + px(1), y + px(5) - swing, px(4), px(2));

    // 身体
    ctx.fillStyle = sweater;
    ctx.fillRect(x - px(6), y - px(9), px(12), px(9));
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(x - px(6), y - px(9), px(12), px(2));

    // 手臂
    ctx.fillStyle = sweater;
    ctx.fillRect(x - px(8), y - px(8), px(2), px(6));
    ctx.fillRect(x + px(6), y - px(8), px(2), px(6));

    // 头
    ctx.fillStyle = skin;
    ctx.fillRect(x - px(5), y - px(17), px(10), px(9));
    // 头发
    ctx.fillStyle = hair;
    ctx.fillRect(x - px(6), y - px(19), px(12), px(4));
    if (agent.dir.y <= 0) {
      // 朝上/背面：后脑勺
      ctx.fillRect(x - px(5), y - px(17), px(10), px(6));
    } else {
      const eyeX = agent.dir.x >= 0 ? x + px(1) : x - px(4);
      ctx.fillStyle = "#2b2733";
      ctx.fillRect(eyeX, y - px(14), px(1.4), px(1.6));
      if (agent.dir.x === 0) {
        ctx.fillRect(x - px(3), y - px(14), px(1.4), px(1.6));
      }
    }
  }

  function drawSleeping(bed, now) {
    if (!bed) return;
    const cx = bed.x + (bed.w || 1) / 2;
    const cy = bed.y + (bed.h || 1) - 0.15;
    const dirs = { N: { x: 0, y: -1 }, S: { x: 0, y: 1 }, E: { x: 1, y: 0 }, W: { x: -1, y: 0 } };
    const pseudo = { px: cx, py: cy, state: "idle", frame: 0, dir: dirs[bed.facing] || dirs.S, act: "sleep" };
    drawAgent(pseudo, {}, now, "sleep");
    // 被子：盖住床的下半部，留出头
    const bx = bed.x * cell + 1;
    const by = bed.y * cell + cell * 0.55;
    const bw = (bed.w || 1) * cell - 2;
    const bh = (bed.h || 1) * cell * 0.45;
    ctx.fillStyle = "#c9626f";
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = "#1a1a2e";
    ctx.lineWidth = 2;
    ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(bx + 2, by + 2, bw - 4, 3);
  }

  function drawBubble() {
    if (!showAgent || !bubble || bubble.until < performance.now()) return;
    const agent = store.state.agent;
    const maxW = Math.min(W - 24, 400);
    ctx.font = `${12 * scale}px "Fusion Pixel 12px Proportional Simplified Chinese", "Microsoft YaHei", monospace`;
    const lines = wrap(bubble.text, maxW);
    const lineH = 18 * scale;
    const border = 3;
    const shadow = 4;
    const bw = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 22 * scale);
    const bh = lines.length * lineH + 14 * scale;
    let bx = Math.round(agent.px * cell * scale - bw / 2);
    bx = Math.max(8, Math.min(W - bw - 8, bx));
    const by = Math.max(8, Math.round(agent.py * cell * scale - 26 * scale - bh));

    // 硬阴影 + 平涂 + 3px 墨线（赛璐璐）
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(bx + shadow, by + shadow, bw, bh);
    ctx.fillStyle = "#fafaf5";
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = "#1a1a2e";
    ctx.lineWidth = border;
    ctx.strokeRect(bx + border / 2, by + border / 2, bw - border, bh - border);

    // 小尾巴
    ctx.fillStyle = "#1a1a2e";
    ctx.beginPath();
    ctx.moveTo(bx + bw / 2 - 6 * scale, by + bh);
    ctx.lineTo(bx + bw / 2, by + bh + 7 * scale);
    ctx.lineTo(bx + bw / 2 + 6 * scale, by + bh);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#1a1a2e";
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
      ctx.fillText(line, bx + 11 * scale, by + 8 * scale + i * lineH);
    });
  }

  function wrap(text, maxW) {
    const out = [];
    let cur = "";
    for (const ch of text) {
      const next = cur + ch;
      if (ctx.measureText(next).width > maxW - 20 * scale && cur) {
        out.push(cur);
        cur = ch;
      } else {
        cur = next;
      }
      if (out.length === 2) break;
    }
    if (cur) out.push(cur);
    return out.slice(0, 3);
  }



  function draw(now) {
    const agent = store.state.agent;
    const wantFps = agent.state === "walk" ? 30 : 8;
    if (now - lastDraw < 1000 / wantFps) return;
    const dt = lastDraw ? Math.min((now - lastDraw) / 1000, 0.25) : 0;
    lastDraw = now;
    frameTimes.push(now);
    while (frameTimes.length > 30) frameTimes.shift();
    if (frameTimes.length > 2) {
      const span = frameTimes[frameTimes.length - 1] - frameTimes[0];
      fps = Math.round(((frameTimes.length - 1) * 1000) / span);
    }

    const key = store.state.light || "day";
    if (key !== lightKey) buildLight(key);

    if (terrain) ctx.drawImage(terrain, 0, 0, W, H);
    else {
      ctx.fillStyle = "#2a2f3a";
      ctx.fillRect(0, 0, W, H);
    }
    if (showAgent) {
      const bed = store.state.sleepView;
      if (bed) drawSleeping(bed, now);
      else drawAgent(agent, {}, now, agent.act);
    }
    for (const sp of sprites) {
      drawAgent(
        { px: sp.x + 0.5, py: sp.y + 0.5, state: "idle", frame: 0, dir: sp.dir || { x: 0, y: 1 } },
        sp.palette,
        now,
        sp.act || null,
      );
    }
    if (lightLayer) ctx.drawImage(lightLayer, 0, 0);
    drawBubble();

    return dt;
  }

  return {
    get fps() {
      return fps;
    },
    get size() {
      return { w: W, h: H, css: fitted };
    },
    async load() {
      terrain = await loadImage(scene.image2xUrl);
      try {
        const res = await fetch("assets/char/ojj_sheet.json", { cache: "no-cache" });
        if (res.ok) {
          charSheet = await res.json();
          charImg = await loadImage("assets/char/ojj_sheet.png");
        }
      } catch {
        charSheet = null;
        charImg = null;
      }
      buildLight(store.state.light || "day");
    },
    draw,
    say(text, ttl = 2600) {
      const t = text == null ? "" : String(text);
      if (!t) return;
      bubble = { text: t, until: performance.now() + ttl };
    },
    clearBubble() {
      bubble = null;
    },
  };
}
