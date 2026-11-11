import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { hostModuleRoot, logDir, ensureDir } from './paths'
import { log } from './logger'
import type { HostEvent, ServiceDef, WorkerSnapshot } from '../shared/types'

const MARK = '@@DHVW@@ '

export interface HostOptions {
  pythonPath: string
  shellPid: number
  services: ServiceDef[]
}

export class HostSupervisor extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private stopping = false
  private restarts = 0
  private restartTimer: NodeJS.Timeout | null = null
  private hostPid: number | null = null
  private hostReady = false
  private workers = new Map<string, WorkerSnapshot>()
  private stderrBuf = ''

  constructor(private opts: HostOptions) {
    super()
    for (const svc of opts.services) {
      this.workers.set(svc.id, {
        id: svc.id,
        name: svc.name,
        port: svc.port,
        pid: null,
        state: 'stopped',
        restarts: 0,
      })
    }
  }

  get pid(): number | null {
    return this.hostPid
  }

  get ready(): boolean {
    return this.hostReady
  }

  get snapshots(): WorkerSnapshot[] {
    return [...this.workers.values()]
  }

  start(): void {
    if (this.child) return
    this.stopping = false
    const runtimeFile = path.join(logDir, 'runtime-services.json')
    ensureDir(logDir)
    fs.writeFileSync(runtimeFile, JSON.stringify({ services: this.opts.services }, null, 2), 'utf8')

    const hostLog = path.join(logDir, 'host.log')
    const out = fs.createWriteStream(hostLog, { flags: 'a' })
    out.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', message: 'host starting' })}\n`)

    const args = ['-m', 'dhvw_host', '--shell-pid', String(this.opts.shellPid), '--log-dir', logDir, '--services', runtimeFile]
    log('info', 'host', '启动服务宿主', { python: this.opts.pythonPath, args })
    const child = spawn(this.opts.pythonPath, args, {
      cwd: hostModuleRoot(),
      env: {
        ...process.env,
        PYTHONPATH: hostModuleRoot(),
        // 嵌入式 CPython 忽略 PYTHONPATH，改由 runtime/sitecustomize.py 读取
        DHVW_PYTHONPATH: hostModuleRoot(),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    this.child = child
    this.hostPid = child.pid ?? null

    let buf = ''
    child.stdout.on('data', (chunk: string) => {
      buf += chunk
      let idx = buf.indexOf('\n')
      while (idx >= 0) {
        const line = buf.slice(0, idx).trimEnd()
        buf = buf.slice(idx + 1)
        if (line) this.consume(line)
        idx = buf.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuf = (this.stderrBuf + chunk).slice(-4000)
      out.write(chunk)
    })

    child.on('exit', (code, signal) => {
      this.child = null
      this.hostPid = null
      this.hostReady = false
      out.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'warn', message: 'host exit', code, signal })}\n`)
      for (const w of this.workers.values()) {
        w.pid = null
        w.state = 'stopped'
      }
      this.emit('state')
      if (this.stopping) return
      log('error', 'host', '服务宿主退出，准备重启', { code, signal, stderr: this.stderrBuf.trim().slice(-500) })
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return
    this.restarts += 1
    const delay = Math.min(5000, 500 * this.restarts)
    log('warn', 'host', '宿主重启已排期', { delay, attempt: this.restarts })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopping) this.start()
    }, delay)
  }

  private consume(line: string): void {
    if (!line.startsWith(MARK)) {
      log('info', 'host', line)
      return
    }
    let evt: HostEvent
    try {
      evt = JSON.parse(line.slice(MARK.length)) as HostEvent
    } catch {
      log('warn', 'host', '无法解析宿主事件', { line: line.slice(0, 200) })
      return
    }
    this.apply(evt)
    this.emit('event', evt)
  }

  private apply(evt: HostEvent): void {
    const ts = evt.ts ?? Date.now()
    switch (evt.type) {
      case 'host.ready':
        this.hostReady = true
        this.restarts = 0
        break
      case 'worker.started': {
        const w = evt.service ? this.workers.get(evt.service) : undefined
        if (w) {
          w.pid = evt.pid ?? null
          w.state = 'running'
          w.port = evt.port ?? w.port
        }
        break
      }
      case 'worker.restart': {
        const w = evt.service ? this.workers.get(evt.service) : undefined
        if (w) {
          w.state = 'starting'
          w.pid = null
        }
        break
      }
      case 'worker.healthy': {
        const w = evt.service ? this.workers.get(evt.service) : undefined
        if (w) w.healthy = true
        break
      }
      case 'worker.unhealthy': {
        const w = evt.service ? this.workers.get(evt.service) : undefined
        if (w) w.healthy = false
        break
      }
      case 'worker.exit':
      case 'worker.stopped':
      case 'worker.failed': {
        const w = evt.service ? this.workers.get(evt.service) : undefined
        if (w) {
          w.pid = null
          w.state = evt.type === 'worker.failed' ? 'failed' : 'stopped'
          w.lastExitCode = evt.code ?? null
          w.lastExitAt = ts
          if (typeof evt.restarts === 'number') w.restarts = evt.restarts
        }
        break
      }
      default:
        if (evt.workers) {
          for (const s of evt.workers) {
            const cur = this.workers.get(s.id)
            if (cur) Object.assign(cur, s)
          }
        }
        break
    }
    if (evt.type === 'host.ready') {
      this.emit('state')
      return
    }
    if (
      ![
        'worker.exit',
        'worker.started',
        'worker.restart',
        'worker.failed',
        'worker.stopped',
        'worker.healthy',
        'worker.unhealthy',
      ].includes(evt.type)
    )
      return
    log(evt.type === 'worker.started' ? 'info' : 'warn', 'host', evt.type, {
      service: evt.service,
      pid: evt.pid,
      code: evt.code,
    })
    this.emit('state')
  }

  send(cmd: Record<string, unknown>): boolean {
    if (!this.child?.stdin.writable) return false
    this.child.stdin.write(JSON.stringify(cmd) + '\n')
    return true
  }

  async stop(reason: string): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child) return
    log('info', 'host', '请求宿主退出', { reason })
    this.send({ cmd: 'shutdown' })
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const timer = setTimeout(() => resolve(false), 3000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
    const exited = await promise
    if (!exited) {
      log('warn', 'host', '宿主未按时退出，强制结束', { pid: child.pid })
      child.kill('SIGKILL')
    }
  }
}
