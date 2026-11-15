// 场景加载（V1）：built.json → 网格 + 热点 + 图片 URL。
import { buildHotspots, parseIntGrid } from "../core/grid.js";

async function fetchAsset(url, fetchImpl) {
  if (typeof caches !== "undefined" && typeof location !== "undefined") {
    try {
      const cache = await caches.open("dhvw-scenes-v1");
      const hit = await cache.match(new URL(url, location.href).href);
      if (hit) return hit;
    } catch {
      /* Cache API 不可用时回退网络 */
    }
  }
  return fetchImpl(url, { cache: "no-store" });
}

export async function loadScene(name = "home", { fetchImpl = globalThis.fetch } = {}) {
  const base = `assets/scenes/${name}`;
  const res = await fetchAsset(`${base}/${name}.built.json`, fetchImpl);
  if (!res.ok) throw new Error(`场景加载失败 ${res.status}`);
  const raw = await res.json();
  const parsed = parseIntGrid(raw.intGrid);
  const scene = {
    ...raw,
    grid: { w: parsed.w, h: parsed.h, cell: raw.grid?.cell || 16, data: parsed.data },
    imageUrl: `${base}/${raw.image || `${name}.png`}`,
    image2xUrl: `${base}/${raw.image2x || `${name}@2x.png`}`,
  };
  try {
    const ir = await fetchAsset(`${base}/interactions.json`, fetchImpl);
    if (ir.ok) scene.interactions = await ir.json();
  } catch {
    scene.interactions = null;
  }
  scene.hotspots = buildHotspots(scene, scene.interactions);
  return scene;
}
