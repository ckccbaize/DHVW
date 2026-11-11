import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dataDir } from './paths'

/**
 * 可下载组件（ADR-PC-018 修订：OLVT 不随包，首次使用时下载）。
 * 下载地址按顺序尝试，全部失败才报错；落盘前校验大小与 sha256。
 */
export interface ComponentSpec {
  id: string
  name: string
  version: string
  /** 按优先级尝试的 zip 地址，`{version}` 会被替换 */
  urls: string[]
  /** 解压后必须存在的相对路径，用于判定“已就绪” */
  entry: string
  sha256?: string
  minBytes?: number
}

export interface ComponentStatus {
  id: string
  name: string
  version: string
  state: 'missing' | 'installing' | 'ready' | 'failed'
  progress?: number
  path?: string
  error?: string
}

const GITHUB_REPO = 'https://github.com/Open-LLM-VTuber/Open-LLM-VTuber'

/** 国内代理优先，直连兜底；失败逐个回退 */
function githubProxies(url: string): string[] {
  return [
    `https://ghfast.top/${url}`,
    `https://gh-proxy.com/${url}`,
    `https://ghproxy.net/${url}`,
    url,
  ]
}

export const COMPONENTS: ComponentSpec[] = [
  {
    id: 'olvt',
    name: 'OLVT 对话后端',
    version: '1.2.1',
    urls: githubProxies(`${GITHUB_REPO}/archive/refs/tags/v{version}.zip`),
    entry: 'run_server.py',
    minBytes: 5_000_000,
  },
]

export function componentDir(spec: ComponentSpec): string {
  return path.join(dataDir, 'components', spec.id, spec.version)
}

function isReady(spec: ComponentSpec): boolean {
  return fs.existsSync(path.join(componentDir(spec), spec.entry))
}

export function componentStatus(spec: ComponentSpec): ComponentStatus {
  const dir = componentDir(spec)
  return {
    id: spec.id,
    name: spec.name,
    version: spec.version,
    state: isReady(spec) ? 'ready' : 'missing',
    path: dir,
  }
}

/** 用户配置可覆盖下载地址（企业镜像/离线包），{version} 仍会替换 */
export function resolveSpec(spec: ComponentSpec, override?: string[]): ComponentSpec {
  const urls = override?.length ? override : spec.urls
  return { ...spec, urls: urls.map((u) => u.replace('{version}', spec.version)) }
}

async function download(
  urls: string[],
  dest: string,
  spec: ComponentSpec,
  onProgress: (pct: number) => void,
): Promise<void> {
  const errors: string[] = []
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'dhvw-shell/0.1' },
        signal: AbortSignal.timeout(30 * 60 * 1000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      const hash = createHash('sha256')
      let written = 0
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length
          hash.update(chunk)
          if (total > 0) onProgress(Math.min(99, Math.round((written / total) * 100)))
          cb(null, chunk)
        },
      })
      await pipeline(res.body as unknown as NodeJS.ReadableStream, counter, fs.createWriteStream(dest))
      if (spec.minBytes && written < spec.minBytes) throw new Error(`文件过小：${written}`)
      if (spec.sha256 && hash.digest('hex') !== spec.sha256) throw new Error('sha256 不匹配')
      onProgress(100)
      return
    } catch (err) {
      fs.rmSync(dest, { force: true })
      errors.push(`${url} -> ${(err as Error).message}`)
    }
  }
  throw new Error(`所有下载地址失败：\n${errors.join('\n')}`)
}

export async function ensureComponent(
  spec: ComponentSpec,
  onProgress: (pct: number) => void,
): Promise<ComponentStatus> {
  if (isReady(spec)) return componentStatus(spec)
  const dir = componentDir(spec)
  fs.mkdirSync(dir, { recursive: true })
  const archive = path.join(dir, 'package.zip')
  try {
    await download(spec.urls, archive, spec, onProgress)
    // Windows 自带 bsdtar，可直接解 zip
    const tar = spawnSync('tar', ['-xf', archive, '-C', dir], { encoding: 'utf8' })
    if (tar.error) throw tar.error
    if (tar.status !== 0) throw new Error(`解压失败：${tar.stderr?.slice(0, 300)}`)
    fs.rmSync(archive, { force: true })
    flatten(dir, spec)
    if (!isReady(spec)) throw new Error(`解压后缺少 ${spec.entry}`)
    return componentStatus(spec)
  } catch (err) {
    return {
      ...componentStatus(spec),
      state: 'failed',
      error: (err as Error).message,
    }
  }
}

/** GitHub 归档会多一层 `<repo>-<version>/`，直接提到组件目录下 */
function flatten(dir: string, spec: ComponentSpec): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
  if (entries.length !== 1) return
  const inner = path.join(dir, entries[0]!.name)
  if (!fs.existsSync(path.join(inner, spec.entry))) return
  for (const item of fs.readdirSync(inner)) {
    fs.renameSync(path.join(inner, item), path.join(dir, item))
  }
  fs.rmdirSync(inner)
}
