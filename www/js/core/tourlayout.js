// 巡演布局：把一串场景排成一条连续街景带的纯计算（可测，不碰 DOM）。
//
// 两条必须成立的不变量：
//   1. 街景带内所有场景共用**同一个像素比例**。逐场"铺满宽度"会让角色每过一道门就放大缩小，
//      接缝必穿帮；同比例才谈得上无缝。
//   2. 比例取 cover 的最大值：每段都盖满视口，且地面线对齐屏幕底部（多出的顶部裁掉）。
//
// 室内首段（家）另用 contain 比例整屋居中，与总观原有口径一致。

export const CELL_DEFAULT = 16;

/**
 * @param {{grid:{w:number,h:number,cell?:number}}[]} scenes 按街景顺序排列，第 0 个是室内首段
 * @param {{w:number,h:number}} view 视口像素
 * @returns {{stripK:number,totalW:number,rooms:{roomK:number,roomW:number,roomH:number,stripK:number,stripW:number,stripH:number,stripTop:number,x0:number}[]}}
 */
export function layoutTour(scenes, view) {
  const vw = Math.max(1, view.w);
  const vh = Math.max(1, view.h);
  const sizes = (scenes || []).map((s) => {
    const cell = s?.grid?.cell || CELL_DEFAULT;
    return { W: Math.max(1, s.grid.w * cell), H: Math.max(1, s.grid.h * cell), cell };
  });

  let stripK = 0;
  for (const s of sizes) stripK = Math.max(stripK, vw / s.W, vh / s.H);
  if (!stripK) stripK = 1;

  const rooms = [];
  let x = 0;
  for (const s of sizes) {
    const stripW = s.W * stripK;
    const stripH = s.H * stripK;
    rooms.push({
      roomK: Math.min(vw / s.W, vh / s.H),
      roomW: s.W * Math.min(vw / s.W, vh / s.H),
      roomH: s.H * Math.min(vw / s.W, vh / s.H),
      stripK,
      stripW,
      stripH,
      // 底边贴屏幕底；高度不足时垂直居中。
      stripTop: stripH >= vh ? vh - stripH : (vh - stripH) / 2,
      x0: x,
    });
    x += stripW;
  }
  return { stripK, totalW: x, rooms };
}

/** 摄像机目标：把角色放在屏幕 40% 处，并夹在带子两端内。 */
export function cameraTarget(worldX, camMax, vw, ratio = 0.4) {
  const want = worldX - vw * ratio;
  return want < 0 ? 0 : want > camMax ? camMax : want;
}

/** 世界坐标 → 屏幕坐标（街景带）；camX 由摄像机维护。 */
export function screenX(worldX, camX) {
  return worldX - camX;
}
