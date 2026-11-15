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
  /** 就绪探测超时（秒）：慢启动服务可放宽，超时后仍继续探测 */
  healthTimeout?: number
}

export type LlmProtocol = 'openai-compatible' | 'anthropic'

export interface SettingsView {
  /** 老配置库没有这个键，渲染层必须按可选处理 */
  boost?: { enabled: boolean }
  llm: { baseUrl: string; model: string; temperature: number; protocol: LlmProtocol; hasKey: boolean }
  ports: { olvt: number; tts: number }
  asr: { enabled: boolean; ready: boolean }
  /** Live2D 模型 id：PC 舞台与 OLVT 共用（模型库见 resources/live2d/models 与组件的 live2d-models） */
  live2d: { model: string }
  scene: { autoPush: boolean }
  olvt: { characterName: string; humanName: string; personaPrompt: string }
  tts: { backendDir: string; refAudioPath: string; refText: string; refLang: string; textLang: string }
  gateway: { enabled: boolean; port: number }
}

export interface SettingsPatch {
  llm?: Partial<{ baseUrl: string; model: string; temperature: number; protocol: LlmProtocol }>
  ports?: Partial<{ olvt: number; tts: number }>
  asr?: Partial<{ enabled: boolean }>
  live2d?: Partial<{ model: string }>
  scene?: Partial<{ autoPush: boolean }>
  olvt?: Partial<{ characterName: string; humanName: string; personaPrompt: string }>
  tts?: Partial<{ backendDir: string; refAudioPath: string; refText: string; refLang: string; textLang: string }>
  gateway?: Partial<{ enabled: boolean; port: number }>
}

export interface Live2dModelView {
  id: string
  file: string
  source: 'bundled' | 'olvt'
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

export interface GatewayStatusView {
  running: boolean
  port: number
  urls: string[]
  caFingerprint: string
  devices: Array<{ name: string; addedAt: string; lastSeen: string | null }>
  pairing: { code: string; expiresAt: number } | null
  error?: string
}

export type WorkTier = 'idle' | 'host' | 'edge'

/** 编排器侧世界状态（只读展示，数据源是设备的 world:digest / mood:state） */
export interface WorldView {
  reachable: boolean
  device: { connected: boolean; id: string | null; tier: WorkTier }
  memory: number
  digest: {
    ts: number
    seq: number
    day: string
    minute: number
    phase: string
    weekdayName?: string
    date?: string
    display: string
    agendaDone: number
    agendaTotal: number
    scenesPending: number
    pcActions: number
  } | null
  mood: { band: string; dims: Array<{ key: string; value: number }> } | null
  error?: string
}

export interface StatsView {
  reachable: boolean
  device: { connected: boolean; id: string | null; tier: WorkTier; lastSeenS: number | null }
  digest: {
    seq: number
    ageS: number | null
    day: string
    minute: number
    phase: string
    weekdayName?: string
    date?: string
    agenda: Record<string, number>
    sceneRequests: Record<string, number>
    pcActions: Record<string, number>
    behaviors: number
    eventPool: number
  } | null
  tierTransitions: Record<string, number>
  events24h: Record<string, number>
  memory: number
  uptime: number
  error?: string
}

export type SceneState = 'queued' | 'running' | 'done' | 'failed'

export interface SceneJobView {
  id: string
  name: string
  kind: string
  seed: string
  note?: string
  state: SceneState
  startedAt: number
  finishedAt?: number
  stage?: string
  error?: string
  warnings?: string[] | null
  logTail?: string
}

/** 设备摘要里 sceneRequests 的一条在 PC 侧的受理状态（账本 kv.scene_requests） */
export interface SceneRequestView {
  id: string
  state: SceneState
  job?: string
  reason?: string
  ts: number
}

export interface ScenePushState {
  state?: 'pushed' | 'pending' | 'unpushed' | 'failed'
  attempts?: number
  updatedAt?: number
  lastError?: string | null
  reason?: string
}

export interface SceneOutputView {
  id: string
  name: string
  kind?: string
  grid?: string
  hotspots?: number
  acts?: number
  updatedAt: number
  push?: ScenePushState
}

/** 设备整份存档在 PC 侧的备份索引（data/saves/*.json） */
export interface SaveView {
  id: string
  receivedAt: number
  reason: string
  savedAt: number
  day: number | null
  minute: number | null
  scene: string | null
  bytes: number
  sha256: string
}

export interface ActionRequest {
  id: string
  action: 'start' | 'stop' | 'restart'
}
