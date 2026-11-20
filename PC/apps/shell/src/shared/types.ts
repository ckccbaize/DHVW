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
  /** false = 注册在服务表里但开机不自动拉起，按需手动或切换时启动 */
  autoStart?: boolean
}

export type LlmProtocol = 'openai-compatible' | 'anthropic'

export interface BoostGatewaysConfig {
  qq: boolean
  feishu: boolean
}

export interface FeishuBotStatusView {
  enabled: boolean
  configured: boolean
  hasSecret?: boolean
  connected: boolean
  gatewayError?: string
  appId: string
  appIdMasked: string
  paired: boolean
  ownerOpenId: string
  ownerOpenIdMasked: string
  awaitingActivation?: boolean
  proactive: boolean
  unlimitedProactive?: boolean
}

export interface QqBotStatusView {
  reachable: boolean
  configured: boolean
  hasSecret: boolean
  boostActive: boolean
  gateways?: BoostGatewaysConfig
  connected: boolean
  sandbox: boolean
  appId: string
  appIdMasked: string
  paired: boolean
  ownerOpenId: string
  ownerOpenIdMasked: string
  awaitingActivation?: boolean
  proactive: boolean
  stickerEagerness: number
  gatewayError?: string
  stickersCount?: number
  feishu?: FeishuBotStatusView
  error?: string
}

export type LlmMode = 'api' | 'local'
export type ImageGenProtocol = 'openai-images' | 'openai-chat-image' | 'gemini-native'

export const DEFAULT_FUSION_STYLE_PROMPT = [
  '画风与笔触：日系二次元角色融合厚涂（Impasto）与数字水彩质感，线条纤细柔和，光影过渡自然，带有半写实的立体感与微妙的颗粒噪点。',
  '光影与摄影感：极强的电影镜头语言，主打逆光（Backlighting）、体积光（Volumetric Lighting）与丁达尔效应。大量运用浅景深（Shallow Depth of Field）、前景虚化以及夜景光斑（Bokeh），边缘光（Rim Light）勾勒发丝与衣物轮廓。',
  '色彩基调：低饱和度、清冷通透的电影调色（Muted/Desaturated Color Palette），高光带有柔和的暖色调或朦胧雾感（Haze/Glow），明暗对比柔和且富有空气感。',
].join('\n')

export interface LlmProfile {
  baseUrl: string
  model: string
  temperature: number
  protocol: LlmProtocol
  supportsVision?: boolean
}

export interface ImageGenView {
  enabled: boolean
  protocol: ImageGenProtocol
  baseUrl: string
  model: string
  fusionStylePrompt?: string
  hasKey: boolean
}

export interface SettingsView {
  /** 老配置库没有这个键，渲染层必须按可选处理 */
  boost?: { enabled: boolean; gateways?: BoostGatewaysConfig }
  qqBot?: {
    appId: string
    sandbox: boolean
    ownerOpenId: string
    proactive: boolean
    stickerEagerness: number
    hasSecret: boolean
  }
  feishuBot?: {
    appId: string
    ownerOpenId: string
    proactive: boolean
    stickerEagerness: number
    hasSecret: boolean
  }
  llmMode: LlmMode
  llmApi: LlmProfile
  localLlmReady: boolean
  localLlmModel: string
  llm: { baseUrl: string; model: string; temperature: number; protocol: LlmProtocol; supportsVision?: boolean; hasKey: boolean }
  imageGen?: ImageGenView
  hasRef3d?: boolean
  ports: { olvt: number; tts: number; llama: number }
  asr: { enabled: boolean; ready: boolean }
  /** Live2D 模型 id：PC 舞台与 OLVT 共用（模型库见 resources/live2d/models 与组件的 live2d-models） */
  live2d: { model: string }
  /** 像素角色模型 id（空串表示使用默认内置精灵） */
  pixelCharacterId?: string
  scene: { autoPush: boolean }
  /** 主动说话：仅 OLVT，且只有显示态为「显现」时才真正生效 */
  proactive: {
    enabled: boolean
    idleSeconds: number
    gapSeconds: number
    maxGapSeconds: number
    dailyMax: number
    quietStart: string
    quietEnd: string
  }
  olvt: {
    characterName: string
    humanName: string
    personaPrompt: string
    personaCard?: CharacterCardData | null
  }
  tts: { backendDir: string; refAudioPath: string; refText: string; refLang: string; textLang: string }
  gateway: { enabled: boolean; port: number }
}

