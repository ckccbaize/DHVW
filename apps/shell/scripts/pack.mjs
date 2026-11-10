// 打包脚本：固定走国内镜像，避免 electron / nsis 资源从 GitHub 超时。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const shellDir = path.resolve(dir, '..')

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://npmmirror.com/mirrors/electron-builder-binaries/',
}

const cli = path.join(shellDir, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')
const child = spawn(process.execPath, [cli, '--win', 'nsis', '--publish', 'never', ...process.argv.slice(2)], {
  cwd: shellDir,
  env,
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 1))
