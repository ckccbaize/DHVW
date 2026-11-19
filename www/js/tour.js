// 巡演模式（宣传片）：独立页面 tour.html。
// 硬约束：不连 WS、不建 Worker、不写 IndexedDB / localStorage / data 存档，
// 只读场景包与角色图集，因此与主线生活运行时完全隔离。
//
// 画面全部画在 canvas 上（含总观浮层），captureStream 录到的就是成片：
// 开场（总观 UI 展开 → 收起 + 天黑到天亮）→ 家里起床/吃饭/出门
// → 街景连续带（书店 → 咖啡厅 → 公园，逐段向前走、接缝雾化）→ 淡出 → 保存录像。

import { bfsPath, isWalkable, nearestWalkable } from "./core/grid.js";
import { phaseOf, weekdayInfo } from "./core/clock.js";
import { lightFor } from "./core/light.js";
import { loadScene } from "./view/scene-loader.js";
import { loadCachedImage, loadCachedJSON } from "./view/pixmap.js";
import { createLightPlate } from "./view/lightplate.js";
import { layoutTour, cameraTarget, CELL_DEFAULT } from "./core/tourlayout.js";

const CELLS_PER_SEC = 1 / 0.35;        // 与 pathagent 同步：0.35s/格
const CLOCK_START_MIN = 6 * 60 + 20;   // 06:20 夜色未尽
const CLOCK_MIN_PER_SEC = 10;          // 1 秒 = 10 分钟：出门时已过 08:00，街景全程白天
const HUD_IN_MS = 900;                 // 总观浮层展开
const HUD_HIDE_AT_MS = 3600;           // 展开后停留，再收起
const HUD_FADE_MS = 1200;
const SCENE_LINES = { bookstore: "书店里很安静。", cafe: "是咖啡的味道。", park: "公园的风很舒服。" };

