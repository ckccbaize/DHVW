// 巡演布局：两套取景数学（纯函数，可测，不碰 DOM）。
//
// 两种段：
//   room —— 首段（家）：整幅地图 contain 进视口，看全屋。
//   walk —— 街景段：变焦到比视口更宽，角色固定在屏幕 CAM_RATIO 处，
//           地图在脚下滚动。走满一段里程就**在同一帧内**换成下一张图。
//
// 为什么街景段必须变焦：这些地图宽高比接近视口（448×304 vs 1258×622），
// 用 cover 比例算出来 stripW≈vw、camMax≈0，横向没有滚动余量，角色只能在画面里
// 从左走到右、换图时弹回左边——观感是幻灯片（2026-11-19 实测被否）。
// 变焦后 stripW = vw*zoom，camMax = vw*(zoom-1)，才有真正的"脚下滚图"。
//
// 纵向必须锚定行走行：变焦后地图高度远超视口，若不锚定，角色会按网格坐标
// 落到画面上方甚至画外（实测脚底 y = -149..103）。

export const CELL_DEFAULT = 16;

/** 角色脚底停在视口高度的这个位置。 */
export const GROUND_RATIO = 0.78;

/** 角色停在屏幕宽度的这个位置。 */
export const CAM_RATIO = 0.4;

/** 街景段的横向变焦：段宽 = 视口宽 × 该倍率。 */
export const WALK_ZOOM = 1.8;

/**
 * 场景的"街面行"（场景内 y 像素）：角色应该站在这一行走。
 *
 * 优先取 `doors` 里 `to:"outside"` 门的行——那是她走出去的地方，就是街面，
 * 也是这张图里"地面"的真实高度。
 *
 * 早先取的是**可行走带的中位行**（lo+hi+1)/2：书店 19 行里中位是 y≈9.5，
 * 角色站在屋子中部，脚下是空的，视觉上悬空、阴影也浮在地板之上（2026-11-19 实测被指出）。
 *
 * 无 outside 门时退回可行走带**下沿往上 1 格**（贴地面，但不压在墙上）。
 */
export function walkingRowPx(scene, cell = CELL_DEFAULT) {
  const h = scene?.grid?.h || 0;
  const w = scene?.grid?.w || 0;
  const data = scene?.grid?.data;
  const doors = Array.isArray(scene?.doors) ? scene.doors : [];

  // 1) outside 门的行：最可信的地面高度。
  // 取**最下方**的那个（max y）：下方才是街面/地面；取中位数会在书店这种
  // "两个 outside 门（y=7 侧门 / y=18 正门）"的场景里挑到中间那行，
  // 角色站在屋子中部、脚下悬空（2026-11-19 实测被指出）。
  const outside = doors.filter((d) => d?.to === "outside" && Number.isInteger(d.y));
  if (outside.length) {
    const y = Math.max(...outside.map((d) => d.y));
    return (y + 0.5) * cell;
  }

  // 2) 可行走带下沿：退一格，避免站在最底一行（常是墙脚/门槛）。
  if (data && w > 0 && h > 0) {
    let hi = -1;
    for (let y = h - 1; y >= 0 && hi < 0; y -= 1) {
      for (let x = 0; x < w; x += 1) {
        const t = data[y * w + x];
        if (t === 0 || t === 2) {
          hi = y;
          break;
        }
      }
    }
    if (hi >= 0) return Math.max(0, hi - 1 + 0.5) * cell;
  }

  return h * cell * 0.75;
}

/**
 * @param {{grid:{w:number,h:number,cell?:number,data?:Uint8Array}}[]} scenes 按顺序，第 0 个是 room 段
 * @param {{w:number,h:number}} view
 * @param {{groundRatio?:number,zoom?:number}} [opts]
 */