export interface SettingsPatch {
  boost?: Partial<{ enabled: boolean; gateways: Partial<BoostGatewaysConfig> }>
  llmMode?: LlmMode
  llmApi?: Partial<LlmProfile>
  llm?: Partial<{ baseUrl: string; model: string; temperature: number; protocol: LlmProtocol; supportsVision: boolean }>
  imageGen?: Partial<{
    enabled: boolean
    protocol: ImageGenProtocol
    baseUrl: string
    model: string
    fusionStylePrompt: string
  }>
  ports?: Partial<{ olvt: number; tts: number; llama: number }>
  asr?: Partial<{ enabled: boolean }>
  live2d?: Partial<{ model: string }>
  pixelCharacterId?: string
  scene?: Partial<{ autoPush: boolean }>
  proactive?: Partial<{
    enabled: boolean
    idleSeconds: number
    gapSeconds: number
    maxGapSeconds: number
    dailyMax: number
    quietStart: string
    quietEnd: string
  }>
  olvt?: Partial<{
    characterName: string
    humanName: string
    personaPrompt: string
    personaCard: CharacterCardData | null
  }>
  tts?: Partial<{ backendDir: string; refAudioPath: string; refText: string; refLang: string; textLang: string }>
  gateway?: Partial<{ enabled: boolean; port: number }>
}

