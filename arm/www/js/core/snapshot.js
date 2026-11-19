// 快照存储（W6）：状态机 + 生活状态 + lastSeq 落 IndexedDB kv。
// 后端可插拔：IndexedDB（设备）/ 内存（测试、降级）。

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export function createSnapshotStore(db) {
  const store = (mode = "readonly") => db.transaction("kv", mode).objectStore("kv");
  return {
    async save(snapshot) {
      await wrap(store("readwrite").put({ k: "snapshot", v: snapshot }));
      return snapshot;
    },
    async load() {
      const row = await wrap(store().get("snapshot"));
      return row ? row.v : null;
    },
    async clear() {
      await wrap(store("readwrite").delete("snapshot"));
    },
  };
}

export function createMemorySnapshotStore() {
  let current = null;
  return {
    async save(snapshot) {
      current = snapshot;
      return snapshot;
    },
    async load() {
      return current;
    },
    async clear() {
      current = null;
    },
  };
}

/** 快照结构校验；坏快照返回 null（调用方回退到初始态）。 */
export function validateSnapshot(snap) {
  if (!snap || typeof snap !== "object") return null;
  if (snap.v !== 1) return null;
  if (!Number.isFinite(snap.ts) || !Number.isFinite(snap.lastSeq)) return null;
  if (!snap.world || typeof snap.world !== "object") return null;
  if (!snap.life || typeof snap.life !== "object") return null;
  return snap;
}
