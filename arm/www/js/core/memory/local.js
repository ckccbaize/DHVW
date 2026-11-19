// 本地记忆（W7）：索引 + 可插拔存储（IndexedDB / 内存）。
// 设备只做字面召回；语义召回走 PC（W8）。

import { createBigramIndex } from "./index.js";

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export function createIdbMemoryBackend(db) {
  const store = (mode = "readonly") => db.transaction("memory", mode).objectStore("memory");
  return {
    async put(doc) {
      await wrap(store("readwrite").put(doc));
      return doc;
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

export function createMemoryDocBackend() {
  const rows = new Map();
  return {
    async put(doc) {
      rows.set(doc.id, doc);
      return doc;
    },
    async delete(id) {
      rows.delete(id);
    },
    async getAll() {
      return [...rows.values()];
    },
    async clear() {
      rows.clear();
    },
  };
}

/**
 * 本地记忆：启动时从后端重建索引；写入同时落库。
 * now 用于时间衰减（应传校正后的时间）。
 */
export function createLocalMemory({ backend, now = () => Date.now(), halfLifeDays = 30 } = {}) {
  if (!backend) throw new Error("createLocalMemory 需要 backend");
  const index = createBigramIndex({ halfLifeDays });
  let loaded = false;

  async function init() {
    if (loaded) return index.size;
    const docs = await backend.getAll();
    for (const d of docs) index.add(d);
    loaded = true;
    return index.size;
  }

  return {
    init,
    async add(doc) {
      if (!doc || !doc.id || !doc.text) throw new Error("文档需要 id 与 text");
      const rec = {
        id: doc.id,
        text: doc.text,
        t: Number.isFinite(doc.t) ? doc.t : now(),
        tier: doc.tier || null,
        meta: doc.meta || null,
      };
      await backend.put(rec);
      index.add(rec);
      return rec;
    },
    async remove(id) {
      await backend.delete(id);
      return index.remove(id);
    },
    async clear() {
      await backend.clear();
      index.clear();
    },
    search(text, opts = {}) {
      return index.search(text, { now: now(), ...opts });
    },
    get count() {
      return index.size;
    },
    get terms() {
      return index.terms;
    },
    all: () => index.all(),
  };
}
