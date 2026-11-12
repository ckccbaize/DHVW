// 主线程侧的核心机客户端：启动 Worker、请求/响应、推送分发。
// 契约见 docs/CONTRACTS.md §1。

import { makeMsg, validateMsg, createTracker } from "./bus.js";

export function createCoreClient({
  workerUrl = new URL("./worker.js", import.meta.url),
  WorkerImpl = globalThis.Worker,
  timeoutMs = 5000,
  onMessage = () => {},
  onError = () => {},
} = {}) {
  let worker = null;
  const tracker = createTracker({ timeoutMs });

  function handle(msg) {
    const v = validateMsg(msg);
    if (!v.ok) {
      onError(Object.assign(new Error(v.msg), { code: v.code }));
      return;
    }
    if (tracker.settle(msg)) return;
    onMessage(msg);
  }

  return {
    get running() {
      return !!worker;
    },
    start() {
      if (worker) return;
      worker = new WorkerImpl(workerUrl, { type: "module" });
      worker.onmessage = (e) => handle(e.data);
      worker.onerror = (e) => onError(e.error || new Error(e.message || "worker error"));
    },
    stop() {
      if (worker) worker.terminate();
      worker = null;
      tracker.rejectAll("stopped");
    },
    send(type, payload = {}) {
      if (!worker) throw new Error("client not started");
      worker.postMessage(makeMsg(type, payload));
    },
    request(type, payload = {}, { timeout } = {}) {
      if (!worker) return Promise.reject(new Error("client not started"));
      const msg = makeMsg(type, payload);
      const p = tracker.track(msg.id, { timeout });
      worker.postMessage(msg);
      return p;
    },
  };
}
