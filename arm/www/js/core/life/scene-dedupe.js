// 场景请求去重（纯函数）：设备侧与测试共用。
// 缺陷背景：请求 id 每次新生成（scene-library-21），PC 只按 id 去重，
// 于是同一地点会被反复生成。唯一可靠口径是「地点身份」——已有场景的地点永不重复申请。

/** 场景包目录名是否属于该地点（`library` 或 `indoor-6-library`）。 */
export function sceneDirMatchesPlace(dir, placeId) {
  const d = String(dir || "").trim();
  const id = String(placeId || "").trim();
  if (!d || !id) return false;
  return d === id || d.endsWith(`-${id}`);
}

/**
 * 从缓存键路径里找出该地点的场景目录。
 * 键形如 `/assets/scenes/<dir>/<file>`；只认 `<dir>.built.json`。
 */
export function findSceneDirForPlace(paths = [], placeId) {
  const id = String(placeId || "").trim();
  if (!id) return "";
  for (const raw of paths) {
    const path = String(raw || "");
    const m = /\/assets\/scenes\/([^/]+)\/([^/]+)$/.exec(path);
    if (!m) continue;
    const [, dir, file] = m;
    if (file !== `${dir}.built.json`) continue;
    if (sceneDirMatchesPlace(dir, id)) return dir;
  }
  return "";
}

/**
 * 启动清理：同一地点只保留一条请求，并丢掉已有场景的 pending。
 * @param {Array} requests 已按日期过滤的请求
 * @param {(placeId: string) => boolean} hasScene 该地点是否已有场景（同步结果）
 */
export function dedupeSceneRequests(requests = [], hasScene = () => false) {
  const rank = (x) => (x.status === "ready" ? 3 : x.status === "failed" ? 2 : 1);
  const byPlace = new Map();
  for (const r of requests) {
    if (!r || !r.placeId) continue;
    if (r.status === "pending" && hasScene(r.placeId)) continue;
    const prev = byPlace.get(r.placeId);
    if (!prev) {
      byPlace.set(r.placeId, r);
      continue;
    }
    if (rank(r) > rank(prev) || (rank(r) === rank(prev) && (r.createdAt || 0) > (prev.createdAt || 0))) {
      byPlace.set(r.placeId, r);
    }
  }
  return [...byPlace.values()];
}

/**
 * 是否应新发一条场景请求。任一成立就不发。
 * @param {object} ctx
 * @param {boolean} ctx.hasScene      该地点已有场景包
 * @param {Array} ctx.requests        现有请求
 * @param {string} ctx.placeId
 * @param {number} ctx.day            本次计划所在天
 */
export function shouldEnqueueScene({ hasScene = false, requests = [], placeId = "", day = 0 } = {}) {
  const id = String(placeId || "").trim();
  if (!id) return false;
  if (hasScene) return false;
  if (requests.some((r) => r && r.placeId === id && (r.status === "pending" || r.status === "ready"))) return false;
  // 同一天失败过就不再重提，避免每个 tick 都烧一次；换天或手动重试才允许。
  if (requests.some((r) => r && r.placeId === id && r.status === "failed" && Number(r.day) === Number(day))) return false;
  return true;
}
