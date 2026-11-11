// 打包脚本：固定走国内镜像，避免 electron / nsis 资源从 GitHub 超时；产出后校验体积预算。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const shellDir = path.resolve(dir, '..')
const releaseDir = path.resolve(shellDir, '../..', 'release')
const MAX_INSTALLER_BYTES = 500 * 1024 * 1024

// 内置运行时缺失时先按镜像补齐，保证安装包自带 Python（ADR-PC-014）
if (!fs.existsSync(path.join(shellDir, 'runtime', 'python.exe'))) {
  const prep = spawnSync(process.execPath, [path.join(dir, 'fetch-runtime.mjs')], { cwd: shellDir, stdio: 'inherit' })
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
  const limit = MAX_INSTALLER_BYTES / 1024 / 1024
  if (mb > limit) {
    console.error(`[fail] 安装包 ${mb.toFixed(1)} MB 超过 ${limit} MB 预算，先裁剪随包资源`)
    process.exit(2)
  }
  console.log(`[ok] 安装包 ${mb.toFixed(1)} MB / 预算 ${limit} MB`)
})

function version() {
  return JSON.parse(fs.readFileSync(path.join(shellDir, 'package.json'), 'utf8')).version
}
