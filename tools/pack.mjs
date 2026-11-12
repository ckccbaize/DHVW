// 生成 www/manifest.json：资源包清单（路径 / 大小 / sha256），作为部署校验基准。
// 用法：node tools/pack.mjs
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "www");
const MANIFEST = path.join(ROOT, "manifest.json");

async function walk(dir, base = "") {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(abs, rel)));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

const sha256 = async (p) =>
  crypto.createHash("sha256").update(await fs.readFile(p)).digest("hex");

const files = (await walk(ROOT))
  .filter((rel) => rel !== "manifest.json" && !rel.endsWith(".DS_Store"))
  .sort();

const entries = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  const st = await fs.stat(abs);
  entries.push({ path: rel, size: st.size, sha256: await sha256(abs) });
}

const pkg = JSON.parse(await fs.readFile(path.resolve(ROOT, "..", "package.json"), "utf8"));
const manifest = {
  version: pkg.version,
  built_at: new Date().toISOString(),
  files: entries,
};
await fs.writeFile(MANIFEST, JSON.stringify(manifest, null, 1) + "\n", "utf8");

const total = entries.reduce((n, e) => n + e.size, 0);
console.log(`manifest.json: ${entries.length} 个文件 / ${(total / 1024).toFixed(1)} KB`);
