import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { bundledResourceDir, componentsRoot, dataDir, legacyComponentsRoot, resourcesRoot, runtimeDir } from './paths'
import { depsDir } from './deps'
import { downloadFile } from './download'
import { log } from './logger'
import {
  NEMOTRON_FILE,
  NEMOTRON_MIN_BYTES,
  NEMOTRON_MMPROJ_FILE,
  NEMOTRON_MMPROJ_MIN_BYTES,
  NEMOTRON_MMPROJ_URLS,
  NEMOTRON_SHA256,
  NEMOTRON_TUNING_SUMMARY,
  NEMOTRON_URLS,
  preferredLlamaDir,
  preferredModelsDir,
  resolveLlamaServer,
  resolveNemotronMmproj,
  resolveNemotronModel,
} from './local-llm'

/**
 * 系统自带 bsdtar（Win10 1803+）：不能走 PATH —— Git for Windows 的 GNU tar 在 PATH 里
 * 常排在前面，它会把 `D:/x` 当成远程主机 `D:`，报 "Cannot connect to D: resolve failed"。
 */
function systemTar(): string {
  const candidates = [
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : '',
    'C:\\Windows\\System32\\tar.exe',
  ]
  return candidates.find((p) => p && fs.existsSync(p)) ?? 'tar'
}

/**
 * 可下载组件（ADR-PC-018 修订：OLVT 不随包，首次使用时下载）。
 * 下载地址按顺序尝试，全部失败才报错；落盘前校验大小与 sha256。
 */
export interface ComponentSpec {
  id: string
  name: string
  version: string
  /** archive = zip/tar.bz2 需解压；file = 单文件（如 .gguf）直接落盘到目标目录 */
  kind?: 'archive' | 'file'
  /** 按优先级尝试的下载地址，`{version}` 会被替换 */
  urls: string[]
  /** 落盘/解压后必须存在的相对路径，用于判定“已就绪” */
  entry: string
  sha256?: string
  minBytes?: number
  /** 自定义组件安装目录（如根目录 local_ai\models） */
  targetDir?: () => string
  /** 组件内的依赖清单（相对路径），安装到 runtime/site-packages */
  requirements?: string
  /** 随包的依赖清单（相对 resources/），存在时优先于组件自带的那份 */
  requirementsBundled?: string
}

export interface ComponentStatus {
  id: string
  name: string
  version: string
  state: 'missing' | 'installing' | 'ready' | 'failed'
  progress?: number
  path?: string
  error?: string
  detail?: string
  canOpenFolder?: boolean
  canActivateLocalLlm?: boolean
}

const GITHUB_REPO = 'https://github.com/Open-LLM-VTuber/Open-LLM-VTuber'

/** 国内代理优先，直连兜底；失败逐个回退 */
function githubProxies(url: string): string[] {
  // 顺序按实测可用来排：gh-proxy 对 release 资产返回 200，ghfast 对同址返回 403
  return [
    `https://gh-proxy.com/${url}`,
    `https://ghproxy.net/${url}`,
    `https://ghfast.top/${url}`,
    url,
  ]
}

const SHERPA_MODELS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models'

export const COMPONENTS: ComponentSpec[] = [
  {
    id: 'olvt',
    name: 'OLVT 对话后端',
    version: '1.2.1',
    urls: githubProxies(`${GITHUB_REPO}/archive/refs/tags/v{version}.zip`),
    entry: 'run_server.py',
    minBytes: 5_000_000,
    requirements: 'requirements.txt',
    // 上游把全部后端 SDK（含 torch）列为必装，随包用精简清单替代，见该文件头注释
    requirementsBundled: 'olvt-requirements.txt',
  },
  {
    // 与既有实验环境一致的 SenseVoice 多语种 ASR 模型（229 MB），不随包
    id: 'asr-sensevoice',
    name: 'ASR 模型 SenseVoice',
    version: '2024-07-17',
    urls: githubProxies(`${SHERPA_MODELS}/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-{version}.tar.bz2`),
    entry: 'model.int8.onnx',
    minBytes: 100_000_000,
  },
  {
    id: 'llm-nemotron-e4b',
    name: '本地大模型 Nemotron-3.5-Bolt-E4B',
    version: 'AD-Q4_K_M',
    kind: 'file',
    urls: NEMOTRON_URLS,
    entry: NEMOTRON_FILE,
    sha256: NEMOTRON_SHA256,
    minBytes: NEMOTRON_MIN_BYTES,
    targetDir: preferredModelsDir,
  },
  {
    id: 'llm-nemotron-mmproj',
    name: '本地视觉头 Nemotron-E4B mmproj',
    version: 'F16',
    kind: 'file',
    urls: NEMOTRON_MMPROJ_URLS,
    entry: NEMOTRON_MMPROJ_FILE,
    minBytes: NEMOTRON_MMPROJ_MIN_BYTES,
    targetDir: preferredModelsDir,
  },
]

