// 核心机 IndexedDB（W5/W6/W7/W10）。
// 库：dhvw-core v4；store：events + kv（快照）+ memory（记忆）+ jobs（调度队列）。

export function openCoreDb(indexedDBImpl = globalThis.indexedDB, name = "dhvw-core", version = 4) {
  if (!indexedDBImpl) return Promise.reject(new Error("indexedDB 不可用"));
  return new Promise((resolve, reject) => {
    const req = indexedDBImpl.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("events")) {
        const store = db.createObjectStore("events", { keyPath: "seq" });
        store.createIndex("uuid", "uuid", { unique: true });
      }
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv", { keyPath: "k" });
      }
      if (!db.objectStoreNames.contains("memory")) {
        db.createObjectStore("memory", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("jobs")) {
        db.createObjectStore("jobs", { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 其他连接需要让路，否则版本升级会被 blocked
      db.onversionchange = () => {
        try {
          db.close();
        } catch {}
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("indexedDB blocked（其他页面占用旧版本）"));
  });
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

function cursorAll(store, { direction = "next", limit = Infinity, range = null } = {}) {
  return new Promise((resolve, reject) => {
    const out = [];
    const req = store.openCursor(range, direction);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || out.length >= limit) return resolve(out);
      out.push(cur.value);
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export function createIdbEventBackend(db) {
  const store = (mode = "readonly") => db.transaction("events", mode).objectStore("events");

  return {
    async append(rec) {
      try {
        await wrap(store("readwrite").add(rec));
        return true;
      } catch (err) {
        if (err && err.name === "ConstraintError") return false; // uuid 重复
        throw err;
      }
    },
    async count() {
      return wrap(store().count());
    },
    async lastSeq() {
      const rows = await cursorAll(store(), { direction: "prev", limit: 1 });
      return rows.length ? rows[0].seq : 0;
    },
    async oldest(n) {
      return cursorAll(store(), { direction: "next", limit: n });
    },
    async latest(n) {
      return cursorAll(store(), { direction: "prev", limit: n });
    },
    async since(seq, limit = 200) {
      const range = IDBKeyRange.lowerBound(seq, true);
      return cursorAll(store(), { direction: "next", limit, range });
    },
    async deleteSeqs(seqs) {
      if (!seqs.length) return;
      const s = store("readwrite");
      await Promise.all(seqs.map((seq) => wrap(s.delete(seq))));
    },
    async clear() {
      await wrap(store("readwrite").clear());
    },
  };
}