const params = new URLSearchParams(location.search);
const opts = {
  record: params.get("record") !== "0",
  debug: params.get("debug") === "1",
  bitrate: Math.max(1_000_000, Number(params.get("bitrate")) || 6_000_000),
  scenes: (params.get("scenes") || "home,bookstore,cafe,park")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

const INK = "#1a1a2e";
const canvas = document.querySelector("#tourScene");
const ctx = canvas.getContext("2d", { alpha: false });
const lightPlate = createLightPlate();
const ops = {
  root: document.querySelector("#tourOps"),
  record: document.querySelector("#btnRecord"),
  replay: document.querySelector("#btnReplay"),
  state: document.querySelector("#recState"),
  note: document.querySelector("#tourNote"),
  error: document.querySelector("#tourError"),
};

const view = { w: 0, h: 0 };
const world = { entries: [], mode: "room", cur: 0, camX: 0, totalW: 0 };
const tour = {
  startedAt: 0,
  elapsed: 0,
  minute: CLOCK_START_MIN,
  hudAlpha: 1,
  hudIn: 0,                // 0→1 浮层展开进度
  fade: 1,
  blackout: 0,
  bubble: null,
  pos: { x: 0, y: 0 },
  dir: { x: 1, y: 0 },
  state: "idle",           // idle | walk | act | sleep
  act: null,
  frame: 0,
  pts: [],
  done: null,
  finished: false,
};
let charSheet = null;
let charImg = null;

// ---------- 布局 ----------

function resize() {
  // 录屏期间不重建画布：captureStream 的尺寸变化会让部分 Chromium 版本丢帧。
  if (recorder.active()) return;
  view.w = Math.max(320, Math.round(canvas.clientWidth || window.innerWidth));
  view.h = Math.max(240, Math.round(canvas.clientHeight || window.innerHeight));
  canvas.width = view.w;
  canvas.height = view.h;
  ctx.imageSmoothingEnabled = false;
  layout();
}

function layout() {
  const out = layoutTour(world.entries.map((e) => e.scene), view);
  world.stripK = out.stripK;
  world.totalW = out.totalW;
  out.rooms.forEach((r, i) => Object.assign(world.entries[i], r));
}

function entryOf(i = world.cur) {
  return world.entries[i];
}

function cellNow() {
  return entryOf()?.scene.grid.cell || CELL_DEFAULT;
}

/** 摄像机：街景带里让角色停在屏幕 40% 处；房间模式下整屋居中不跟随。 */
function updateCamera(dt) {
  if (world.mode !== "strip") return;
  const e = entryOf();
  const gx = e.x0 + tour.pos.x * e.stripK;
  const want = cameraTarget(gx, Math.max(0, world.totalW - view.w), view.w);
  world.camX += (want - world.camX) * Math.min(1, dt * 8);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------- 绘制 ----------

function drawSceneRoom() {
  const e = world.entries[0];
  const ox = (view.w - e.roomW) / 2;
  const oy = (view.h - e.roomH) / 2;
  ctx.drawImage(e.img, ox, oy, e.roomW, e.roomH);
  drawCharacter(ox, oy, e.roomK);
}

function drawSceneStrip() {
  const cam = world.camX;
  for (const e of world.entries) {
    if (e.x0 > cam + view.w || e.x0 + e.stripW < cam) continue;
    ctx.drawImage(e.img, e.x0 - cam, e.stripTop, e.stripW, e.stripH);
  }
  const e = entryOf();
  drawCharacter(e.x0 - cam, e.stripTop, e.stripK);
  // 接缝雾带压在角色之上：跨场景那 1~2 格（墙）藏在雾里，看起来是走了很远。
  const bandW = Math.max(180, view.h * 0.3);
  for (let i = 1; i < world.entries.length; i += 1) {
    const sx = world.entries[i].x0 - cam;
    if (sx < -bandW || sx > view.w + bandW) continue;
    const g = ctx.createLinearGradient(sx - bandW / 2, 0, sx + bandW / 2, 0);
    g.addColorStop(0, "rgba(6,7,12,0)");
    g.addColorStop(0.5, "rgba(6,7,12,0.92)");
    g.addColorStop(1, "rgba(6,7,12,0)");
    ctx.fillStyle = g;
    ctx.fillRect(sx - bandW / 2, 0, bandW, view.h);
  }
}

function dirName(dir = {}) {
  if (Math.abs(dir.x || 0) > Math.abs(dir.y || 0)) return dir.x >= 0 ? "E" : "W";
  return (dir.y || 0) <= 0 ? "N" : "S";
}

function drawCharacter(ox, oy, k) {
  const cell = cellNow();
  const x = ox + tour.pos.x * k;
  const footY = oy + tour.pos.y * k + cell * k * 0.25;

  ctx.fillStyle = "rgba(0,0,0,0.26)";
  ctx.beginPath();
  ctx.ellipse(x, footY + 6 * k, 7 * k, 2.5 * k, 0, 0, Math.PI * 2);
  ctx.fill();

  if (!charSheet || !charImg) return;

  const sheetScale = k * (cell / 24);
  const name = tour.state === "sleep" ? "sleep" : tour.state === "walk" ? "walk" : tour.act && charSheet.animations[tour.act] ? tour.act : "idle";
  const anim = charSheet.animations[name] || charSheet.animations.idle;
  const frames = anim.frames[dirName(tour.dir)] || anim.frames.S || [0];
  const idx = frames[Math.floor((performance.now() / 1000) * anim.fps) % frames.length];
  const fw = charSheet.frame.w;
  const fh = charSheet.frame.h;
  const sx = (idx % 4) * fw;
  const sy = Math.floor(idx / 4) * fh;
  const dw = fw * sheetScale;
  const dh = fh * sheetScale;

  if (tour.state === "sleep") {
    // 躺在床上：绕身体中心旋转 90°，让 32×48 的立绘横躺。
    ctx.save();
    ctx.translate(x, oy + tour.pos.y * k);
    ctx.rotate(-Math.PI / 2);
    ctx.drawImage(charImg, sx, sy, fw, fh, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
    return;
  }
  ctx.drawImage(charImg, sx, sy, fw, fh, x - dw / 2, footY - dh, dw, dh);
}

function drawBubble() {
  const b = tour.bubble;
  if (!b || b.until < performance.now()) return;
  const u = Math.max(1, view.h / 720);
  const font = `${Math.round(12 * u)}px "Fusion Pixel 12px Proportional Simplified Chinese", "Microsoft YaHei", monospace`;
  ctx.font = font;
  const maxW = Math.min(view.w - 40 * u, 380 * u);
  const lines = wrap(b.text, maxW - 22 * u);
  const lineH = 17 * u;
  const bw = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 22 * u);
  const bh = lines.length * lineH + 12 * u;
  const e = entryOf();
  const k = world.mode === "strip" ? e.stripK : e.roomK;
  const cx = world.mode === "strip" ? e.x0 - world.camX + tour.pos.x * k : (view.w - e.roomW) / 2 + tour.pos.x * k;
  const feetY = world.mode === "strip" ? e.stripTop + tour.pos.y * k : (view.h - e.roomH) / 2 + tour.pos.y * k;
  const headY = charSheet ? feetY - charSheet.frame.h * (cellNow() / 24) * k : feetY - 60 * u;
  const bx = clamp(Math.round(cx - bw / 2), 8 * u, view.w - bw - 8 * u);
  const by = Math.max(8 * u, Math.round(headY - 14 * u - bh));

  ctx.fillStyle = INK;
  ctx.fillRect(bx + 4 * u, by + 4 * u, bw, bh);
  ctx.fillStyle = "#fafaf5";
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3 * u;
  ctx.strokeRect(bx + 1.5 * u, by + 1.5 * u, bw - 3 * u, bh - 3 * u);
  ctx.fillStyle = INK;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  lines.forEach((line, i) => ctx.fillText(line, bx + 11 * u, by + 7 * u + i * lineH));
  ctx.textBaseline = "alphabetic";
}

function wrap(text, maxW) {
  const out = [];
  let cur = "";
  for (const ch of text) {
    const next = cur + ch;
    if (ctx.measureText(next).width > maxW && cur) {
      out.push(cur);
      cur = ch;
    } else {
      cur = next;
    }
    if (out.length === 2) break;
  }
  if (cur && out.length < 3) out.push(cur);
  return out.slice(0, 3);
}

// ---------- 总观浮层（画在 canvas 里，才能进录像） ----------

function celPanel(x, y, w, h, bg, lw, shadow) {
  ctx.fillStyle = INK;
  ctx.fillRect(x + shadow, y + shadow, w, h);
  ctx.fillStyle = bg;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = INK;
  ctx.lineWidth = lw;
  ctx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);
}

function celText(text, x, y, color, font, align = "left") {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

function textW(text, font) {
  ctx.font = font;
  return ctx.measureText(text).width;
}

function clockLabel() {
  const total = tour.minute;
  const day = 1 + Math.floor(total / 1440);
  const minute = total % 1440;
  const week = Math.floor((day - 1) / 7) + 1;
  const hh = String(Math.floor(minute / 60)).padStart(2, "0");
  const mm = String(Math.floor(minute % 60)).padStart(2, "0");
  return `第 ${day} 天 · 第 ${week} 周 ${weekdayInfo().weekdayName} ${hh}:${mm}`;
}

function drawHud() {
  const a = tour.hudAlpha;
  if (a <= 0.002) return;
  const u = Math.max(1, view.h / 720);
  const font = `${Math.round(12 * u)}px "Fusion Pixel 12px Proportional Simplified Chinese", "Microsoft YaHei", monospace`;
  const bold = `900 ${Math.round(12 * u)}px "Fusion Pixel 12px Proportional Simplified Chinese", "Microsoft YaHei", monospace`;
  const lw = Math.max(2, Math.round(2 * u));
  const padX = 18 * u;
  const dy = (1 - a) * 8 * u;
  // 展开：每块面板错峰从自己那侧滑入（左上从左、右上从右、底部从下）。
  const enter = (delay) => easeOut(tour.hudIn <= delay ? 0 : (tour.hudIn - delay) / (1 - delay));

  ctx.save();
  ctx.globalAlpha = a;

  // 左上：世界档位 + 连接
  const p1 = enter(0);
  if (p1 > 0) {
    ctx.save();
    ctx.globalAlpha = a * p1;
    const tier = "世界·本地";
    const tw = textW(tier, font);
    const tierW = tw + 20 * u;
    const tierH = 24 * u;
    const topY = 14 * u - dy;
    const slide = (1 - p1) * 40 * u;
    celPanel(padX - slide, topY, tierW, tierH, "#3d3a2a", lw, 3 * u);
    celText(tier, padX - slide + 10 * u, topY + tierH / 2, "#e6cf8b", font);

    const dotX = padX - slide + tierW + 26 * u;
    const dotY = topY + tierH / 2;
    ctx.fillStyle = "#6fcaa5";
    ctx.beginPath();
    ctx.arc(dotX, dotY, 4 * u, 0, Math.PI * 2);
    ctx.fill();
    celText("主机在线", dotX + 10 * u, dotY, "#98a1ae", font);
    ctx.restore();
  }

  // 右上：时钟 + fps
  const p2 = enter(0.15);
  if (p2 > 0) {
    ctx.save();
    ctx.globalAlpha = a * p2;
    const slide = (1 - p2) * 40 * u;
    const topY = 14 * u - dy;
    const clock = clockLabel();
    celText(clock, view.w - padX + slide, topY + 8 * u, "#e6e9f0", font, "right");
    celText(`${fps.value} fps`, view.w - padX + slide, topY + 28 * u, "#98a1ae", font, "right");

    // PC 工作 Agent 卡
    const cardW = 190 * u;
    const cardH = 52 * u;
    const cardX = view.w - padX - cardW + slide;
    const cardY = topY + 48 * u;
    celPanel(cardX, cardY, cardW, cardH, "rgba(20,24,32,0.86)", lw, 3 * u);
    celText("PC 工作 Agent", cardX + 11 * u, cardY + 16 * u, "#98a1ae", `${Math.round(11 * u)}px "Microsoft YaHei", monospace`);
    celText("codex · 写周记 · running", cardX + 11 * u, cardY + 36 * u, "#e6e9f0", font);
    ctx.restore();
  }

  // 左下：端侧产出计数
  const p3 = enter(0.3);
  if (p3 > 0) {
    ctx.save();
    ctx.globalAlpha = a * p3;
    const slide = (1 - p3) * 40 * u;
    const asset = `场景 ${world.entries.length} / 剧情 0 / 背景 0`;
    const aw = textW(asset, font) + 24 * u;
    const ah = 24 * u;
    const ay = view.h - 16 * u - ah + dy;
    celPanel(padX - slide, ay, aw, ah, "rgba(20,24,32,0.86)", lw, 3 * u);
    celText(asset, padX - slide + 12 * u, ay + ah / 2, "#98a1ae", font);
    ctx.restore();
  }

  // 底部：里/外 dock
  const p4 = enter(0.42);
  if (p4 > 0) {
    ctx.save();
    ctx.globalAlpha = a * p4;
    const slide = (1 - p4) * 40 * u;
    const btnW = 64 * u;
    const btnH = 40 * u;
    const gap = 8 * u;
    const dockW = btnW * 2 + gap + 24 * u;
    const dockH = btnH + 16 * u;
    const dockX = (view.w - dockW) / 2;
    const dockY = view.h - 14 * u - dockH + dy + slide;
    celPanel(dockX, dockY, dockW, dockH, "#fafaf5", lw, 3 * u);
    const labels = ["里", "外"];
    labels.forEach((label, i) => {
      const bx = dockX + 12 * u + i * (btnW + gap);
      const by = dockY + 8 * u;
      celPanel(bx, by, btnW, btnH, i === 0 ? "#e8875b" : "#fafaf5", lw, 2 * u);
      celText(label, bx + btnW / 2, by + btnH / 2, INK, bold, "center");
    });
    ctx.restore();
  }

  ctx.restore();
}

function easeOut(t) {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - (1 - k) * (1 - k);
}

const fps = {
  value: 0,
  frames: [],
  push(now) {
    this.frames.push(now);
    while (this.frames.length > 31) this.frames.shift();
    if (this.frames.length > 2) {
      const span = this.frames[this.frames.length - 1] - this.frames[0];
      this.value = Math.round(((this.frames.length - 1) * 1000) / span);
    }
  },
};

function draw(now) {
  ctx.fillStyle = "#07080c";
  ctx.fillRect(0, 0, view.w, view.h);
  if (!world.entries.length) {
    drawOverlay();
    return;
  }
  if (world.mode === "room") drawSceneRoom();
  else drawSceneStrip();
  drawBubble();
  lightPlate(ctx, view.w, view.h, lightFor(phaseOf(tour.minute), "clear"));
  drawHud();
  drawOverlay();
}

function drawOverlay() {
  const black = Math.max(tour.blackout, tour.fade);
  if (black <= 0.001) return;
  ctx.fillStyle = `rgba(4,5,8,${Math.min(1, black)})`;
  ctx.fillRect(0, 0, view.w, view.h);
}

// ---------- 移动 ----------

function centerPx(gx, gy) {
  const c = cellNow();
  return { x: (gx + 0.5) * c, y: (gy + 0.5) * c };
}

function cellOfPos() {
  const c = cellNow();
  return [Math.floor(tour.pos.x / c), Math.floor(tour.pos.y / c)];
}

function walkTo(points) {
  tour.pts = points.slice();
  if (!tour.pts.length) {
    tour.state = "idle";
    return Promise.resolve();
  }
  tour.state = "walk";
  return new Promise((resolve) => {
    tour.done = resolve;
  });
}

function walkCells(path) {
  const c = cellNow();
  return walkTo(path.map(([gx, gy]) => ({ x: (gx + 0.5) * c, y: (gy + 0.5) * c })));
}

function advance(dt) {
  if (tour.state !== "walk" || !tour.pts.length) {
    if (tour.state === "walk" && !tour.pts.length) tour.state = "idle";
    return;
  }
  // 步速只按场景内像素算：pos 是场景内坐标，绘制时才乘 k。
  // 这里再乘一次 scaleNow() 会让角色随场景比例放大而"加速"，街景段快 3~4 倍。
  let budget = CELLS_PER_SEC * cellNow() * dt;
  while (budget > 0 && tour.pts.length) {
    const p = tour.pts[0];
    const dx = p.x - tour.pos.x;
    const dy = p.y - tour.pos.y;
    const d = Math.hypot(dx, dy);
    if (d > 1e-6) {
      tour.dir = Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) };
    }
    if (d <= budget) {
      tour.pos.x = p.x;
      tour.pos.y = p.y;
      tour.pts.shift();
      budget -= d;
    } else {
      tour.pos.x += (dx / d) * budget;
      tour.pos.y += (dy / d) * budget;
      budget = 0;
    }
    tour.frame += dt * 8;
  }
  if (!tour.pts.length) {
    tour.state = "idle";
    const done = tour.done;
    tour.done = null;
    if (done) done();
  }
}

