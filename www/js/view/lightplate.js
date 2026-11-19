// 光照色板：总观与巡演共用（避免两处各写一份光罩）。
// 关键：光罩必须画在**离屏层**再整张合成。直接在主画布上调用会先 clearRect 把场景擦掉
// （2026-11-19 巡演黑屏即此因），所以这里只提供 emitPlate + 带缓存的 createLightPlate。

export const LIGHT_PLATES = {
  dawn: { top: "rgba(255,180,120,0.16)", bottom: "rgba(60,40,80,0.10)", vignette: 0.22 },
  day: { top: "rgba(255,240,210,0.05)", bottom: "rgba(0,0,0,0.02)", vignette: 0.12 },
  dusk: { top: "rgba(255,140,90,0.20)", bottom: "rgba(40,20,60,0.16)", vignette: 0.26 },
  night: { top: "rgba(40,60,140,0.34)", bottom: "rgba(10,16,40,0.30)", vignette: 0.42 },
  rain: { top: "rgba(90,120,150,0.26)", bottom: "rgba(30,40,60,0.22)", vignette: 0.34 },
  snow: { top: "rgba(220,235,250,0.22)", bottom: "rgba(120,140,170,0.14)", vignette: 0.20 },
};

/** 在空白 ctx 的 (0,0,w,h) 上画一层光罩：线性渐变 + 暗角。只对离屏层用。 */
export function paintLightPlate(ctx, w, h, key) {
  const p = LIGHT_PLATES[key] || LIGHT_PLATES.day;
  ctx.clearRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, p.top);
  g.addColorStop(1, p.bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  const v = ctx.createRadialGradient(w / 2, h / 2, h * 0.34, w / 2, h / 2, h * 0.95);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, `rgba(0,0,0,${p.vignette})`);
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}

/**
 * 带缓存的合成器：只在尺寸或档位变化时重绘离屏层，其余帧只做一次 drawImage。
 * 返回 paint(targetCtx, w, h, key)，可安全用在主画布上。
 */
export function createLightPlate() {
  let layer = null;
  let layerCtx = null;
  let key = null;
  let w = 0;
  let h = 0;
  return function paint(targetCtx, tw, th, nextKey) {
    const k = nextKey in LIGHT_PLATES ? nextKey : "day";
    if (!layer || w !== tw || h !== th) {
      layer = document.createElement("canvas");
      layer.width = tw;
      layer.height = th;
      layerCtx = layer.getContext("2d");
      w = tw;
      h = th;
      key = null;
    }
    if (key !== k) {
      paintLightPlate(layerCtx, tw, th, k);
      key = k;
    }
    targetCtx.drawImage(layer, 0, 0);
  };
}
