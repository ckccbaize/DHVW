// 地图烘焙客户端（W31）：主线程调用 forge.worker，拿到可绘制的 ImageData。
export function createForgeClient({
  workerUrl = new URL("./worker.js", import.meta.url),
  WorkerImpl = globalThis.Worker,
  timeoutMs = 10000,
} = {}) {
  let worker = null;
  let seq = 0;
  const pending = new Map();

  function ensure() {
    if (worker) return worker;
    worker = new WorkerImpl(workerUrl, { type: "module" });
    worker.onmessage = (e) => {
      const msg = e.data || {};
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (!msg.ok) {
        p.reject(new Error(msg.error || "forge failed"));
        return;
      }
      const toImage = (buf, w, h) => new ImageData(new Uint8ClampedArray(buf), w, h);
      p.resolve({
        ms: msg.ms,
        built: msg.built,
        terrain: toImage(msg.terrain, msg.dims.w, msg.dims.h),
        furniture: toImage(msg.furniture, msg.dims.w, msg.dims.h),
        light: toImage(msg.light, msg.dims.w, msg.dims.h),
        image: toImage(msg.image, msg.dims.w, msg.dims.h),
        image2x: toImage(msg.image2x, msg.dims.w2, msg.dims.h2),
      });
    };
    worker.onerror = (e) => {
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(e.error || new Error(e.message || "forge worker error"));
      }
      pending.clear();
    };
    return worker;
  }

  return {
    bake(spec) {
      const w = ensure();
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("forge timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        w.postMessage({ id, spec });
      });
    },
    stop() {
      if (worker) worker.terminate();
      worker = null;
      for (const [, p] of pending) clearTimeout(p.timer);
      pending.clear();
    },
  };
}