// ---------- 编排 ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tween(ms, from, to, apply) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      apply(from + (to - from) * k);
      if (k >= 1) resolve();
      else requestAnimationFrame(tick);
    };
    tick();
  });
}

function say(text, ttl = 2600) {
  tour.bubble = { text, until: performance.now() + ttl };
}

function hotspotCell(scene, acts) {
  for (const act of acts) {
    const hot = (scene.hotspots || []).find((h) => h.act === act);
    if (hot) return [hot.x, hot.y];
  }
  return null;
}

/** 场景内最靠右的可行走格（家/店内“走到门口”的目标）。 */
function exitCell(scene, from) {
  const grid = scene.grid;
  const cells = [];
  for (let x = grid.w - 1; x >= 0; x -= 1) {
    for (let y = 0; y < grid.h; y += 1) {
      if (!isWalkable(grid, x, y)) continue;
      if (bfsPath(grid, from[0], from[1], x, y)) cells.push([x, y]);
    }
    if (cells.length) return cells.sort((a, b) => Math.abs(a[1] - from[1]) - Math.abs(b[1] - from[1]))[0];
  }
  return from;
}

function entryCellOf(scene, ypx) {
  const grid = scene.grid;
  const c = grid.cell || CELL_DEFAULT;
  const row = Math.round(ypx / c - 0.5);
  let best = null;
  let bestD = Infinity;
  for (let x = 0; x < Math.min(4, grid.w); x += 1) {
    for (let y = 0; y < grid.h; y += 1) {
      if (!isWalkable(grid, x, y)) continue;
      const d = Math.abs(y - row);
      if (d < bestD) {
        bestD = d;
        best = [x, y];
      }
    }
  }
  return best || nearestWalkable(grid, 1, clamp(row, 0, grid.h - 1), 8) || [1, 1];
}

