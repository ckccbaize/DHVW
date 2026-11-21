// 打包脚本：固定走国内镜像，避免 electron / nsis 资源从 GitHub 超时；产出后校验体积预算。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const shellDir = path.resolve(dir, '..')
const releaseDir = path.resolve(shellDir, '../..', 'release')
// 预算改为软阈值：超过只告警，超过 125% 才失败（用户要求暂不卡体积）
const MAX_INSTALLER_MB = 500

// 内置运行时与 uv 缺失时先补齐，保证安装包自带 Python 与依赖安装能力（ADR-PC-014）
for (const [name, ready] of [
  ['fetch-runtime.mjs', path.join(shellDir, 'runtime', 'python.exe')],
  ['fetch-uv.mjs', path.join(shellDir, 'build', 'tools', 'uv.exe')],
  ['fetch-aria2.mjs', path.join(shellDir, 'build', 'tools', 'aria2c.exe')],
  ['fetch-embed-model.mjs', path.join(shellDir, 'resources', 'models', 'bge-small-zh-v1.5', 'model.onnx')],
]) {
  if (fs.existsSync(ready)) continue
  const prep = spawnSync(process.execPath, [path.join(dir, name)], { cwd: shellDir, stdio: 'inherit' })
  if (prep.status !== 0) process.exit(prep.status ?? 1)
}

// electron-builder 对缺失的 extraResources 源只打一行 warn 就继续，出包会缺内容却不失败。
// 这里把「装了等同没装」的资源逐个前置校验：宁可打包失败，也不要发出一个残包。
const required = [
  ['默认人设', 'resources/defaults/persona/deepseek.json'],
  ['默认 L0 记忆', 'resources/defaults/memory/l0.json'],
  ['默认像素角色', 'resources/defaults/characters/deepseek-54e633/sheet.png'],
  ['默认精灵原图', 'resources/defaults/assets-char/ojj_sheet.png'],
  ['参考场景 spec', 'resources/defaults/scenes/home/home.map.json'],
  ['默认形象（大肥鱼）', 'resources/live2d/models/DeepSeek/大肥鱼.model3.json'],
  ['默认形象纹理', 'resources/live2d/models/DeepSeek/大肥鱼.4096/texture_00.png'],
  ['编排器依赖清单', 'resources/orchestrator-requirements.txt'],
  ['记忆向量依赖清单', 'resources/memory-requirements.txt'],
  ['地图动作表', 'resources/defaults/scenes/_shared/acts.json'],
  ['地图工具链文档', '../../../docs/MAP-SCENE-DESIGN.md'],
  ['地图工具链脚本', '../../../scripts/paint_home.py'],
  ['地图工具链校验器', '../../../scripts/validate_scene.py'],
  ['ARM 预览资源', '../../../arm/www/index.html'],
  ['内置运行时', 'runtime/python.exe'],
  ['依赖安装器', 'build/tools/uv.exe'],
  ['句向量模型', 'resources/models/bge-small-zh-v1.5/model.onnx'],
]
const missing = required.filter(([, rel]) => !fs.existsSync(path.join(shellDir, rel)))
if (missing.length) {
  console.error('[fail] 打包所需资源缺失，安装包会缺内容：')
  for (const [label, rel] of missing) console.error(`  - ${label}: ${rel}`)
  process.exit(3)
}

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

const cli = path.join(shellDir, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const child = spawn(process.execPath, [cli, '--win', 'nsis', '--publish', 'never', ...process.argv.slice(2)], {
  cwd: shellDir,
  env,
  stdio: 'inherit',
})
child.on('exit', (code) => {
  if (code !== 0) process.exit(code ?? 1)
  const installer = path.join(releaseDir, `DigitalHuman-${version()}-setup.exe`)
  if (!fs.existsSync(installer)) process.exit(0)
  const mb = fs.statSync(installer).size / 1024 / 1024
  const limit = Number(process.env.DHVW_MAX_INSTALLER_MB ?? MAX_INSTALLER_MB)
  if (mb > limit * 1.25) {
    console.error(`[fail] 安装包 ${mb.toFixed(1)} MB 超过硬上限 ${(limit * 1.25).toFixed(0)} MB`)
    process.exit(2)
  }
  if (mb > limit) console.warn(`[warn] 安装包 ${mb.toFixed(1)} MB 超过 ${limit} MB 预算，暂不阻断（DHVW_MAX_INSTALLER_MB 可调）`)
  else console.log(`[ok] 安装包 ${mb.toFixed(1)} MB / 预算 ${limit} MB`)
})

function version() {
  return JSON.parse(fs.readFileSync(path.join(shellDir, 'package.json'), 'utf8')).version
}
