// 校验资源包：manifest 里每个文件存在且大小/哈希一致；www 下没有未登记文件。
// 用法：node tools/verify.mjs   退出码 1 = 不合格
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "www");

async function walk(dir, base = "") {
  const out = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await walk(path.join(dir, ent.name), rel)));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

const sha256 = async (p) =>
  crypto.createHash("sha256").update(await fs.readFile(p)).digest("hex");

let manifest;
try {
  manifest = JSON.parse(await fs.readFile(path.join(ROOT, "manifest.json"), "utf8"));
} catch {
  console.error("✗ 缺少 www/manifest.json（先跑 npm run pack）");
  process.exit(1);
}

const problems = [];
const listed = new Set();
for (const f of manifest.files) {
  listed.add(f.path);
  const abs = path.join(ROOT, f.path);
  try {
    const st = await fs.stat(abs);
    if (st.size !== f.size) problems.push(`尺寸不符 ${f.path}: ${st.size} ≠ ${f.size}`);
    else if ((await sha256(abs)) !== f.sha256) problems.push(`哈希不符 ${f.path}`);
  } catch {
    problems.push(`缺失 ${f.path}`);
  }
}

for (const rel of await walk(ROOT)) {
  if (rel === "manifest.json") continue;
  if (!listed.has(rel)) problems.push(`未登记 ${rel}（重新 npm run pack）`);
}

if (problems.length) {
  console.error(`✗ 资源包不合格（${problems.length} 项）`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`✓ 资源包完整：${manifest.files.length} 个文件，版本 ${manifest.version}`);