async function loadEntries() {
  const entries = [];
  const missing = [];
  for (const id of opts.scenes) {
    try {
      const scene = await loadScene(id);
      const img = await loadCachedImage(scene.image2xUrl);
      entries.push({ id, scene, img });
    } catch (err) {
      missing.push(id);
      console.warn("[tour] 场景不可用", id, err?.message || err);
    }
  }
  world.entries = entries;
  layout();
  return missing;
}

async function homeSequence() {
  const e = world.entries[0];
  const scene = e.scene;
  const bed = (scene.props || []).find((p) => p.id === "bed");
  const c = scene.grid.cell || CELL_DEFAULT;
  const bedW = bed?.w || 2;
  const bedH = bed?.h || 3;
  const center = bed
    ? { x: (bed.x + bedW / 2) * c, y: (bed.y + bedH / 2) * c }
    : { x: 3 * c, y: 12 * c };
  tour.pos = center;
  tour.dir = { x: 1, y: 0 };
  tour.state = "sleep";

  await sleep(2600);
  say("唔……", 1600);
  await sleep(900);

  // 起床：落到床右侧的可行走格
  const stand = bed
    ? nearestWalkable(scene.grid, bed.x + bedW, bed.y + bedH - 1, 4) || cellOfPos()
    : cellOfPos();
  tour.state = "idle";
  tour.pos = centerPx(stand[0], stand[1]);
  say("天亮了。", 2200);
  await sleep(700);

  // 吃饭
  const eatSpot = hotspotCell(scene, ["eat", "snack", "cook"]);
  if (eatSpot) {
    const from = cellOfPos();
    const path = bfsPath(scene.grid, from[0], from[1], eatSpot[0], eatSpot[1]);
    if (path && path.length) await walkCells(path);
    tour.state = "act";
    tour.act = "eat";
    say("先吃点东西。", 2400);
    await sleep(2800);
    tour.act = null;
    tour.state = "idle";
  }

  // 出门：走到最右侧可行走格
  const from = cellOfPos();
  const exit = exitCell(scene, from);
  const path = bfsPath(scene.grid, from[0], from[1], exit[0], exit[1]);
  if (path) await walkCells(path);
  await sleep(260);
}

