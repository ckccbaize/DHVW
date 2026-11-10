import fs from 'node:fs'
import { shellLogFile } from './paths'

type Level = 'debug' | 'info' | 'warn' | 'error'

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3

let stream: fs.WriteStream | null = null
let written = 0
const ring: string[] = []

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
  if (level === 'error' || level === 'warn') console.error(line)
  else console.log(line)
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