export function layoutTour(scenes, view, opts = {}) {
  const vw = Math.max(1, view.w);
  const vh = Math.max(1, view.h);
  const groundRatio = Number(opts.groundRatio) > 0 ? Number(opts.groundRatio) : GROUND_RATIO;
  const zoom = Number(opts.zoom) > 0 ? Number(opts.zoom) : WALK_ZOOM;

  const sizes = (scenes || []).map((scene) => {
    const cell = scene?.grid?.cell || CELL_DEFAULT;
    return {
      cell,
      W: Math.max(1, scene.grid.w * cell),
      H: Math.max(1, scene.grid.h * cell),
      row: walkingRowPx(scene, cell),
    };
  });

  // walk 段统一比例：取所有场景所需比例的最大值。
  // 逐场各算会让角色换图时缩放跳变、脚底垂直跳动（实测 37px）。
  let walkK = 0;
  for (const s of sizes.slice(1)) walkK = Math.max(walkK, (vw * zoom) / s.W, vh / s.H);
  if (!walkK) walkK = 1;

  // 统一"行走行屏幕高度"：所有 walk 段共用 feetY，各段 oy 由此反算。
  // 换图时脚底 y 恒定，不随各自可行走带高度上下跳。
  const feetY = vh * groundRatio;

  const segs = sizes.map((s, i) => {
    if (i === 0) {
      // room：整幅可见，并把行走行垫到 GROUND_RATIO 处——
      // contain 后若垂直居中，躺着/站着的人物头顶会顶出画面（实测 head=-65）。
      const fit = Math.min(vw / s.W, vh / s.H) * 0.98;
      const drawW = s.W * fit;
      const drawH = s.H * fit;
      // 按地面比例放，再夹住，保证地图不露出视口外的空白。
      const wantOy = vh * groundRatio - s.row * fit;
      const oy = Math.min(0, Math.max(vh - drawH, wantOy));
      return {
        mode: "room",
        k: fit,
        drawW,
        drawH,
        ox: (vw - drawW) / 2,
        oy,
        x0: 0,
        camMax: 0,
        startPx: 0,
        runPx: 0,
        row: s.row,
        cell: s.cell,
        W: s.W,
        H: s.H,
      };
    }

    const k = walkK;
    const drawW = s.W * k;
    const drawH = s.H * k;
    const camMax = Math.max(0, drawW - vw);
    // 行走行退到门口上方 2 格：`doors` 的 outside 门都压在地图**最后一格**（墙脚），
    // 站在门行上时地图向下只剩半格，屏幕底部空出 90px 纯黑带，角色像悬在半空
    // （2026-11-19 实测被指出）。退 2 格后脚下还有 2.5 格地板，地图越出视口底边。
    const row = Math.max(s.cell * 0.5, s.row - 2 * s.cell);
    return {
      mode: "walk",
      k,
      drawW,
      drawH,
      ox: 0,
      // 统一 feetY：所有 walk 段脚底锁在同一屏幕高度，换图不上下跳。
      // 配合上面的 row 退格，mapBottom = feetY + (H-row)*k ≈ 698 > vh，不露黑边。
      oy: feetY - row * k - s.cell * k * 0.25,
      x0: 0,
      camMax,
      // 进场点：屏幕 CAM_RATIO 处对应的场景内 x。camX=0 时角色已在 40% 位置。
      startPx: (vw * CAM_RATIO) / k,
      // 段长：走到摄像机饱和（camX 到 camMax）所需的场景内里程。
      // 饱和瞬间角色仍在 40% 位置，此刻换图屏幕坐标连续。
      runPx: camMax / k,
      row,
      cell: s.cell,
      feetY,
      W: s.W,
      H: s.H,
    };
  });

  return { segs, groundRatio, zoom, walkK, feetY };
}

/** 摄像机目标：把世界坐标放在屏幕 CAM_RATIO 处，并夹在可滚动范围内。 */
export function cameraTarget(worldX, camMax, vw, ratio = CAM_RATIO) {
  const want = worldX - vw * ratio;
  if (want < 0) return 0;
  if (want > camMax) return camMax;
  return want;
}

/**
 * 从场景 doors 里挑出口格（`to:"outside"`）。
 * 找不到 outside 时退回任意门，再退回 null——绝不默认"最右侧"，
 * 那会走到厕所/阳台（2026-11-19 实测：吃完饭去了卫生间）。
 */
export function pickExit(doors, walkable, from = null) {
  const list = Array.isArray(doors) ? doors : [];
  const usable = (d) => Number.isInteger(d?.x) && Number.isInteger(d?.y) && walkable(d.x, d.y);
  const outside = list.filter((d) => d.to === "outside" && usable(d));
  const pool = outside.length ? outside : list.filter(usable);
  if (!pool.length) return null;
  if (!from || pool.length === 1) return [pool[0].x, pool[0].y];
  let best = pool[0];
  let bestD = Infinity;
  for (const d of pool) {
    const dist = Math.hypot(d.x - from[0], d.y - from[1]);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return [best.x, best.y];
}
