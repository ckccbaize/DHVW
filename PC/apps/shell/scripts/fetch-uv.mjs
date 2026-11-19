// 准备随包的 uv（用于把 sidecar 依赖装进 runtime/site-packages）。
// 优先用本机已有的 uv；否则从 GitHub Release 走国内代理下载。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadWithMirrors } from './lib/mirror.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const shellDir = path.resolve(dir, '..')
const toolsDir = path.join(shellDir, 'build', 'tools')
const target = path.join(toolsDir, 'uv.exe')
const cacheDir = path.join(shellDir, 'node_modules', '.cache', 'dhvw')
const archive = path.join(cacheDir, 'uv.zip')

const UV_VERSION = '0.12.17'
const RELEASE = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`
const MIRRORS = [
  `https://ghfast.top/${RELEASE}`,
  `https://gh-proxy.com/${RELEASE}`,
  `https://ghproxy.net/${RELEASE}`,
  RELEASE,
]

function usable(exe) {
  try {
    execFileSync(exe, ['--version'], { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

fs.mkdirSync(toolsDir, { recursive: true })

if (usable(target) && !process.argv.includes('--force')) {
  console.log(`[skip] uv 已存在：${target}`)
  process.exit(0)
}

const local = process.env.UV_EXE ?? path.join(os.homedir(), '.local', 'bin', 'uv.exe')
if (fs.existsSync(local) && usable(local)) {
  fs.copyFileSync(local, target)
  console.log(`[ok] 复用本机 uv：${local} -> ${target}`)
  process.exit(0)
}

fs.mkdirSync(cacheDir, { recursive: true })
await downloadWithMirrors(MIRRORS, archive, { label: `uv ${UV_VERSION}`, minBytes: 10_000_000 })
execFileSync('tar', ['-xf', archive, '-C', toolsDir], { stdio: 'inherit' })
fs.rmSync(archive, { force: true })

if (!usable(target)) {
  console.error(`uv 不可用：${target}`)
  process.exit(1)
}
console.log(`[ok] uv 就绪：${target}`)
