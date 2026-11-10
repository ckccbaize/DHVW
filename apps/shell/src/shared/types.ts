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
    | 'shell.gone'
  service?: string
  pid?: number
  port?: number
  code?: number | null
  restarts?: number
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
  module: string
  args: string[]
}

export interface ActionRequest {
  id: string
  action: 'start' | 'stop' | 'restart'
}