/** uv 可执行文件：环境变量优先，其次随包 tools/uv.exe 与开发期的 build/tools/uv.exe */
export function uvBinary(): string | null {
  if (process.env.DHVW_UV) return process.env.DHVW_UV
  return (
    [path.join(resourcesRoot(), 'tools', 'uv.exe'), path.join(app.getAppPath(), 'build', 'tools', 'uv.exe')].find((p) =>
      fs.existsSync(p),
    ) ?? null
  )
}

/** 首次写入失败（安装目录只读）才退到用户数据目录，避免“静默散落” */
let fallbackRoot: string | null = null

function rootDir(): string {
  return fallbackRoot ?? componentsRoot()
}

export function componentDir(spec: ComponentSpec): string {
  return path.join(rootDir(), spec.id, spec.version)
}

/**
 * 升级前的组件在安装目录内（`<安装根>/resources/components`）。新版改落用户数据目录，
 * 老用户机器上那份还在（升级只删安装目录的新副本之前已经装过），直接复用不重下 229 MB。
 */
function legacyComponentDir(spec: ComponentSpec): string {
  return path.join(legacyComponentsRoot(), spec.id, spec.version)
}

/** 解析组件实际所在目录：优先使用受管 components 目录，或根目录 local_ai/models */
export function resolveComponentDir(spec: ComponentSpec): string {
  if (spec.id === 'llm-nemotron-e4b') {
    const found = resolveNemotronModel()
    if (found) return found.dir
    return spec.targetDir?.() ?? preferredModelsDir()
  }
  if (spec.id === 'llm-nemotron-mmproj') {
    const found = resolveNemotronMmproj()
    if (found) return found.dir
    return spec.targetDir?.() ?? preferredModelsDir()
  }
  const primary = componentDir(spec)
  if (fs.existsSync(path.join(primary, spec.entry))) return primary
  // 旧版装在安装目录里：内容完整就沿用，避免升级后无谓重下
  const legacy = legacyComponentDir(spec)
  if (fs.existsSync(path.join(legacy, spec.entry))) return legacy
  if (spec.id === 'asr-sensevoice') {
    const folder = `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-${spec.version}`
    const candidates = [
      path.resolve(resourcesRoot(), '../vendor/Open-LLM-VTuber/models', folder),
      path.join(rootDir(), 'olvt', '1.2.1', 'models', folder),
      path.join(legacyComponentsRoot(), 'olvt', '1.2.1', 'models', folder),
    ]
    for (const dir of candidates) {
      if (fs.existsSync(path.join(dir, spec.entry))) return dir
    }
  }
  return primary
}

function ensureWritable(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, `.write-test-${process.pid}`)
  fs.writeFileSync(probe, 'ok')
  fs.rmSync(probe, { force: true })
}

function isReady(spec: ComponentSpec): boolean {
  if (spec.id === 'llm-nemotron-e4b') return Boolean(resolveNemotronModel())
  if (spec.id === 'llm-nemotron-mmproj') return Boolean(resolveNemotronMmproj())
  return fs.existsSync(path.join(resolveComponentDir(spec), spec.entry))
}

