// 地图烘焙 Worker（W31）：接收 scene spec，返回三层/合成/2x/built。
import { buildScene } from "./scene.js";

self.onmessage = (e) => {
  const { id, spec } = e.data || {};
  if (!id || !spec) return;
  const t0 = performance.now();
  try {
    const scene = buildScene(spec);
    const ms = performance.now() - t0;
    const payload = {
      id,
      ok: true,
      ms,
      built: scene.built,
      terrain: scene.terrain.data.buffer,
      furniture: scene.furniture.data.buffer,
      light: scene.light.data.buffer,
      image: scene.image.data.buffer,
      image2x: scene.image2x.data.buffer,
      dims: {
        w: scene.image.w,
        h: scene.image.h,
        w2: scene.image2x.w,
        h2: scene.image2x.h,
      },
    };
    self.postMessage(payload, [
      payload.terrain,
      payload.furniture,
      payload.light,
      payload.image,
      payload.image2x,
    ]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message });
  }
};