async function enterStrip(fromIndex) {
  await tween(700, tour.fade, 1, (v) => { tour.fade = v; });
  world.mode = "strip";
  world.cur = fromIndex;
  const next = world.entries[fromIndex];
  const enter = entryCellOf(next.scene, next.scene.grid.h * (next.scene.grid.cell || CELL_DEFAULT) * 0.55);
  tour.pos = centerPx(enter[0], enter[1]);
  tour.dir = { x: 1, y: 0 };
  tour.state = "idle";
  tour.act = null;
  layout();
  updateCamera(1);
  world.camX = clamp(
    next.x0 + tour.pos.x * next.stripK - view.w * 0.4,
    0,
    Math.max(0, world.totalW - view.w),
  );
  await tween(900, tour.fade, 0, (v) => { tour.fade = v; });
}

async function stripSequence(fromIndex) {
  for (let i = fromIndex; i < world.entries.length; i += 1) {
    world.cur = i;
    const e = world.entries[i];
    const grid = e.scene.grid;
    const c = grid.cell || CELL_DEFAULT;
    const from = cellOfPos();
    const start = isWalkable(grid, from[0], from[1]) ? from : nearestWalkable(grid, from[0], from[1], 6) || from;
    const target = exitCell(e.scene, start);
    const path = bfsPath(grid, start[0], start[1], target[0], target[1]);
    if (path && path.length) await walkCells(path);
    // 继续向右走到底边：这一段穿过墙体，靠接缝雾带遮住。
    await walkTo([{ x: grid.w * c + c * 1.5, y: tour.pos.y }]);
    if (i + 1 >= world.entries.length) break;
    const next = world.entries[i + 1];
    world.cur = i + 1;
    const enter = entryCellOf(next.scene, tour.pos.y);
    tour.pos = centerPx(enter[0], enter[1]);
    if (SCENE_LINES[next.id]) say(SCENE_LINES[next.id], 2400);
  }
}

