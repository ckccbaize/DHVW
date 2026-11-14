// 场景包：scene.json / intgrid.bin / 三层 PNG / interactions.json / manifest。
// 浏览器与 Node 共用；PNG 编码由调用方注入，设备用 OffscreenCanvas。

import { parseIntGrid } from "./grid.js";

export async function sha256Hex(data) {
  const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function encodePng(image, w, h) {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image), w, h), 0, 0);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("png_encode_failed"))), "image/png");
  });
}

function jsonBlob(value) {
  return new Blob([JSON.stringify(value)], { type: "application/json" });
}

export async function buildScenePackage(scene, baked, {
  encodePngImpl = encodePng,
  hashImpl = sha256Hex,
} = {}) {
  const id = String(scene.id || scene.seed || scene.name || "scene").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  const sceneJson = {
    schema_version: 1,
    id,
    name: scene.name,
    title: scene.title || scene.name,
    kind: scene.kind,
    seed: scene.seed,
    grid: scene.grid || { w: scene.w, h: scene.h, cell: 16 },
    intGrid: "intgrid.bin",
    layers: {
      terrain: "terrain.png",
      furniture: "furniture.png",
      light: { day: "light.png" },
      image: "image.png",
    },
    interactions: "interactions.json",
    rooms: scene.rooms || [],
    doors: scene.doors || [],
    windows: scene.windows || [],
    props: scene.props || [],
    entities: scene.entities || [],
    routes: scene.routes || [],
    meta: scene.meta || {},
  };
  const files = [];
  const add = async (path, blob) => {
    files.push({ path, blob, size: blob.size, sha256: await hashImpl(new Uint8Array(await blob.arrayBuffer())) });
  };
  await add("scene.json", jsonBlob(sceneJson));
  const intGrid = new Uint8Array(scene.intGrid || []);
  await add("intgrid.bin", new Blob([intGrid], { type: "application/octet-stream" }));
  await add("terrain.png", await encodePngImpl(baked.terrain.data, baked.terrain.w, baked.terrain.h));
  await add("furniture.png", await encodePngImpl(baked.furniture.data, baked.furniture.w, baked.furniture.h));
  await add("light.png", await encodePngImpl(baked.light.data, baked.light.w, baked.light.h));
  await add("image.png", await encodePngImpl(baked.image.data, baked.image.w, baked.image.h));
  await add("interactions.json", jsonBlob(scene.interactions || { schema_version: 1, acts: {} }));
  const manifest = {
    schema_version: 1,
    id,
    files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  };
  await add("manifest.json", jsonBlob(manifest));
  return { ok: true, id, sceneJson, manifest, files };
}

export async function saveScenePackage(backend, pkg) {
  for (const f of pkg.files) await backend.putBlob(`scene:${pkg.id}:${f.path}`, f.blob);
  const list = (await backend.getKV("scene_packages")) || [];
  const meta = { id: pkg.id, name: pkg.sceneJson.name, kind: pkg.sceneJson.kind, created_at: Date.now(), manifest: pkg.manifest };
  const next = [meta, ...list.filter((x) => x.id !== pkg.id)].slice(0, 8);
  await backend.setKV("scene_packages", next);
  return meta;
}

export async function loadScenePackage(backend, id) {
  const raw = await backend.getBlob(`scene:${id}:scene.json`);
  if (!raw) return null;
  const sceneJson = JSON.parse(await raw.text());
  const intBlob = await backend.getBlob(`scene:${id}:intgrid.bin`);
  const intGrid = intBlob ? new Uint8Array(await intBlob.arrayBuffer()) : new Uint8Array();
  const interactionsBlob = await backend.getBlob(`scene:${id}:interactions.json`);
  const interactions = interactionsBlob ? JSON.parse(await interactionsBlob.text()) : null;
  const url = async (name) => {
    const b = await backend.getBlob(`scene:${id}:${name}`);
    return b ? URL.createObjectURL(b) : null;
  };
  return {
    sceneJson,
    intGrid,
    interactions,
    imageUrl: await url("image.png"),
    terrainUrl: await url("terrain.png"),
    furnitureUrl: await url("furniture.png"),
    lightUrl: await url("light.png"),
  };
}

/** 把包转成主页面/overview 可用的 scene（grid.data + 图片 URL）。 */
export function sceneFromPackage(pkg) {
  const { sceneJson, intGrid } = pkg;
  const parsed = parseIntGrid(
    Array.from({ length: sceneJson.grid.h }, (_, y) =>
      Array.from(intGrid.slice(y * sceneJson.grid.w, (y + 1) * sceneJson.grid.w)).join(""),
    ),
  );
  return {
    ...sceneJson,
    grid: { ...sceneJson.grid, data: parsed.data },
    imageUrl: pkg.imageUrl,
    image2xUrl: pkg.imageUrl,
    interactions: pkg.interactions,
    hotspots: [],
  };
}
