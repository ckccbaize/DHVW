// 重新生成 www/assets/scenes/<id>/manifest.json（场景包内清单）。
// 设备运行必需的固定 8 件；scene 字段强制与目录名一致，避免复制场景后残留旧 id。
// 用法：node tools/pack-scenes.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "www", "assets", "scenes");

// 与 scripts/pack_scene.py 的产出一致：只登记设备侧必需的固定文件。
export const PACK_FILES = [
  "scene.json",
  "intgrid.bin",
  "terrain.png",
  "furniture.png",
  "light_day.png",
  "interactions.json",
  "character/sheet.png",
  "character/sheet.json",
];

const sha256 = async (p) =>
  crypto.createHash("sha256").update(await fs.readFile(p)).digest("hex");

const dirs = (await fs.readdir(ROOT, { withFileTypes: true }))
  .filter((ent) => ent.isDirectory())
  .map((ent) => ent.name)
  .sort();

let total = 0;
for (const id of dirs) {
  const dir = path.join(ROOT, id);
  const files = [];
  for (const rel of PACK_FILES) {
    const abs = path.join(dir, ...rel.split("/"));
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      throw new Error(`场景包 ${id} 缺少 ${rel}`);
    }
    if (!st.isFile()) throw new Error(`场景包 ${id} 的 ${rel} 不是文件`);
    files.push({ path: rel, size: st.size, sha256: await sha256(abs) });
  }
  const manifest = {
    schema_version: 1,
    scene: id,
    generated_by: "tools/pack-scenes.mjs",
    files,
  };
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n", "utf8");
  total += 1;
  console.log(`✓ ${id}  ${files.length} 件`);
}
console.log(`场景包清单：${total} 个场景`);
