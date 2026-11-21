#!/usr/bin/env node
// 发布打包：一条命令产出可交付的 a 测产物。
//
//   node tools/release.mjs pc      PC 测试包（www + 4 个桌面壳 + 启动器）→ dist/arm-pc-test.{zip,tar.gz}
//   node tools/release.mjs arm     ARM 真机部署包 → dist/arm-deploy.tar.gz
//   node tools/release.mjs all     两个都打（默认）
//
// 只做确定性的复制/编译/压缩：不写 data/、不带运行期残留、不改仓库文件。
// 壳的交叉编译需要本机 Go（go toolchain），否则跳过对应平台的核并给出警告。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toCrlfText, toLfText, assertAsciiBat, renderTemplate, zipBuffer } from "./packaging.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const WWW = path.join(ROOT, "www");
const PC_DIR = path.join(DIST, "arm-pc-test");
const TPL = path.join(ROOT, "packaging");

// PC 包里的壳：文件名固定，启动器按名字找。
const PC_SHELLS = [
  { out: "dhvw-shell-windows-amd64.exe", goos: "windows", goarch: "amd64" },
  { out: "dhvw-shell-linux-amd64", goos: "linux", goarch: "amd64" },
  { out: "dhvw-shell-darwin-amd64", goos: "darwin", goarch: "amd64" },
  { out: "dhvw-shell-darwin-arm64", goos: "darwin", goarch: "arm64" },
];

const ARM_SHELLS = [
  { out: "dhvw-shell-linux-arm64", goos: "linux", goarch: "arm64" },
  { out: "dhvw-shell-linux-armv7", goos: "linux", goarch: "arm", goarm: "7" },
];

const log = (msg) => console.log(msg);
const step = (n, total, msg) => console.log(`\n[${n}/${total}] ${msg}`);

// PATH 上的 node/go/tar 在 Windows 上能直接 spawn（CreateProcess 会搜 PATH）。
// 走 shell 会把 `-ldflags=-s -w` 这种带空格的参数在空格处拆开，go 报 "flag provided but not defined: -w"。
function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
  if (res.error) return { ok: false, error: res.error.message };
  if (res.status !== 0) return { ok: false, error: `${cmd} 退出码 ${res.status}` };
  return { ok: true };
}

function hasGo() {
  const res = spawnSync("go", ["version"], { stdio: "ignore" });
  return res.status === 0;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function walk(dir, base = "") {
  const out = [];
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(abs, rel)));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

// ---------- 前置校验 ----------

function runPackAndVerify() {
  log("  · 场景包清单 + 资源包 manifest");
  let res = run("node", ["tools/pack-scenes.mjs"]);
  if (!res.ok) throw new Error(`场景包清单失败：${res.error}`);
  res = run("node", ["tools/pack.mjs"]);
  if (!res.ok) throw new Error(`资源包 manifest 失败：${res.error}`);
  res = run("node", ["tools/verify.mjs"]);
  if (!res.ok) throw new Error(`资源包校验失败：${res.error}`);
}

