import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 组件下载引擎（ADR-PC-024）。
 *
 * 优先内置 aria2c：多连接分段、断点续传（`.aria2` 控制文件）、失败自动重试，
 * 并且可以把多个镜像当作同一文件的多 URI 源一起用——这三点对国内弱网是决定性的。
 * 找不到二进制时退回单连接 fetch（PowerShell/精简安装仍可用），行为保守但不会崩。
 */

export interface DownloadOptions {
  /** 按优先级排列的镜像，aria2 会当作同一文件的备用 URI */
  urls: string[]
  dest: string
  onProgress?: (pct: number) => void
  minBytes?: number
  sha256?: string
  timeoutMs?: number
  /** 进度/结果日志，调用方注入（本模块不依赖 electron 与日志系统，便于独立测试） */
  log?: (level: 'info' | 'warn', message: string, extra?: Record<string, unknown>) => void
}

export interface DownloadResult {
  engine: 'aria2' | 'fetch'
  bytes: number
  url: string
}

export function aria2cPath(): string | null {
  // 不引入 electron：这个模块要能在纯 node 下被验证（见 scripts/test-download.mjs）
  const candidates = [
    process.env.DHVW_ARIA2 ?? '',
    process.resourcesPath ? path.join(process.resourcesPath, 'tools', 'aria2c.exe') : '',
    path.resolve(__dirname, '../../build/tools/aria2c.exe'),
    path.join(process.cwd(), 'build', 'tools', 'aria2c.exe'),
  ]
  return candidates.find((p) => p && fs.existsSync(p)) ?? null
}

/** aria2 的摘要行只给「已下载/总量」，百分比自己算；总量先用 HEAD 探一次 */
async function probeSize(urls: string[]): Promise<number> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'User-Agent': 'dhvw-shell/0.1' },
        signal: AbortSignal.timeout(5000),
      })
      const len = Number(res.headers.get('content-length') ?? 0)
      if (res.ok && len > 0) return len
    } catch {
      /* HEAD 失败就用未知总量，只是没有百分比 */
    }
  }
  return 0
}

const UNITS: Record<string, number> = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }

/** 解析 `[#1c69ab 20MiB/40MiB CN:8 DL:255KiB]` 里的已下载字节数 */
function parseBytes(text: string): { downloaded: number; total: number } {
  let downloaded = 0
  let total = 0
  for (const match of text.matchAll(/\[#\w+\s+([\d.]+)([BKMGT])i?B\/([\d.]+)([BKMGT])i?B/g)) {
    downloaded = Math.max(downloaded, Math.round(Number(match[1]) * (UNITS[match[2]!] ?? 1)))
    total = Math.max(total, Math.round(Number(match[3]) * (UNITS[match[4]!] ?? 1)))
  }
  return { downloaded, total }
}

function hashFile(file: string): string {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

/** 校验失败（体积/sha256）是确定性的，不能当成网络故障去换引擎重试 */
class VerifyError extends Error {
  readonly verify = true
}

/** 校验失败会删掉半成品，避免“下一个组件复用了坏文件” */
function verify(file: string, opts: DownloadOptions): number {
  const size = fs.statSync(file).size
  if (opts.minBytes && size < opts.minBytes) {
    fs.rmSync(file, { force: true })
    throw new VerifyError(`文件过小：${size} < ${opts.minBytes}`)
  }
  if (opts.sha256) {
    const actual = hashFile(file)
    if (actual !== opts.sha256) {
      fs.rmSync(file, { force: true })
      throw new VerifyError(`sha256 不匹配：期望 ${opts.sha256}，实际 ${actual}`)
    }
  }
  return size
}

async function aria2(urls: string[], dest: string, opts: DownloadOptions): Promise<DownloadResult> {
  const bin = aria2cPath()
  if (!bin) throw new Error('aria2c 不可用')
  // 镜像常常是 chunked（无 content-length），HEAD 探不到总量就退而用 aria2 自己报的总量
  let total = opts.minBytes ? await probeSize(urls) : 0
  opts.log?.('info', 'aria2 开始下载', { total, urls: urls.length })
  const dir = path.dirname(dest)
  fs.mkdirSync(dir, { recursive: true })
  const args = [
    '--continue=true',
    '--max-connection-per-server=8',
    '--split=8',
    '--min-split-size=1M',
    '--max-tries=6',
    '--retry-wait=2',
    '--connect-timeout=20',
    '--timeout=60',
    '--file-allocation=none',
    '--auto-file-renaming=false',
    '--allow-overwrite=true',
    '--summary-interval=1',
    // 控制文件每 5 s 落一次：进程被杀（重启/崩溃）后能接着下，而不是从 0 开始
    '--auto-save-interval=5',
    '--console-log-level=notice',
    '--dir',
    dir,
    '--out',
    path.basename(dest),
    ...urls,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true })
    let lastPct = 0
    let tail = ''
    const onData = (buf: Buffer): void => {
      const text = buf.toString()
      tail = (tail + text).slice(-4000)
      const parsed = parseBytes(tail)
      if (!total && parsed.total > 0) total = parsed.total
      if (!total || !parsed.downloaded) return
      const downloaded = parsed.downloaded
      const pct = Math.min(99, Math.floor((downloaded / total) * 100))
      if (pct > lastPct) {
        lastPct = pct
        opts.onProgress?.(pct)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`aria2c 退出码 ${code}：${tail.trim().split('\n').slice(-3).join(' | ')}`))
        return
      }
      try {
        const bytes = verify(dest, opts)
        opts.onProgress?.(100)
        resolve({ engine: 'aria2', bytes, url: urls[0] ?? '' })
      } catch (err) {
        reject(err)
      }
    })
  })
}

