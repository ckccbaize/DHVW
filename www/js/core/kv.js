// 通用 KV（IndexedDB kv store / 内存），供服务商配置等使用。

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export function createIdbKvBackend(db) {
  const store = (mode = "readonly") => db.transaction("kv", mode).objectStore("kv");
  return {
    async get(k) {
      const row = await wrap(store().get(k));
      return row ? row.v : null;
    },
    async put(k, v) {
      await wrap(store("readwrite").put({ k, v }));
      return v;
    },
    async delete(k) {
      await wrap(store("readwrite").delete(k));
    },
  };
}

export function createMemoryKvBackend() {
  const rows = new Map();
  return {
    async get(k) {
      return rows.has(k) ? rows.get(k) : null;
    },
    async put(k, v) {
      rows.set(k, v);
      return v;
    },
    async delete(k) {
      rows.delete(k);
    },
  };
}
