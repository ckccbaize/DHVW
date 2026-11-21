import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { app } from 'electron'
import { bundledResourceDir, dataDir, runtimeDir } from './paths'
import { log } from './logger'

/**
 * 运行时依赖自检与首启安装。
 *
 * 用户机器上不存在开发机那套 site-packages，所以安装包必须自带“装依赖”的能力：
 * 内置 CPython + 随包 uv.exe + 随包 requirements，首启用国内镜像装一次。
 * 安装走子进程异步执行，界面不冻结；装完写 marker，之后启动只做一次 import 探测。
 */

/** 编排器与像素形象/地图工具链模块级导入的包（缺一个服务就起不来） */
const REQUIRED_MODULES = ['fastapi', 'uvicorn', 'httpx', 'numpy', 'scipy', 'PIL']

/** 记忆向量是可降级能力：装失败只告警，不阻断启动 */
const OPTIONAL_REQUIREMENTS = 'memory-requirements.txt'

export interface DepsStatus {
  ok: boolean
  installed: boolean
  missing: string[]
  error?: string
}

/**
 * 依赖落地目录。
 *
 * 打包后优先用户数据目录：NSIS 升级会清空安装目录，装在里面等于每次更新重装一次
 * （实测 1–3 分钟）。开发期仍用 apps/shell/runtime/site-packages，与手工调试习惯一致。
 * 写入失败（权限不足等）时退回另一处，保证总能装上。
 */
export function depsDir(): string {
  const candidates = app.isPackaged
    ? [path.join(dataDir, 'site-packages'), path.join(runtimeDir(), 'site-packages')]
    : [path.join(runtimeDir(), 'site-packages'), path.join(dataDir, 'site-packages')]
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      const probe = path.join(dir, `.write-test-${process.pid}`)
      fs.writeFileSync(probe, 'ok')
      fs.rmSync(probe, { force: true })
      return dir
    } catch {
      continue
    }
  }
  throw new Error(`依赖目录不可写：${candidates.join(' , ')}`)
}

/** 已就绪的依赖目录列表：宿主与子服务都必须能同时看到这两处（升级前后各一份） */
export function depsPath(): string[] {
  const dirs = [depsDir()]
  for (const other of [path.join(runtimeDir(), 'site-packages'), path.join(dataDir, 'site-packages')]) {
    if (!dirs.includes(other) && fs.existsSync(other)) dirs.push(other)
  }
  return dirs
}

function probeMissing(python: string): string[] {
  const script = [
    'import importlib.util as u, sys',
    `missing = [m for m in ${JSON.stringify(REQUIRED_MODULES)} if u.find_spec(m) is None]`,
    'sys.stdout.write(",".join(missing))',
  ].join('\n')
  const out = spawnSync(python, ['-c', script], {
    encoding: 'utf8',
    timeout: 30_000,
    // 依赖可能落在安装根目录外（只读安装时退到 %APPDATA%），探测要带上同一批目录
    env: { ...process.env, DHVW_PYTHONPATH: depsPath().join(path.delimiter) },
  })
  if (out.status !== 0) {
    // 解释器本身有问题时不要假装“依赖齐全”，交给调用方报错
    throw new Error(`依赖探测失败：${String(out.stderr || out.stdout || out.error || '').slice(-400)}`)
  }
  return String(out.stdout ?? '')
    .trim()
    .split(',')
    .filter(Boolean)
}

function installRequirements(uv: string, python: string, reqFile: string, indexUrl: string): Promise<string> {
  const args = [
    'pip',
    'install',
    '--python',
    python,
    '--target',
    depsDir(),
    '--index-url',
    indexUrl,
    '--no-cache',
    '--quiet',
    '-r',
    reqFile,
  ]
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const started = Date.now()
  const child = spawn(uv, args, { windowsHide: true })
  let output = ''
  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString('utf8')).slice(-8000)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('error', reject)
  child.on('exit', (code) => {
    if (code === 0) {
      log('info', 'deps', '依赖安装完成', { req: path.basename(reqFile), ms: Date.now() - started })
      resolve(output)
      return
    }
    reject(new Error(output.trim().slice(-600) || `uv 退出码 ${code}`))
  })
  return promise
}

/**
 * 确保服务端依赖就绪。返回 installed=true 表示这次真的装了东西（调用方据此重启宿主）。
 * 安装是异步子进程，界面不会卡住。
 */
export async function ensureRuntimeDeps(
  python: string,
  uv: string | null,
  opts: { indexUrl?: string; onStage?: (text: string) => void } = {},
): Promise<DepsStatus> {
  let missing: string[]
  try {
    missing = probeMissing(python)
  } catch (err) {
    return { ok: false, installed: false, missing: [], error: String(err) }
  }
  if (!missing.length) return { ok: true, installed: false, missing }

  log('warn', 'deps', '缺少运行期依赖，准备安装', { missing })
  if (!uv) {
    return { ok: false, installed: false, missing, error: '缺少随包 uv.exe（安装包应带 resources/tools/uv.exe）' }
  }
  const req = path.join(bundledResourceDir(), 'orchestrator-requirements.txt')
  if (!fs.existsSync(req)) {
    return { ok: false, installed: false, missing, error: `缺少依赖清单：${req}` }
  }
  const indexUrl = opts.indexUrl ?? 'https://mirrors.aliyun.com/pypi/simple'
  opts.onStage?.('正在安装运行环境依赖（首次启动约 1–3 分钟）…')
  try {
    await installRequirements(uv, python, req, indexUrl)
  } catch (err) {
    return { ok: false, installed: true, missing, error: `依赖安装失败：${String(err).slice(-500)}` }
  }

  // 记忆向量：装不上就退化为字面检索，行为在「信息 → 记忆向量」里显式可见
  const optional = path.join(bundledResourceDir(), OPTIONAL_REQUIREMENTS)
  if (fs.existsSync(optional)) {
    opts.onStage?.('正在安装记忆向量依赖…')
    try {
      await installRequirements(uv, python, optional, indexUrl)
    } catch (err) {
      log('warn', 'deps', '记忆向量依赖安装失败，语义检索将不可用', { error: String(err).slice(-400) })
    }
  }

  let stillMissing: string[] = []
  try {
    stillMissing = probeMissing(python)
  } catch (err) {
    return { ok: false, installed: true, missing, error: String(err) }
  }
  if (stillMissing.length) {
    return { ok: false, installed: true, missing: stillMissing, error: `安装后仍缺少：${stillMissing.join(', ')}` }
  }
  return { ok: true, installed: true, missing: [] }
}