async function viaFetch(urls: string[], dest: string, opts: DownloadOptions): Promise<DownloadResult> {
  const errors: string[] = []
  for (const url of urls) {
    try {
      // 有半成品就带 Range 续传；服务端不支持（200）则从头覆盖
      const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0
      const res = await fetch(url, {
        redirect: 'follow',
        headers: {
          'User-Agent': 'dhvw-shell/0.1',
          ...(have > 0 ? { Range: `bytes=${have}-` } : {}),
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30 * 60 * 1000),
      })
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      const resuming = res.status === 206 && have > 0
      const total = Number(res.headers.get('content-length') ?? 0) + (resuming ? have : 0)
      let written = resuming ? have : 0
      if (!resuming && have > 0) fs.rmSync(dest, { force: true })
      // 不用 stream.pipeline：undici 的 body 在 Node 24 上遇背压会触发 Parser 断言，
      // 直接按块写文件句柄，天然背压且不依赖 Web Stream 桥接。
      const fh = await fs.promises.open(dest, resuming ? 'a' : 'w')
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          const buf = Buffer.from(chunk)
          written += buf.length
          await fh.write(buf)
          if (total > 0) opts.onProgress?.(Math.min(99, Math.round((written / total) * 100)))
        }
      } finally {
        await fh.close()
      }
      const bytes = verify(dest, opts)
      opts.onProgress?.(100)
      return { engine: 'fetch', bytes, url }
    } catch (err) {
      fs.rmSync(dest, { force: true })
      errors.push(`${url} -> ${(err as Error).message}`)
    }
  }
  throw new Error(`所有下载地址失败：\n${errors.join('\n')}`)
}

export async function downloadFile(opts: DownloadOptions): Promise<DownloadResult> {
  const started = Date.now()
  if (aria2cPath()) {
    try {
      const result = await aria2(opts.urls, opts.dest, opts)
      opts.log?.('info', '下载完成', {
        engine: result.engine,
        bytes: result.bytes,
        ms: Date.now() - started,
        file: path.basename(opts.dest),
      })
      return result
    } catch (err) {
      if (err instanceof VerifyError) throw err
      opts.log?.('warn', 'aria2 下载失败，回退单连接', { error: (err as Error).message })
    }
  }
  const result = await viaFetch(opts.urls, opts.dest, opts)
  opts.log?.('info', '下载完成', {
    engine: result.engine,
    bytes: result.bytes,
    ms: Date.now() - started,
    file: path.basename(opts.dest),
  })
  return result
}
