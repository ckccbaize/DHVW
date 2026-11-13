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
]) {
  if (fs.existsSync(ready)) continue
  const prep = spawnSync(process.execPath, [path.join(dir, name)], { cwd: shellDir, stdio: 'inherit' })
  if (prep.status !== 0) process.exit(prep.status ?? 1)
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