async function runTour() {
  tour.startedAt = 0;
  tour.elapsed = 0;
  tour.finished = false;
  setOps("准备中…");
  const missing = await loadEntries();
  if (!world.entries.length) throw new Error("没有可用场景包");
  const missingText = missing.length ? `缺少场景包：${missing.join(",")}（可在 PC 生成后重试）` : "";
  ops.note.textContent = missingText;
  ops.note.hidden = !missingText;
  if (missing.length) console.warn("[tour]", missingText);

  try {
    charSheet = await loadCachedJSON("assets/char/ojj_sheet.json");
    charImg = await loadCachedImage("assets/char/ojj_sheet.png");
  } catch (err) {
    console.warn("[tour] 角色图集缺失，退回无角色画面", err?.message || err);
  }
  try {
    await document.fonts.load('12px "Fusion Pixel 12px Proportional Simplified Chinese"');
  } catch {
    /* 字体没装好也能跑，只是字形退化 */
  }

  world.mode = "room";
  world.cur = 0;
  tour.pos = { x: 0, y: 0 };
  tour.state = "idle";
  world.camX = 0;
  if (view.w === 0) resize();

  if (opts.record) recorder.start();
  recorderActive();
  // 计时从开画那一帧开始：加载阶段的等待不能吃掉 HUD 展开镜头。
  tour.startedAt = performance.now();
  await tween(900, 1, 0, (v) => { tour.fade = v; });

  await homeSequence();

  if (world.entries.length > 1) {
    await enterStrip(1);
    await stripSequence(1);
  }

  // 收尾：淡出 → 停录 → 保存
  await tween(1200, 0, 1, (v) => { tour.blackout = v; });
  await sleep(240);
  await recorder.stop();
  tour.finished = true;
  setOps("巡演结束");
  ops.record.textContent = "重新录一场";
}

