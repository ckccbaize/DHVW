// 组件下载：按顺序尝试国内镜像，校验大小与 sha256。运行期与构建期共用同一策略。
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {string[]} urls 按优先级排列的镜像地址
 * @param {string} dest 目标文件
 * @param {{ expectedSha256?: string, minBytes?: number, label?: string }} opts
 */
export async function downloadWithMirrors(urls, dest, opts = {}) {
  const label = opts.label ?? path.basename(dest)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const errors = []

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
