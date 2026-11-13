// 场景加载（V1）：built.json → 网格 + 热点 + 图片 URL。
import { buildHotspots, parseIntGrid } from "../core/grid.js";

export async function loadScene(name = "home", { fetchImpl = globalThis.fetch } = {}) {
  const base = `assets/scenes/${name}`;
  const res = await fetchImpl(`${base}/${name}.built.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`场景加载失败 ${res.status}`);
  const raw = await res.json();
  const parsed = parseIntGrid(raw.intGrid);
  const scene = {
    ...raw,
    grid: { w: parsed.w, h: parsed.h, cell: raw.grid?.cell || 16, data: parsed.data },
    imageUrl: `${base}/${raw.image || `${name}.png`}`,
    image2xUrl: `${base}/${raw.image2x || `${name}@2x.png`}`,
  };
  scene.hotspots = buildHotspots(scene);
  return scene;
}
