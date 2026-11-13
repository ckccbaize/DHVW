// 统一世界摘要（W14+）：把状态、日程、事件、场景请求、PC 动作整理成一份可读数据。
// 设备落 kv + POST /__digest（壳写 data/digest.json）+ WS world:digest 推给 PC。

export function buildDigest({
  now = Date.now(),
  seq = 0,
  clock = {},
  world = {},
  life = {},
  agenda = [],
  sceneRequests = [],
  pcActions = [],
  recentEvents = [],
  budget = null,
  eventPool = null,
  outing = null,
  lastPlot = null,
  mood = null,
} = {}) {
  return {
    v: 1,
    ts: now,
    seq,
    clock,
    world,
    life,
    agenda,
    sceneRequests,
    pcActions,
    recentEvents,
    budget,
    eventPool,
    outing,
    lastPlot,
    mood,
  };
}

export function createDigestStore({
  backend,
  fetchImpl = globalThis.fetch,
  url = "/__digest",
  now = () => Date.now(),
} = {}) {
  if (!backend) throw new Error("createDigestStore 需要 backend");
  let lastSavedAt = 0;

  return {
    async save(digest) {
      try {
        await backend.put("digest", digest);
      } catch {
        /* 本地持久化失败不阻塞外发 */
      }
      try {
        await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(digest),
        });
      } catch {
        /* 壳不支持或离线时忽略 */
      }
      lastSavedAt = now();
      return digest;
    },
    get lastSavedAt() {
      return lastSavedAt;
    },
  };
}
