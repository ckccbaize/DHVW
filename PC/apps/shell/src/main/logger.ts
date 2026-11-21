import fs from 'node:fs'
import { shellLogFile } from './paths'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3

let stream: fs.WriteStream | null = null
let written = 0
const ring: string[] = []

/**
 * stdout/stderr 可能已断开：从终端启动后把终端关掉、或被别的进程当作子进程接管后管道断裂。
 * 此时向它们 write 会异步 emit 'error'（EPIPE），没有监听器就会变成 uncaughtException 打死主进程。
 * 日志不是业务功能，控制台没了就静默降级到只落盘。
 */
let consoleUsable = true

function guardConsole(): void {
  const onBroken = (err: Error & { code?: string }) => {
    if (consoleUsable) {
      consoleUsable = false
      // 落盘通道不受影响；这里只在文件里留一条痕迹，不再往断掉的流写。
      try {
        stream?.write(
          `${JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            scope: 'logger',
            message: 'stdout/stderr 已断开，日志改为只落盘',
            code: err?.code,
          })}\n`,
        )
      } catch {
        /* 落盘也失败就彻底放弃 */
      }
    }
  }
  process.stdout.on('error', onBroken)
  process.stderr.on('error', onBroken)
}

guardConsole()

function open(): fs.WriteStream {
  const file = shellLogFile()
  try {
    written = fs.statSync(file).size
  } catch {
    written = 0
  }
  if (written > MAX_BYTES) rotate()
  stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' })
  stream.on('error', () => {
    /* 日志落盘失败不能拖垮外壳 */
  })
  return stream
}

function rotate(): void {
  const file = shellLogFile()
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = `${file}.${i}`
    const to = `${file}.${i + 1}`
    if (fs.existsSync(from)) fs.renameSync(from, to)
  }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`)
  written = 0
}

export function log(level: Level, scope: string, message: string, extra?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, scope, message, ...extra }
  const line = JSON.stringify(entry)
  ring.push(line)
  if (ring.length > 500) ring.shift()
  if (!stream) open()
  stream?.write(line + '\n')
  written += line.length + 1
  // 控制台只是开发期便利：stdout/stderr 断开后不再往里写（写入异步抛 EPIPE，try/catch 抓不到）。
  if (consoleUsable) {
    try {
      if (level === 'error' || level === 'warn') console.error(line)
      else console.log(line)
    } catch {
      /* 同步抛出说明流已坏：落盘已经写过，忽略 */
    }
  }
  if (written > MAX_BYTES) {
    stream?.end()
    stream = null
    rotate()
    open()
  }
}

export function tail(limit = 200): string[] {
  return ring.slice(-limit)
}
