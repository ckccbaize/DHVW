// 本机性能浮层（?perf=1）：FPS / JS 堆 / 长任务 / DOM 节点。
export function createPerfOverlay({ getFps = () => 0, now = () => performance.now() } = {}) {
  const el = document.createElement("div");
  el.className = "perf-overlay";
  el.textContent = "perf …";
  document.body.appendChild(el);

  let longTasks = 0;
  let maxTask = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks += 1;
        maxTask = Math.max(maxTask, e.duration);
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    /* 不支持 longtask 的环境忽略 */
  }

  const timer = setInterval(() => {
    const m = performance.memory;
    const heap = m ? (m.usedJSHeapSize / 1048576).toFixed(1) : "—";
    el.textContent = `fps ${getFps()} · heap ${heap}MB · long ${longTasks}${maxTask ? `/${maxTask.toFixed(0)}ms` : ""} · dom ${document.querySelectorAll("*").length}`;
  }, 1000);

  return {
    el,
    stop() {
      clearInterval(timer);
      el.remove();
    },
    stats() {
      return { longTasks, maxTask, heap: performance.memory?.usedJSHeapSize || 0 };
    },
  };
}