// ---------- 录屏 ----------

const recorder = (() => {
  let media = null;
  let chunks = [];
  let mime = "";
  const api = {
    supported() {
      return typeof MediaRecorder !== "undefined" && typeof canvas.captureStream === "function";
    },
    active() {
      return Boolean(media);
    },
    start() {
      if (!api.supported() || media) return false;
      const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
      mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
      try {
        const stream = canvas.captureStream(30);
        media = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: opts.bitrate } : { videoBitsPerSecond: opts.bitrate });
      } catch (err) {
        console.warn("[tour] 录屏启动失败", err?.message || err);
        media = null;
        return false;
      }
      chunks = [];
      media.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) chunks.push(ev.data);
      };
      media.start(1000);
      setOps("录屏中…");
      return true;
    },
    async stop() {
      const m = media;
      if (!m) return null;
      media = null;
      const blob = await new Promise((resolve) => {
        m.onstop = () => resolve(new Blob(chunks, { type: m.mimeType || "video/webm" }));
        try {
          m.stop();
        } catch {
          resolve(new Blob(chunks, { type: m.mimeType || "video/webm" }));
        }
      });
      chunks = [];
      if (!blob || !blob.size) {
        setOps("录像为空");
        return null;
      }
      const name = `dhvw-tour-${stamp()}.webm`;
      const saved = await saveBlob(blob, name);
      setOps(saved ? `已保存 ${saved}` : `已生成 ${name}（浏览器下载）`);
      return blob;
    },
  };
  return api;
})();

