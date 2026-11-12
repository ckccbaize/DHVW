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
  /** http（默认，GET healthPath 期望 <400）或 tcp（能连上端口即视为就绪） */
  healthMode?: 'http' | 'tcp'
}

export interface SettingsView {
  llm: { baseUrl: string; model: string; temperature: number; hasKey: boolean }
  ports: { olvt: number; tts: number }
  asr: { enabled: boolean; ready: boolean }
  olvt: { characterName: string; humanName: string; personaPrompt: string }
  tts: { refAudioPath: string; refText: string; refLang: string; textLang: string }
}

export interface SettingsPatch {
  llm?: Partial<{ baseUrl: string; model: string; temperature: number }>
  ports?: Partial<{ olvt: number; tts: number }>
  asr?: Partial<{ enabled: boolean }>
  olvt?: Partial<{ characterName: string; humanName: string; personaPrompt: string }>
  tts?: Partial<{ refAudioPath: string; refText: string; refLang: string; textLang: string }>
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

export interface ComponentProgress {
  id: string
  progress: number
}

export interface ActionRequest {
  id: string
  action: 'start' | 'stop' | 'restart'
}
