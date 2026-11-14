// 场景加载（V1）：built.json → 网格 + 热点 + 图片 URL。
import { buildHotspots, parseIntGrid } from "../core/grid.js";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("dhvw", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of ["events", "assets", "blobs", "kv"]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: name === "events" ? "uuid" : name === "assets" ? "id" : name === "blobs" ? "id" : "k" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** 从 IndexedDB 场景包加载（ARM 生成场景进入主页面）。 */
export async function loadGeneratedScene(id) {
  const db = await openDb();
  try {
    const row = await idbGet(db, "blobs", `scene:${id}:scene.json`);
    if (!row?.blob) throw new Error("场景包不存在");
    const sceneJson = JSON.parse(await row.blob.text());
    const intRow = await idbGet(db, "blobs", `scene:${id}:intgrid.bin`);
    const intGrid = intRow?.blob ? new Uint8Array(await intRow.blob.arrayBuffer()) : new Uint8Array();
    const irRow = await idbGet(db, "blobs", `scene:${id}:interactions.json`);
    const interactions = irRow?.blob ? JSON.parse(await irRow.blob.text()) : null;
    const imgRow = await idbGet(db, "blobs", `scene:${id}:image.png`) || await idbGet(db, "blobs", `scene:${id}:terrain.png`);
    const imageUrl = imgRow?.blob ? URL.createObjectURL(imgRow.blob) : null;
    const rows = Array.from({ length: sceneJson.grid.h }, (_, y) =>
      Array.from(intGrid.slice(y * sceneJson.grid.w, (y + 1) * sceneJson.grid.w)).join(""),
    );
    const parsed = parseIntGrid(rows);
    const scene = {
      ...sceneJson,
      grid: { ...sceneJson.grid, data: parsed.data },
      imageUrl,
      image2xUrl: imageUrl,
      interactions,
    };
    scene.hotspots = buildHotspots(scene, interactions);
    return scene;
  } finally {
    db.close();
  }
}

export async function loadScene(name = "home", { fetchImpl = globalThis.fetch } = {}) {
  const base = `assets/scenes/${name}`;
  const res = await fetchImpl(`${base}/${name}.built.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`场景加载失败 ${res.status}`);
  const raw = await res.json();
  const parsed = parseIntGrid(raw.intGrid);
  const scene = {
    ...raw,
    grid: { w: parsed.w, h: parsed.h, cell: raw.grid?.cell || 16, data: parsed.data },
    imageUrl: `${base}/${raw.image || `${name}.png`}`,
    image2xUrl: `${base}/${raw.image2x || `${name}@2x.png`}`,
  };
  try {
    const ir = await fetchImpl(`${base}/interactions.json`, { cache: "no-store" });
    if (ir.ok) scene.interactions = await ir.json();
  } catch {
    scene.interactions = null;
  }
  scene.hotspots = buildHotspots(scene, scene.interactions);
  return scene;
}