export function componentStatus(spec: ComponentSpec): ComponentStatus {
  const dir = resolveComponentDir(spec)
  const ready = isReady(spec)
  if (spec.id === 'llm-nemotron-e4b') {
    const llama = resolveLlamaServer()
    const mmproj = resolveNemotronMmproj()
    const visionTag = mmproj ? '已挂载 mmproj 视觉' : '纯文本（未挂载 mmproj）'
    return {
      id: spec.id,
      name: spec.name,
      version: spec.version,
      state: ready ? 'ready' : 'missing',
      path: dir,
      canOpenFolder: true,
      canActivateLocalLlm: Boolean(ready && llama),
      detail: llama
        ? `引擎 ${llama.variant}（${visionTag}）· 调优参数：${NEMOTRON_TUNING_SUMMARY}`
        : `未找到 llama-server.exe，请放入 ${preferredLlamaDir()}`,
    }
  }
  if (spec.id === 'llm-nemotron-mmproj') {
    return {
      id: spec.id,
      name: spec.name,
      version: spec.version,
      state: ready ? 'ready' : 'missing',
      path: dir,
      canOpenFolder: true,
      detail: ready ? '已就绪，启动本地 llama 时自动通过 --mmproj 挂载视觉理解能力' : '可选组件：下载后为 Nemotron-3.5-Bolt-E4B 启用看图/视觉能力',
    }
  }
  return {
    id: spec.id,
    name: spec.name,
    version: spec.version,
    state: ready ? 'ready' : 'missing',
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
  await downloadFile({
    urls,
    dest,
    onProgress,
    minBytes: spec.minBytes,
    sha256: spec.sha256,
    log: (level, message, extra) => log(level, 'download', message, { component: spec.id, ...extra }),
  })
}

export async function ensureComponent(
  spec: ComponentSpec,
  onProgress: (pct: number) => void,
  indexUrl = 'https://mirrors.aliyun.com/pypi/simple',
): Promise<ComponentStatus> {
  if (isReady(spec)) return componentStatus(spec)
  let dir = spec.targetDir ? spec.targetDir() : componentDir(spec)
  try {
    ensureWritable(dir)
  } catch {
    fallbackRoot = path.join(dataDir, 'components')
    dir = spec.kind === 'file' ? path.join(fallbackRoot, 'local-llm', 'models') : componentDir(spec)
    ensureWritable(dir)
  }
  if (spec.kind === 'file') {
    const dest = path.join(dir, spec.entry)
    try {
      await download(spec.urls, dest, spec, onProgress)
      if (!isReady(spec)) throw new Error(`下载完成后未检测到 ${spec.entry}`)
      onProgress(100)
      return componentStatus(spec)
    } catch (err) {
      return {
        ...componentStatus(spec),
        state: 'failed',
        error: (err as Error).message,
      }
    }
  }
  const archive = path.join(dir, 'package.zip')
  try {
    await download(spec.urls, archive, spec, onProgress)
    // Windows 自带 bsdtar，可直接解 zip
    const tar = spawnSync(systemTar(), ['-xf', archive, '-C', dir], { encoding: 'utf8' })
    if (tar.error) throw tar.error
    if (tar.status !== 0) throw new Error(`解压失败：${tar.stderr?.slice(0, 300)}`)
    fs.rmSync(archive, { force: true })
    flatten(dir, spec)
    if (!isReady(spec)) throw new Error(`解压后缺少 ${spec.entry}`)
    installDeps(spec, dir, indexUrl, onProgress)
    return componentStatus(spec)
  } catch (err) {
    return {
      ...componentStatus(spec),
      state: 'failed',
      error: (err as Error).message,
    }
  }
}

/**
 * 把组件依赖装进共享的 runtime/site-packages（ADR-PC-014 单一 site-packages）。
 * uv 随安装包提供，索引走国内镜像；失败直接抛错，让界面显示原因而不是“装好了但跑不起来”。
 */
function installDeps(
  spec: ComponentSpec,
  dir: string,
  indexUrl: string,
  onProgress: (pct: number) => void,
): void {
  if (!spec.requirements) return
  const bundled = spec.requirementsBundled ? path.join(bundledResourceDir(), spec.requirementsBundled) : ''
  const req = bundled && fs.existsSync(bundled) ? bundled : path.join(dir, spec.requirements)
  if (!fs.existsSync(req)) {
    log('warn', 'component', '缺少依赖清单，跳过依赖安装', { component: spec.id, req })
    return
  }
  const runtime = runtimeDir()
  const uv = uvBinary()
  if (!uv) throw new Error('缺少 uv（打包时应随 tools/uv.exe 提供）')
  onProgress(60)
  log('info', 'component', '安装组件依赖', { component: spec.id, req, uv })
  const args = [
    'pip',
    'install',
    '--python',
    path.join(runtime, 'python.exe'),
    '--target',
    // 与首启依赖同一目录：升级不丢已装依赖，避免每次更新重装 OLVT 全套
    depsDir(),
    '--index-url',
    indexUrl,
    '--no-cache',
    '--quiet',
    '-r',
    req,
  ]
  const startedDeps = Date.now()
  const out = spawnSync(uv, args, { encoding: 'utf8', timeout: 30 * 60 * 1000 })
  if (out.error) throw out.error
  if (out.status !== 0) {
    throw new Error(`依赖安装失败：${String(out.stderr ?? '').slice(-400) || String(out.stdout ?? '').slice(-400)}`)
  }
  log('info', 'component', '组件依赖已安装', { component: spec.id, ms: Date.now() - startedDeps })
  onProgress(100)
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