function validateScenes() {
  const scenes = fs
    .readdirSync(path.join(WWW, "assets", "scenes"), { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => ent.name)
    .sort();
  log(`  · 校验 ${scenes.length} 个场景包：${scenes.join(", ")}`);
  const failed = [];
  for (const id of scenes) {
    const res = spawnSync("node", ["tools/validate-scene.mjs", path.join("www", "assets", "scenes", id)], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (res.status !== 0) failed.push(id);
  }
  if (failed.length) throw new Error(`场景包校验未通过：${failed.join(", ")}`);
  return scenes;
}

// ---------- 编译 ----------

function buildShells(list, label) {
  if (!hasGo()) {
    log(`  ! 未找到 Go，跳过 ${label} 交叉编译（沿用 dist/ 下已有二进制）`);
    return false;
  }
  const shellDir = path.join(ROOT, "shell");
  for (const spec of list) {
    log(`  · ${spec.goos}/${spec.goarch} → ${spec.out}`);
    const env = { ...process.env, GOOS: spec.goos, GOARCH: spec.goarch, CGO_ENABLED: "0" };
    if (spec.goarm) env.GOARM = spec.goarm;
    else delete env.GOARM;
    const res = spawnSync(
      "go",
      ["build", "-trimpath", "-ldflags", "-s -w", "-o", path.join(DIST, spec.out), "."],
      { cwd: shellDir, env, stdio: "inherit" },
    );
    if (res.status !== 0) throw new Error(`编译失败：${spec.goos}/${spec.goarch}`);
  }
  return true;
}

function requireFile(p, why) {
  if (!fs.existsSync(p)) throw new Error(`缺少 ${path.relative(ROOT, p)}（${why}）`);
}

// ---------- PC 包 ----------

async function buildPc() {
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf8"));
  const manifest = JSON.parse(await fsp.readFile(path.join(WWW, "manifest.json"), "utf8"));
  const built = buildShells(PC_SHELLS, "PC 桌面壳");

  await fsp.rm(PC_DIR, { recursive: true, force: true });
  await fsp.mkdir(PC_DIR, { recursive: true });

  // 资源包：整目录复制，但绝不带 manifest 之外的临时文件。
  log("  · 复制 www/");
  await fsp.cp(WWW, path.join(PC_DIR, "www"), { recursive: true });

  log("  · 复制 qq-openclaw/");
  await fsp.cp(path.join(ROOT, "qq-openclaw"), path.join(PC_DIR, "qq-openclaw"), { recursive: true });

  log("  · 复制壳");
  const missingShells = [];
  for (const spec of PC_SHELLS) {
    const src = path.join(DIST, spec.out);
    if (!fs.existsSync(src)) {
      missingShells.push(spec.out);
      continue;
    }
    await fsp.copyFile(src, path.join(PC_DIR, spec.out));
  }
  if (missingShells.length) {
    throw new Error(`缺少壳二进制：${missingShells.join(", ")}（本机无 Go 时需先手工放入 dist/）`);
  }
  if (!built) log("  ! 壳可能不是当前源码编译的结果");

  // 随包 node：Windows 测试包双击即用，不要求目标机预装 Node。
  // 来源优先级：dist/node-cache/node.exe（稳定、可离线复用）→ 构建机自身的 node 可执行文件。
  // 壳的 findNode() 会优先用 <包>/node/node.exe，其次才回退 PATH。
  log("  · 复制 node/");
  const nodeCandidates = [path.join(DIST, "node-cache", "node.exe"), process.execPath]
    .filter((p) => p && p.toLowerCase().endsWith(".exe") && fs.existsSync(p));
  if (nodeCandidates.length) {
    const src = nodeCandidates[0];
    await fsp.mkdir(path.join(PC_DIR, "node"), { recursive: true });
    await fsp.copyFile(src, path.join(PC_DIR, "node", "node.exe"));
    log(`  · 随包 node/node.exe（${(fs.statSync(src).size / 1048576).toFixed(0)} MB，来自 ${path.relative(ROOT, src) || src}）`);
  } else {
    log("  ! 未找到 node.exe：包内不含 Node，QQ/飞书网关要求目标机自装 Node 22.14+");
  }

  // 启动器：bat 强制 ASCII + CRLF，sh 强制 LF。
  log("  · 写启动器");
  const bat = assertAsciiBat(toCrlfText(await fsp.readFile(path.join(TPL, "pc", "start-windows.bat"), "utf8")), "start-windows.bat");
  await fsp.writeFile(path.join(PC_DIR, "start-windows.bat"), bat, "utf8");
  const sh = toLfText(await fsp.readFile(path.join(TPL, "pc", "start-unix.sh"), "utf8"));
  const shPath = path.join(PC_DIR, "start-unix.sh");
  await fsp.writeFile(shPath, sh, "utf8");
  await fsp.chmod(shPath, 0o755);

  // 说明：场景清单从实际目录扫，避免文档与包体脱节。
  const scenes = fs
    .readdirSync(path.join(WWW, "assets", "scenes"), { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => ent.name)
    .sort();
  const tourDefault = (await fsp.readFile(path.join(WWW, "js", "tour.js"), "utf8"))
    .match(/const DEFAULT_SCENES\s*=\s*\[([^\]]*)\]/);
  const tourScenes = tourDefault
    ? tourDefault[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean)
    : [];
  const sceneTree = scenes
    .map((id) => `  assets/scenes/${id}`.padEnd(38) + (id === "home" ? "家（默认场景）" : id === "office" ? "办公室（总观「外」视图）" : id === "indoor-66500" ? "cafe 的同图副本" : ""))
    .join("\n");
  const readme = toLfText(
    renderTemplate(await fsp.readFile(path.join(TPL, "pc", "README.txt"), "utf8"), {
      VERSION: pkg.version,
      BUILD_AT: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
      PACK_FILES: manifest.files.length,
      SCENES: scenes.join(" | "),
      SCENE_TREE: sceneTree,
      TOUR_SCENES: (tourScenes.length ? tourScenes : scenes).join(" → "),
    }),
  );
  await fsp.writeFile(path.join(PC_DIR, "README.txt"), readme, "utf8");

  // 压缩：zip 保留 Unix 权限位，tar.gz 保留目录结构。
  log("  · 打包 dist/arm-pc-test.zip + .tar.gz");
  const files = (await walk(PC_DIR)).sort();
  const entries = [
    { name: "arm-pc-test/", mode: 0o40755, data: Buffer.alloc(0) },
    ...(await Promise.all(
      files.map(async (rel) => {
        const abs = path.join(PC_DIR, rel);
        const mode = /^dhvw-shell-/.test(rel) || rel.endsWith(".sh") ? 0o100755 : 0o100644;
        return { name: `arm-pc-test/${rel}`, mode, data: await fsp.readFile(abs) };
      }),
    )),
  ];
  const zip = zipBuffer(entries, { mtime: new Date() });
  await fsp.writeFile(path.join(DIST, "arm-pc-test.zip"), zip);

  const tar = run("tar", ["-czf", path.join(DIST, "arm-pc-test.tar.gz"), "-C", DIST, "arm-pc-test"]);
  if (!tar.ok) throw new Error(`tar 打包失败：${tar.error}`);

  const zipTmp = path.join(DIST, "arm-pc-test.tar.gz");
  log(
    `  ✓ zip ${(zip.length / 1048576).toFixed(1)} MB · tar.gz ${(fs.statSync(zipTmp).size / 1048576).toFixed(1)} MB · ${files.length} 个文件`,
  );
  return { files: files.length, zipBytes: zip.length };
}

// ---------- ARM 包 ----------

async function buildArm() {
  buildShells(ARM_SHELLS, "ARM 壳");
  requireFile(path.join(DIST, "dhvw-shell-linux-arm64"), "ARM 部署包需要");
  requireFile(path.join(ROOT, "deploy", "install.sh"), "ARM 部署包需要");

  log("  · 打包 dist/arm-deploy.tar.gz（www + deploy + qq-openclaw + arm64 壳）");
  const tarPath = path.join(DIST, "arm-deploy.tar.gz");
  const res = run("tar", [
    "-czf", tarPath,
    "-C", ROOT,
    "www", "deploy", "qq-openclaw",
    "dist/dhvw-shell-linux-arm64",
  ]);
  if (!res.ok) throw new Error(`tar 打包失败：${res.error}`);
  const size = fs.statSync(tarPath).size;
  log(`  ✓ ${(size / 1048576).toFixed(1)} MB`);
  return { bytes: size };
}

// ---------- 入口 ----------

const target = (process.argv[2] || "all").toLowerCase();
if (!["pc", "arm", "all"].includes(target)) {
  console.error("用法: node tools/release.mjs [pc|arm|all]");
  process.exit(2);
}

await fsp.mkdir(DIST, { recursive: true });

// 步骤计数：pack + validate + (pc) + (arm) + 汇总
const doPc = target === "pc" || target === "all";
const doArm = target === "arm" || target === "all";
const total = 2 + (doPc ? 2 : 0) + (doArm ? 2 : 0);
let n = 0;

step(++n, total, "生成场景包清单 + 资源包 manifest");
runPackAndVerify();

step(++n, total, "校验场景包");
const scenes = validateScenes();

if (doPc) {
  step(++n, total, "构建 PC 测试包");
  const pc = await buildPc();
  log(`  ✓ ${pc.files} 个文件，场景 ${scenes.length} 个`);
  step(++n, total, "PC 测试包完成");
}

if (doArm) {
  step(++n, total, "构建 ARM 部署包");
  await buildArm();
  step(++n, total, "ARM 部署包完成");
}

console.log("\n产物：");
for (const name of ["arm-pc-test.zip", "arm-pc-test.tar.gz", "arm-deploy.tar.gz"]) {
  const p = path.join(DIST, name);
  if (fs.existsSync(p)) console.log(`  dist/${name}  ${(fs.statSync(p).size / 1048576).toFixed(1)} MB`);
}
