// 准备随包内置的 CPython 3.12 运行时（ADR-PC-014）：优先国内镜像，校验后解压到 apps/shell/runtime。
// 用法：node scripts/fetch-runtime.mjs [--force]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadWithMirrors } from './lib/mirror.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const shellDir = path.resolve(dir, '..')
const runtimeDir = path.join(shellDir, 'runtime')
const pythonExe = path.join(runtimeDir, 'python.exe')
const cacheDir = path.join(shellDir, 'node_modules', '.cache', 'dhvw')
const archive = path.join(cacheDir, 'python-3.12.10-embed-amd64.zip')

const PY_VERSION = '3.12.10'
const MIRRORS = [
  `https://mirrors.huaweicloud.com/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`,
  `https://mirrors.aliyun.com/python-release/windows/python-${PY_VERSION}-embed-amd64.zip`,
  `https://registry.npmmirror.com/-/binary/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`,
]

if (fs.existsSync(pythonExe) && !process.argv.includes('--force')) {
  console.log(`[skip] 运行时已存在：${pythonExe}`)
  process.exit(0)
}

fs.rmSync(runtimeDir, { recursive: true, force: true })
fs.mkdirSync(runtimeDir, { recursive: true })

if (!fs.existsSync(archive) || process.argv.includes('--force')) {
  await downloadWithMirrors(MIRRORS, archive, { label: `python ${PY_VERSION} embed`, minBytes: 9_000_000 })
}

// Windows 自带 bsdtar，可直接解 zip
execFileSync('tar', ['-xf', archive, '-C', runtimeDir], { stdio: 'inherit' })

if (!fs.existsSync(pythonExe)) {
  console.error(`解压后缺少 ${pythonExe}`)
  process.exit(1)
}

// embeddable 包默认只信任同目录 zip；关闭隔离并放开 services 路径由宿主通过 PYTHONPATH 注入。
const pth = fs.readdirSync(runtimeDir).find((f) => /^python\d+\._pth$/.test(f))
if (pth) {
  const file = path.join(runtimeDir, pth)
  const text = fs.readFileSync(file, 'utf8').replace(/^#import site$/m, 'import site')
  fs.writeFileSync(file, text, 'utf8')
}

// 嵌入式 CPython 带 ._pth 时进入 isolated 模式，PYTHONPATH 被忽略；
// 用 sitecustomize 承接宿主注入的模块搜索路径。
fs.writeFileSync(
  path.join(runtimeDir, 'sitecustomize.py'),
  [
    '# 由 scripts/fetch-runtime.mjs 生成：嵌入式运行时读取 DHVW_PYTHONPATH',
    'import os',
    'import sys',
    '',
    'for entry in (os.environ.get("DHVW_PYTHONPATH") or "").split(os.pathsep):',
    '    if entry and os.path.isdir(entry) and entry not in sys.path:',
    '        sys.path.append(entry)',
    '',
  ].join('\n'),
  'utf8',
)

const probe = execFileSync(pythonExe, ['-c', 'import sys; print(sys.version.split()[0])'], { encoding: 'utf8' }).trim()
console.log(`[ok] 内置运行时就绪：python ${probe} -> ${pythonExe}`)
