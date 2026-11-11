export type WorkerState = 'starting' | 'running' | 'stopped' | 'failed'

export interface WorkerSnapshot {
  id: string
  name: string
  port: number
  pid: number | null
  state: WorkerState
  restarts: number
  lastExitCode?: number | null
  lastExitAt?: number
  /** 就绪探针结果；undefined 表示尚未探测或未声明探针 */
  healthy?: boolean
}

export interface HostEvent {
  ts: number
  type:
    | 'host.ready'
    | 'host.heartbeat'
    | 'host.shutdown'
    | 'worker.started'
    | 'worker.stopped'
    | 'worker.exit'
    | 'worker.failed'
    | 'worker.restart'
    | 'worker.healthy'
    | 'worker.unhealthy'
    | 'shell.gone'
  service?: string
  pid?: number
  port?: number
  code?: number | null
  restarts?: number
  ms?: number
  message?: string
  workers?: WorkerSnapshot[]
}

export interface AppSnapshot {
  hostPid: number | null
  hostReady: boolean
  workers: WorkerSnapshot[]
  dataDir: string
  logDir: string
  autoLaunch: boolean
  pythonPath: string
  llm: { baseUrl: string; model: string }
}

export interface ServiceDef {
  id: string
  name: string
  port: number
  /** 解释器内模块入口（占位 sidecar 用） */
  module: string
  args: string[]
  /** 真实 sidecar：可执行文件与参数，{port} 替换为分配端口 */
  command?: string[]
  cwd?: string
  env?: Record<string, string>
  /** 就绪探针路径，缺省不探测 */
  healthPath?: string
}

export interface ActionRequest {
  id: string
  action: 'start' | 'stop' | 'restart'
}
