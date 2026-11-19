// 任务调度器（W10）：优先级队列 + 切片让位 + 持久化。
// 只调度生成/归纳任务（P2–P5），不调度 life tick。
// 语义见 WORLD-CORE-SPEC.md §8：active 不跑、idle 跑、asleep 满速、present 全停。

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export function createIdbJobBackend(db) {
  const store = (mode = "readonly") => db.transaction("jobs", mode).objectStore("jobs");
  return {
    async put(job) {
      await wrap(store("readwrite").put(job));
      return job;
    },
    async delete(id) {
      await wrap(store("readwrite").delete(id));
    },
    async getAll() {
      return wrap(store().getAll());
    },
    async clear() {
      await wrap(store("readwrite").clear());
    },
  };
}

export function createMemoryJobBackend() {
  const rows = new Map();
  return {
    async put(job) {
      rows.set(job.id, { ...job });
      return job;
    },
    async delete(id) {
      rows.delete(id);
    },
    async getAll() {
      return [...rows.values()].map((j) => ({ ...j }));
    },
    async clear() {
      rows.clear();
    },
  };
}

let seq = 0;
const nextId = () => `job-${Date.now().toString(36)}-${++seq}`;

/**
 * @param {object} p
 * @param {object} p.backend          任务持久化后端
 * @param {function} [p.now]
 * @param {number} [p.maxSliceMs]     单任务切片上限（默认 5000）
 * @param {function} [p.onEvent]      (event) => void
 */
export function createScheduler({
  backend,
  now = () => Date.now(),
  maxSliceMs = 5000,
  onEvent = () => {},
} = {}) {
  if (!backend) throw new Error("createScheduler 需要 backend");
  const queue = [];
  const runners = new Map();
  const idleWaiters = [];
  let activity = "active"; // active | idle | asleep
  let present = false;
  let safeMode = false;
  let paused = false;
  let stopped = false;
  let pumpPromise = null;
  let loaded = false;
  const stats = { done: 0, failed: 0, interrupted: 0 };

  function blocked() {
    return stopped || paused || present || safeMode || activity === "active";
  }

  function resolveIdle() {
    if (pumpPromise) return;
    if (queue.length === 0 || blocked()) {
      while (idleWaiters.length) idleWaiters.shift()();
    }
  }

  function takeNext() {
    if (!queue.length) return null;
    queue.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    return queue.shift();
  }

  async function persist(job) {
    try {
      await backend.put(job);
    } catch {
      /* 持久化失败不阻塞执行 */
    }
  }

  async function pump() {
    if (pumpPromise) return pumpPromise;
    pumpPromise = (async () => {
      while (!blocked()) {
        const job = takeNext();
        if (!job) break;
        job.status = "running";
        job.startedAt = now();
        await persist(job);
        // 持久化是异步的，期间活动度/present 可能变化；变化则退回队列
        if (blocked()) {
          job.status = "queued";
          job.startedAt = null;
          queue.push(job);
          await persist(job);
          break;
        }
        onEvent({ type: "job_start", job });

        const sliceStart = now();
        const shouldYield = () => blocked() || now() - sliceStart > maxSliceMs;
        try {
          const runner = runners.get(job.kind);
          if (!runner) throw Object.assign(new Error(`缺少 runner: ${job.kind}`), { code: "no_runner" });
          await runner(job.payload || {}, { job, shouldYield });
          job.status = "done";
          job.finishedAt = now();
          stats.done += 1;
          onEvent({ type: "job_done", job });
          await backend.delete(job.id);
        } catch (err) {
          if (err && err.code === "yield") {
            job.status = "queued";
            job.startedAt = null;
            queue.push(job);
            await persist(job);
            onEvent({ type: "job_yield", job });
            break;
          }
          job.status = "failed";
          job.finishedAt = now();
          job.error = String(err && err.message ? err.message : err);
          stats.failed += 1;
          onEvent({ type: "job_fail", job });
          await backend.delete(job.id);
        }
      }
    })().finally(() => {
      pumpPromise = null;
      if (!blocked() && queue.length) setTimeout(() => void pump(), 0);
      resolveIdle();
    });
    return pumpPromise;
  }

  return {
    register(kind, runner) {
      runners.set(kind, runner);
    },
    async init() {
      if (loaded) return;
      const jobs = await backend.getAll();
      for (const job of jobs) {
        if (job.status === "running") {
          job.status = "interrupted";
          stats.interrupted += 1;
          await persist(job);
          onEvent({ type: "job_interrupt", job });
        } else if (job.status === "queued") {
          queue.push(job);
        }
      }
      loaded = true;
      return queue.length;
    },
    enqueue({ kind, payload = {}, priority = 5 } = {}) {
      if (!kind) throw new Error("任务缺少 kind");
      const job = {
        id: nextId(),
        kind,
        payload,
        priority,
        status: "queued",
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        error: null,
      };
      queue.push(job);
      void persist(job);
      onEvent({ type: "job_enqueue", job });
      void pump();
      return job;
    },
    cancel(id) {
      const i = queue.findIndex((j) => j.id === id);
      if (i < 0) return false;
      queue.splice(i, 1);
      void backend.delete(id);
      return true;
    },
    setActivity(level) {
      activity = level === "asleep" ? "asleep" : level === "idle" ? "idle" : "active";
      if (!blocked()) void pump();
      else resolveIdle();
    },
    setPresent(on) {
      present = !!on;
      if (!blocked()) void pump();
      else resolveIdle();
    },
    setSafeMode(on) {
      safeMode = !!on;
      if (!blocked()) void pump();
      else resolveIdle();
    },
    pause() {
      paused = true;
      resolveIdle();
    },
    resume() {
      paused = false;
      void pump();
    },
    stop() {
      stopped = true;
      resolveIdle();
    },
    whenIdle() {
      if (!pumpPromise && (queue.length === 0 || blocked())) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
    get stats() {
      return {
        queued: queue.length,
        running: pumpPromise ? 1 : 0,
        activity,
        present,
        safeMode,
        paused,
        ...stats,
      };
    },
    get queue() {
      return queue.map((j) => ({ ...j }));
    },
    blocked,
  };
}
