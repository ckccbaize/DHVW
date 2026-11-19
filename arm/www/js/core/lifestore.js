// LifeStore：视图唯一数据源（PROJECT-PLAN §10.7.4 ②）。
// 视图只订阅它，不知道数据来自 WS（RemoteRuntime）还是 Worker（LocalRuntime）。

export function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();
  const bus = new Map();

  return {
    get state() {
      return state;
    },
    /** 浅合并 patch，通知订阅者。返回实际变更的键。 */
    patch(patch) {
      const changed = [];
      for (const k of Object.keys(patch)) {
        if (state[k] !== patch[k]) changed.push(k);
        state[k] = patch[k];
      }
      if (changed.length) for (const fn of listeners) fn(state, changed);
      return changed;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** 瞬时事件（气泡/生活事件/资产），不进状态。 */
    emit(name, payload) {
      const set = bus.get(name);
      if (!set) return;
      for (const fn of set) fn(payload);
    },
    on(name, fn) {
      if (!bus.has(name)) bus.set(name, new Set());
      bus.get(name).add(fn);
      return () => bus.get(name).delete(fn);
    },
  };
}