export interface Live2dModelView {
  id: string
  file: string
  /** bundled=随包；olvt=OLVT 组件模型目录（live2d-models） */
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
  /** 附加说明（如本地 llama 引擎路径与调优参数摘要） */
  detail?: string
  /** 是否支持打开组件目录（方便手动放入模型文件） */
  canOpenFolder?: boolean
  /** 本地大模型是否已具备推理引擎并可一键切换为当前对话后端 */
  canActivateLocalLlm?: boolean
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

/** PC 扫描到的 ARM 设备（dhvw-shell 局域网配对口）。 */
export interface ArmDeviceView {
  host: string
  name: string
  version: string
  paired: boolean
}

/** 一键配对结果：浏览器测试或 ARM 设备都复用。 */
export interface GatewayPairResult {
  ok: boolean
  token?: string
  wsUrl?: string
  armUrl?: string
  name?: string
  error?: string
}

export type WorkTier = 'idle' | 'host' | 'edge'

/** ARM 世界生活控制台快照（设备 IndexedDB 的只读镜像） */
export interface ArmConsoleSnapshot {
  ts: number
  life: Record<string, unknown> | null
  qq: Record<string, unknown> | null
  speed: number
  llm: { baseUrl: string; model: string; source: string }
  llmLog: Array<Record<string, unknown>>
  memory: Array<Record<string, unknown>>
  writings: Array<Record<string, unknown>>
  plots: Array<Record<string, unknown>>
  sceneRequests: Array<Record<string, unknown>>
  dailyPlots: Record<string, Record<string, unknown>>
  mood: Record<string, unknown> | null
  browses: Array<Record<string, unknown>>
  desires: Array<Record<string, unknown>>
  sudden: Array<Record<string, unknown>>
  highlight: Record<string, unknown> | null
  summary: string
  events: Array<Record<string, unknown>>
}

export interface ArmConsoleResult {
  ok: boolean
  error?: string
  data?: ArmConsoleSnapshot
}

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

/** 主动说话现状（编排器 /dhvw/proactive + OLVT 自报） */
export interface ProactiveStateView {
  display?: string
  payload?: Record<string, unknown>
  push?: { pushed: boolean; enabled?: boolean; error?: string }
  olvt?: {
    reachable: boolean
    enabled?: boolean
    clients?: number
    gap?: number
    unanswered?: number
    dailyCount?: number
    lastActivityAge?: number
    lastSpokeSecondsAgo?: number | null
    spokenTotal?: number
    reason?: string
    error?: string | null
  }
  error?: string
}

/** 编排器记忆向量服务信息（GET /dhvw/memory/stats + 可达性） */
export interface MemoryStatsView {
  reachable: boolean
  error?: string
  total?: number
  fts?: number
  vec?: number
  vec_ready?: boolean
  semantic?: boolean
  model?: string
  dim?: number
  model_dir?: string | null
  model_files?: boolean
  embed_error?: string | null
  deps?: Record<string, string | null>
  db_path?: string
  db_bytes?: number
  /** 已判遗忘（退出检索，保留 FORGOT_KEEP_DAYS 天后物理删除） */
  forgotten?: number
  superseded?: number
  active?: number
  avg_retention?: number | null
  forgetting?: {
    floor: number
    reinforceFactor: number
    stabilityDays: Record<string, number>
    keepForgottenDays: number
    keepSupersededDays: number
  }
}

/** 遗忘曲线：最接近遗忘的活跃记忆（保持率升序） */
export interface MemoryCurveView {
  now: number
  floor: number
  reinforceFactor: number
  stabilityDays: Record<string, number>
  active: number
  average: number | null
  items: Array<{
    id: string
    text: string
    tier: string | null
    retention: number
    stabilityDays: number
    halfLifeDays: number
    ageDays: number
    recalls: number
    protected: boolean
  }>
}

/** 系统文件/文件夹选择框的参数与结果 */
export interface PathPickArgs {
  kind: 'dir' | 'file'
  title?: string
  defaultPath?: string
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface PathPickResult {
  ok: boolean
  path?: string
}

export interface ActionRequest {
  id: string
  action: 'start' | 'stop' | 'restart'
}

/** 兼容酒馆（SillyTavern V1/V2/V3）的结构化角色卡数据 */
export interface CharacterCardData {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  system_prompt: string
  post_history_instructions: string
  creator_notes: string
  tags: string[]
  creator: string
  character_version: string
  spec?: 'chara_card_v2' | 'chara_card_v3'
  avatarDataUrl?: string
  sources?: Array<{ title: string; url: string }>
}

export interface PersonaCardImportResult {
  ok: boolean
  error?: string
  card?: CharacterCardData
  compiledPrompt?: string
  suggestedL0?: Array<{ id?: string; text: string; importance?: number }>
  specDetected?: string
}

export interface PersonaGenerateInput {
  query: string
  humanName?: string
  extraPrompt?: string
  autoApply?: boolean
}

export interface PersonaJobResultView {
  card: CharacterCardData
  compiledPrompt: string
  l0Memories: Array<{ id: string; text: string; tier: 'L0'; importance: number }>
  summary: string
  sources: Array<{ title: string; url: string }>
}

export interface PersonaJobView {
  id: string
  query: string
  humanName: string
  extraPrompt: string
  autoApply: boolean
  status: 'queued' | 'running' | 'done' | 'error'
  stage: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  error: string | null
  result: PersonaJobResultView | null
  logTail: string[]
}

export interface MemoryFactView {
  id: string
  text: string
  tier: 'L0' | 'L1' | 'L2' | string
  src: string
  stability: number
  importance: number
  ts: number
  updatedAt: number
}

export interface CharacterSheetView {
  id: string
  name: string
  sourceFileName?: string
  rowOrder: string
  detectedRowOrder?: string
  autoFixDir?: boolean
  cleanInnerWhite?: boolean
  corrections?: string[]
  manualFlips?: Record<string, boolean[]>
  frame: { w: number; h: number }
  animations: string[]
  sheetSize?: { w: number; h: number }
  createdAt: number
  updatedAt: number
  active?: boolean
}

export interface CharacterSheetMetaJson {
  schema_version: number
  image: string
  frame: { w: number; h: number }
  anchor: { x: number; y: number }
  directions: string[]
  animations: Record<
    string,
    {
      fps: number
      loop: boolean
      frameCount: number
      frames: Record<string, number[]>
    }
  >
}

export interface CharacterGenerateInput {
  name?: string
  filename?: string
  imageBase64: string
  rowOrder?: string
  frameW?: number
  frameH?: number
  autoApply?: boolean
  autoFixDir?: boolean
  cleanInnerWhite?: boolean
  manualFlips?: Record<string, boolean[]>
}

export interface Generated4x4ItemView {
  id: string
  prompt: string
  model?: string
  usedRef?: boolean
  used3dRef?: boolean
  createdAt: number
  imageBase64: string
  dataUrl: string
}

export interface CharacterSampleView {
  id: string
  name: string
  filename: string
  badge: string
  description: string
  rowOrder: string
  imageBase64: string
  dataUrl: string
}
