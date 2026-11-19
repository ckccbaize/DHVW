// 数码方块换场过渡（总观 ⇄ 显现）：在 PC 启动/加载 OLVT 期间覆盖屏幕并在就绪后消散。

const PALETTE = ["#0d1526", "#132038", "#182b49", "#101b30"];
const EDGE_COLOR = "#6fffe9";

function hashCell(x, y) {
  let h = (x * 374761393 + y * 668265263) >>> 0;
  h = ((h ^ (h >> 13)) * 1274126177) >>> 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

export function createBlockTransition({ root, canvas, label }) {
  const ctx = canvas.getContext("2d");
  const blockSize = 28;
  let raf = 0;
  let mode = "idle"; // idle | cover | hold | reveal
  let cells = [];
  let cols = 0;
  let rows = 0;
  let width = 0;
  let height = 0;
  let progress = 0;
  let coverDone = null;
  let revealDone = null;

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    width = Math.max(1, root.clientWidth || window.innerWidth);
    height = Math.max(1, root.clientHeight || window.innerHeight);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cols = Math.ceil(width / blockSize);
    rows = Math.ceil(height / blockSize);
    cells = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const wave = (x / Math.max(1, cols)) * 0.42 + (y / Math.max(1, rows)) * 0.33;
        const jitter = hashCell(x, y) * 0.25;
        cells.push({
          x: x * blockSize,
          y: y * blockSize,
          t: Math.min(0.99, wave + jitter),
          color: PALETTE[(x * 3 + y * 5) % PALETTE.length],
          phase: hashCell(x + 17, y + 31) * Math.PI * 2,
        });
      }
    }
  }

  function draw(now, p) {
    ctx.clearRect(0, 0, width, height);
    if (p > 0.02) {
      ctx.fillStyle = "rgba(7, 10, 18, 0.35)";
      ctx.fillRect(0, 0, width, height);
    }
    const band = 0.14;
    const gap = 2;
    const sz = blockSize - gap;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (p < c.t) continue;
      const isEdge = p < 1 && p - c.t < band;
      if (isEdge) {
        ctx.fillStyle = EDGE_COLOR;
        ctx.globalAlpha = 0.92;
      } else if (mode === "hold") {
        const pulse = Math.sin(now * 0.006 + c.phase);
        ctx.fillStyle = pulse > 0.85 ? "#294870" : c.color;
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = c.color;
        ctx.globalAlpha = 1;
      }
      ctx.fillRect(c.x + 1, c.y + 1, sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function resolvePending() {
    if (coverDone) {
      const fn = coverDone;
      coverDone = null;
      fn();
    }
    if (revealDone) {
      const fn = revealDone;
      revealDone = null;
      fn();
    }
  }

  function cover(text = "", durationMs = 420) {
    stopLoop();
    resolvePending();
    if (label) label.textContent = text;
    root.hidden = false;
    resize();
    mode = "cover";
    progress = 0;
    const start = performance.now();
    return new Promise((resolve) => {
      coverDone = resolve;
      const step = (now) => {
        if (mode === "cover") {
          progress = Math.min(1, (now - start) / Math.max(120, durationMs));
          draw(now, progress);
          if (progress >= 1) {
            mode = "hold";
            const fn = coverDone;
            coverDone = null;
            if (fn) fn();
          }
          raf = requestAnimationFrame(step);
        } else if (mode === "hold") {
          draw(now, 1);
          raf = requestAnimationFrame(step);
        }
      };
      raf = requestAnimationFrame(step);
    });
  }

  function setText(text) {
    if (label) label.textContent = text || "";
  }

  function reveal(durationMs = 400) {
    if (root.hidden) return Promise.resolve();
    stopLoop();
    if (label) label.textContent = "";
    mode = "reveal";
    const start = performance.now();
    const startP = Math.max(0.05, progress || 1);
    return new Promise((resolve) => {
      revealDone = resolve;
      const step = (now) => {
        if (mode !== "reveal") return;
        const k = Math.min(1, (now - start) / Math.max(120, durationMs));
        progress = startP * (1 - k);
        draw(now, progress);
        if (k >= 1) {
          mode = "idle";
          root.hidden = true;
          stopLoop();
          const fn = revealDone;
          revealDone = null;
          if (fn) fn();
          return;
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    });
  }

  function abort() {
    stopLoop();
    mode = "idle";
    progress = 0;
    root.hidden = true;
    if (label) label.textContent = "";
    resolvePending();
  }

  return {
    get active() {
      return mode !== "idle";
    },
    cover,
    setText,
    reveal,
    abort,
  };
}
