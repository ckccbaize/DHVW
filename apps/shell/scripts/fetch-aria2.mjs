// 取内置下载器 aria2c（Windows x64 静态构建），供组件下载做多线程/断点续传。
// 与 uv 一样落在 build/tools，打包时随安装包进入 resources/tools。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadWithMirrors } from './lib/mirror.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const shellDir = path.resolve(dir, '..')
const toolsDir = path.join(shellDir, 'build', 'tools')
const target = path.join(toolsDir, 'aria2c.exe')

const VERSION = '1.37.0'
const ASSET = `aria2-${VERSION}-win-64bit-build1.zip`
const RELEASE = `https://github.com/aria2/aria2/releases/download/release-${VERSION}/${ASSET}`

const LICENSE = path.join(toolsDir, 'aria2-COPYING.txt')

// GPLv2：随包分发二进制必须附带许可证原文
async function ensureLicense() {
  if (fs.existsSync(LICENSE)) return
  const raw = 'https://raw.githubusercontent.com/aria2/aria2/master/COPYING'
  try {
    await downloadWithMirrors(
      [`https://gh-proxy.com/${raw}`, `https://ghproxy.net/${raw}`, raw],
      LICENSE,
      { minBytes: 15_000, label: 'aria2 COPYING' },
    )
  } catch (err) {
    console.warn('[warn] 取不到 aria2 COPYING，请手工补 tools/aria2-COPYING.txt：', err.message.slice(0, 120))
  }
}

// 已存在且可运行就跳过下载（但仍要补许可证）
const installed = (() => {
  if (!fs.existsSync(target)) return false
  const probe = spawnSync(target, ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) return false
  console.log(`[skip] aria2c 已存在：${target}（${probe.stdout.split('\n')[0]}）`)
  return true
})()

if (!installed) {
  fs.mkdirSync(toolsDir, { recursive: true })
  const zip = path.join(toolsDir, ASSET)
  await downloadWithMirrors(
    [`https://gh-proxy.com/${RELEASE}`, `https://ghproxy.net/${RELEASE}`, `https://ghfast.top/${RELEASE}`, RELEASE],
    zip,
    { minBytes: 1_500_000, label: ASSET },
  )

  const out = path.join(toolsDir, 'aria2-extract')
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const tar = spawnSync('tar', ['-xf', zip, '-C', out], { encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`解压失败：${tar.stderr?.slice(0, 400)}`)
  const found = fs.readdirSync(out, { recursive: true }).find((p) => String(p).endsWith('aria2c.exe'))
  if (!found) throw new Error('压缩包里没有 aria2c.exe')
  fs.copyFileSync(path.join(out, String(found)), target)
  fs.rmSync(zip, { force: true })
  fs.rmSync(out, { recursive: true, force: true })

  const probe = spawnSync(target, ['--version'], { encoding: 'utf8' })
  if (probe.status !== 0) throw new Error(`aria2c 无法运行：${probe.stderr?.slice(0, 300)}`)
  const mb = fs.statSync(target).size / 1024 / 1024
  console.log(`[ok] ${target}（${mb.toFixed(1)} MB，${probe.stdout.split('\n')[0]}）`)
}

await ensureLicense()
