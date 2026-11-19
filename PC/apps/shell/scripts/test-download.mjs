// 验证下载引擎（不经 Electron）：镜像回退、进度回调、sha256 守卫。
// 说明：gh-proxy / ghfast 目前都不返回 Range（对 Range 请求回 200），所以续传能否生效
// 取决于镜像；引擎仍会保留 .aria2 控制文件，遇到支持 Range 的源自动接着下。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { downloadFile, aria2cPath } = require('../dist-electron/main/download.js')

const out = path.resolve('.tmp-dl')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })
console.log('aria2c:', aria2cPath())

const GOOD = 'https://gh-proxy.com/https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/archive/refs/tags/v1.2.1.zip'
const dest = path.join(out, 'olvt.zip')

const seen = []
const started = Date.now()
const res = await downloadFile({
  urls: ['https://example.invalid/nope.zip', GOOD],
  dest,
  minBytes: 5_000_000,
  onProgress: (p) => seen.push(p),
  log: (level, message, extra) => console.log('[log]', level, message, JSON.stringify(extra)),
})
console.log('download', res.engine, res.bytes, `${Math.round((Date.now() - started) / 1000)}s`)
console.log('progress samples:', seen.length, 'range:', seen[0], '-', seen.at(-1))
if (seen.length < 2) console.log('NOTE: 该镜像无 content-length，进度条走不确定态（UI 已支持）')

// sha256 守卫：小文件 + 错哈希，必须抛错并删掉半成品
const SMALL = 'https://gh-proxy.com/https://raw.githubusercontent.com/aria2/aria2/master/COPYING'
const badDest = path.join(out, 'bad.bin')
try {
  await downloadFile({ urls: [SMALL], dest: badDest, minBytes: 15_000, sha256: 'deadbeef', onProgress: () => {} })
  console.error('FAIL: sha256 未生效')
  process.exitCode = 1
} catch (err) {
  console.log('sha256 guard ok:', String(err.message).slice(0, 40), '| 半成品已删除:', !fs.existsSync(badDest))
}
