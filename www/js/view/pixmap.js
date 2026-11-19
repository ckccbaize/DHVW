// 像素资源加载（Cache Storage 优先）：总观与巡演共用同一份读法。
// 场景包由 PC 通过 scene:ready 写进 dhvw-scenes-v1；缓存命中时离线也能拿到同一张图。

export async function loadCachedImage(url) {
  let src = url;
  let objectUrl = "";
  if (typeof caches !== "undefined" && typeof location !== "undefined") {
    try {
      const cache = await caches.open("dhvw-scenes-v1");
      const hit = await cache.match(new URL(url, location.href).href);
      if (hit) {
        objectUrl = URL.createObjectURL(await hit.blob());
        src = objectUrl;
      }
    } catch {
      /* Cache API 不可用时直接走网络 */
    }
  }
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  await img.decode();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  return img;
}

/** 同一份 cache-first 语义的 JSON 读取（角色图集等）。 */
export async function loadCachedJSON(url) {
  try {
    if (typeof caches !== "undefined" && typeof location !== "undefined") {
      const cache = await caches.open("dhvw-scenes-v1");
      const hit = await cache.match(new URL(url, location.href).href);
      if (hit) return await hit.json();
    }
  } catch {
    /* 回退网络 */
  }
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}
