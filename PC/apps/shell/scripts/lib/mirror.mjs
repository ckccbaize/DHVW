// 组件下载：按顺序尝试国内镜像，校验大小与 sha256。运行期与构建期共用同一策略。
// 构建期也能用 aria2c（build/tools 里已有就用）：多连接 + 断流自动重试，弱网下比单连接稳。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const shellDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ARIA2 = [process.env.DHVW_ARIA2, path.join(shellDir, 'build', 'tools', 'aria2c.exe')].find(
  (p) => p && fs.existsSync(p),
)

function viaAria2(urls, dest) {
  if (!ARIA2) return null
  const started = Date.now()
  const res = spawnSync(
    ARIA2,
    [
      '--continue=true',
      '--max-connection-per-server=8',
      '--split=8',
      '--min-split-size=1M',
      '--max-tries=6',
      '--retry-wait=2',
      '--connect-timeout=20',
      '--timeout=60',
      '--auto-save-interval=5',
      '--file-allocation=none',
      '--auto-file-renaming=false',
      '--allow-overwrite=true',
      '--summary-interval=0',
      '--console-log-level=warn',
      '--dir',
      path.dirname(dest),
      '--out',
      path.basename(dest),
      ...urls,
    ],
    { encoding: 'utf8' },
  )
  if (res.status !== 0) return null
  return { ms: Date.now() - started, note: 'aria2' }
}

/**
 * @param {string[]} urls 按优先级排列的镜像地址
 * @param {string} dest 目标文件
 * @param {{ expectedSha256?: string, minBytes?: number, label?: string }} opts
 */
export async function downloadWithMirrors(urls, dest, opts = {}) {
  const label = opts.label ?? path.basename(dest)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const errors = []

  // 先让 aria2 把整组镜像试一遍（它自己会按 URI 顺序回退），失败再逐镜像走 fetch
  try {
    const done = viaAria2(urls, dest)
    if (done && fs.existsSync(dest)) {
      const bytes = fs.statSync(dest).size
      if (opts.minBytes && bytes < opts.minBytes) throw new Error(`文件过小：${bytes} < ${opts.minBytes}`)
      if (opts.expectedSha256) {
        const actual = createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
        if (actual !== opts.expectedSha256) throw new Error(`sha256 不匹配：${actual}`)
      }
      console.log(`[ok] ${label} <- aria2 (${(bytes / 1024 / 1024).toFixed(1)} MB, ${done.ms} ms)`)
      return { url: urls[0], bytes }
    }
  } catch (err) {
    fs.rmSync(dest, { force: true })
    console.warn(`[skip] aria2: ${err?.message ?? err}`)
  }

  for (const url of urls) {
    const tmp = `${dest}.part`
    try {
      const started = Date.now()
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'dhvw-setup/1.0' },
        signal: AbortSignal.timeout(600_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      // 国内镜像带宽不稳定时常见几十 KB/s，这里按流写盘，避免长时间占内存
      const chunks = []
      for await (const chunk of res.body) chunks.push(Buffer.from(chunk))
      const buf = Buffer.concat(chunks)
      if (opts.minBytes && buf.length < opts.minBytes) {
        throw new Error(`文件过小：${buf.length} < ${opts.minBytes}`)
      }
      if (opts.expectedSha256) {
        const actual = createHash('sha256').update(buf).digest('hex')
        if (actual !== opts.expectedSha256) throw new Error(`sha256 不匹配：${actual}`)
      }
      fs.writeFileSync(tmp, buf)
      fs.renameSync(tmp, dest)
      console.log(`[ok] ${label} <- ${url} (${(buf.length / 1024 / 1024).toFixed(1)} MB, ${Date.now() - started} ms)`)
      return { url, bytes: buf.length }
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      errors.push(`${url} -> ${err?.message ?? err}`)
      console.warn(`[skip] ${label} <- ${url}: ${err?.message ?? err}`)
    }
  }
  throw new Error(`所有镜像均失败（${label}）:\n  ${errors.join('\n  ')}`)
}