function recorderActive() {
  if (!recorder.active()) ops.record.textContent = "开始录屏";
  else ops.record.textContent = "结束录屏";
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 优先进设备 data/recordings（外壳 /__tour/save），没有外壳时退回浏览器下载。 */
async function saveBlob(blob, name) {
  try {
    const res = await fetch(`/__tour/save?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "video/webm" },
      body: blob,
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.ok && data.path) return data.path;
    }
  } catch {
    /* 本机静态服务没有该接口时走下载 */
  }
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) {
    console.warn("[tour] 下载失败", err?.message || err);
  }
  return "";
}

function setOps(text) {
  if (ops.state) ops.state.textContent = text;
  recorderActive();
}

// ---------- 主循环 ----------

let last = performance.now();
let frameErrors = 0;
function frame(now) {
  try {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!tour.finished && tour.startedAt) tour.elapsed = (now - tour.startedAt) / 1000;
    tour.minute = CLOCK_START_MIN + tour.elapsed * CLOCK_MIN_PER_SEC;
    // 总观浮层：0→HUD_IN 展开，HUD_HIDE_AT 开始收起，HUD_FADE 后消失。
    const t = tour.elapsed;
    const inS = HUD_IN_MS / 1000;
    const hideAt = HUD_HIDE_AT_MS / 1000;
    const fadeS = HUD_FADE_MS / 1000;
    tour.hudIn = clamp(t / inS, 0, 1);
    tour.hudAlpha = clamp(1 - (t - hideAt) / fadeS, 0, 1);

    advance(dt);
    updateCamera(dt);
    draw(now);
    fps.push(now);
  } catch (err) {
    if (frameErrors++ === 0) console.error("[tour] 渲染异常", err);
  }
  requestAnimationFrame(frame);
}

// ---------- 操作条 / 键盘 ----------

function showOps(force) {
  ops.root.hidden = force === undefined ? !ops.root.hidden : !force;
}

ops.record?.addEventListener("click", async () => {
  if (recorder.active()) await recorder.stop();
  else recorder.start();
  recorderActive();
});
ops.replay?.addEventListener("click", () => location.reload());
let opsTimer = 0;
window.addEventListener("pointermove", () => {
  showOps(true);
  clearTimeout(opsTimer);
  opsTimer = setTimeout(() => showOps(false), 2400);
});
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    location.reload();
  } else if (e.key === "r" || e.key === "R") {
    if (recorder.active()) void recorder.stop();
    else recorder.start();
    recorderActive();
  } else if (e.key === "h" || e.key === "H") {
    showOps();
  }
});
window.addEventListener("resize", resize);

window.__tour = {
  world,
  tour,
  opts,
  entries: () => world.entries.map((e) => ({ id: e.id, x0: e.x0, w: e.stripW })),
  startRecording: () => recorder.start(),
  stopRecording: () => recorder.stop(),
  isRecording: () => recorder.active(),
  finished: () => tour.finished,
};

resize();
if (opts.debug) showOps(true);
requestAnimationFrame(frame);

runTour().catch((err) => {
  console.error(err);
  ops.error.hidden = false;
  ops.error.textContent = `巡演启动失败：${err?.message || err}`;
  setOps("失败");
  void recorder.stop();
});
