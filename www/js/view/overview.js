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

export function createOverview({ canvas, scene, store, onCharacterClick, onMoveRequest, onBubble }) {
  const cell = scene.grid.cell || 16;
  const scale = 2;
  const W = scene.grid.w * cell * scale;
  const H = scene.grid.h * cell * scale;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = false;

  let terrain = null;
  let lightKey = null;
  let lightLayer = null;
  let lightCtx = null;
  let bubble = null;
  let lastDraw = 0;
  let fitted = { w: W, h: H };

  function fit() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const k = Math.min(vw / W, vh / H);
    fitted = { w: Math.round(W * k), h: Math.round(H * k) };
    canvas.style.width = fitted.w + "px";
    canvas.style.height = fitted.h + "px";
  }
  fit();
  window.addEventListener("resize", fit);
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

  function drawAgent(agent) {
    const x = Math.round(agent.px * cell * scale);
    const y = Math.round(agent.py * cell * scale);
    const f = walkFrame(agent);
    const swing = agent.state === "walk" ? [0, 2, 0][f] : 0;
    const px = (n) => Math.round(n * scale);

    // 影子
    ctx.fillStyle = "rgba(0,0,0,0.26)";
    ctx.beginPath();
    ctx.ellipse(x, y + px(6), px(7), px(2.5), 0, 0, Math.PI * 2);
    ctx.fill();

    // 腿 + 鞋
    ctx.fillStyle = PANTS;
    ctx.fillRect(x - px(5), y - px(1) + swing, px(4), px(7));
    ctx.fillRect(x + px(1), y - px(1) - swing, px(4), px(7));
    ctx.fillStyle = SHOE;
    ctx.fillRect(x - px(5), y + px(5) + swing, px(4), px(2));
    ctx.fillRect(x + px(1), y + px(5) - swing, px(4), px(2));

    // 身体
    ctx.fillStyle = SWEATER;
    ctx.fillRect(x - px(6), y - px(9), px(12), px(9));
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(x - px(6), y - px(9), px(12), px(2));

    // 手臂
    ctx.fillStyle = SWEATER;
    ctx.fillRect(x - px(8), y - px(8), px(2), px(6));
    ctx.fillRect(x + px(6), y - px(8), px(2), px(6));

    // 头
    ctx.fillStyle = SKIN;
    ctx.fillRect(x - px(5), y - px(17), px(10), px(9));
    // 头发
    ctx.fillStyle = HAIR;
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

  function drawBubble() {
    if (!bubble || bubble.until < performance.now()) return;
    const agent = store.state.agent;
    const maxW = Math.min(W - 24, 400);
    ctx.font = `${12 * scale}px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
    const lines = wrap(bubble.text, maxW);
    const lineH = 20 * scale;
    const bw = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20 * scale);
    const bh = lines.length * lineH + 12 * scale;
    let bx = Math.round(agent.px * cell * scale - bw / 2);
    bx = Math.max(8, Math.min(W - bw - 8, bx));
    const by = Math.max(8, Math.round(agent.py * cell * scale - 26 * scale - bh));

    ctx.fillStyle = "rgba(250,250,246,0.96)";
    roundRect(ctx, bx, by, bw, bh, 8 * scale);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(bx + bw / 2 - 6 * scale, by + bh);
    ctx.lineTo(bx + bw / 2, by + bh + 7 * scale);
    ctx.lineTo(bx + bw / 2 + 6 * scale, by + bh);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#2b3038";
    ctx.textBaseline = "top";
    lines.forEach((line, i) => {
      ctx.fillText(line, bx + 10 * scale, by + 7 * scale + i * lineH);
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

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
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
    drawAgent(agent);
    if (lightLayer) ctx.drawImage(lightLayer, 0, 0);
    drawBubble();

    return dt;
  }

  canvas.addEventListener("pointerdown", (e) => {
    const rect = canvas.getBoundingClientRect();
    // 画布 CSS 尺寸已按比例设置（fit()），元素矩形即绘制区域
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) return;
    const gx = Math.floor((mx / rect.width) * scene.grid.w);
    const gy = Math.floor((my / rect.height) * scene.grid.h);
    if (gx < 0 || gy < 0 || gx >= scene.grid.w || gy >= scene.grid.h) return;
    const agent = store.state.agent;
    if (Math.abs(gx - agent.gx) <= 1 && Math.abs(gy - agent.gy) <= 1) {
      onCharacterClick && onCharacterClick();
      return;
    }
    if (!isWalkable(scene.grid, gx, gy)) {
      onBubble && onBubble("那边过不去。");
      return;
    }
    onMoveRequest && onMoveRequest(gx, gy);
  });

  return {
    get fps() {
      return fps;
    },
    get size() {
      return { w: W, h: H, css: fitted };
    },
    async load() {
      terrain = await loadImage(scene.image2xUrl);
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
