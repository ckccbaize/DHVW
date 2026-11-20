import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionRequest,
  AppSnapshot,
  ArmConsoleResult,
  CharacterCardData,
  CharacterGenerateInput,
  CharacterSampleView,
  CharacterSheetMetaJson,
  CharacterSheetView,
  ComponentProgress,
  ArmDeviceView,
  ComponentStatus,
  GatewayPairResult,
  GatewayStatusView,
  HostEvent,
  LlmMode,
  LlmProtocol,
  SettingsPatch,
  SceneJobView,
  SceneOutputView,
  Live2dModelView,
  MemoryCurveView,
  MemoryFactView,
  MemoryStatsView,
  PersonaCardImportResult,
  PersonaGenerateInput,
  PersonaJobView,
  ProactiveStateView,
  PathPickArgs,
  PathPickResult,
  QqBotStatusView,
  SceneRequestView,
  SaveView,
  SettingsView,
  StatsView,
  WorldView,
} from '../shared/types'

const api = {
  snapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke('dhvw:snapshot'),
  action: (req: ActionRequest): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('dhvw:action', req),
  tailLog: (id: string, lines = 80): Promise<string> => ipcRenderer.invoke('dhvw:tailLog', { id, lines }),
  setAutoLaunch: (enabled: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:setAutoLaunch', enabled),
  openDataDir: (): Promise<string> => ipcRenderer.invoke('dhvw:openDataDir'),
  restartHost: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:restartHost'),
  probeLlm: (): Promise<{ ok: boolean; ms: number; status?: number; note?: string }> =>
    ipcRenderer.invoke('dhvw:probe'),
  settings: (): Promise<SettingsView> => ipcRenderer.invoke('dhvw:settings'),
  saveSettings: (patch: SettingsPatch): Promise<{ ok: boolean; error?: string; settings?: SettingsView }> =>
    ipcRenderer.invoke('dhvw:saveSettings', patch),
  saveApiKey: (key: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('dhvw:saveApiKey', key),
  listModels: (req?: {
    baseUrl?: string
    protocol?: LlmProtocol
    apiKey?: string
  }): Promise<{ ok: boolean; models: string[]; error?: string; url?: string }> =>
    ipcRenderer.invoke('dhvw:listModels', req),
  clearApiKey: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:clearApiKey'),
  components: (): Promise<ComponentStatus[]> => ipcRenderer.invoke('dhvw:components'),
  gateway: (): Promise<GatewayStatusView | null> => ipcRenderer.invoke('dhvw:gateway'),
  world: (): Promise<WorldView> => ipcRenderer.invoke('dhvw:world'),
  stats: (): Promise<StatsView> => ipcRenderer.invoke('dhvw:stats'),
  live2d: (): Promise<{ url: string | null; model: string | null; error?: string }> =>
    ipcRenderer.invoke('dhvw:live2d'),
  live2dModels: (): Promise<{ current: string | null; models: Live2dModelView[] }> =>
    ipcRenderer.invoke('dhvw:live2dModels'),
  /** 系统选择框：取一个文件夹/文件路径（取消时 ok=false） */
  pickPath: (args: PathPickArgs): Promise<PathPickResult> => ipcRenderer.invoke('dhvw:pickPath', args),
  /** 主动说话现状（显现态 + OLVT 自报的节奏与理由） */
  proactiveState: (): Promise<ProactiveStateView> => ipcRenderer.invoke('dhvw:proactiveState'),
  /** 记忆向量服务信息（模型 / 依赖 / 索引计数 / DB） */
  memoryStats: (): Promise<MemoryStatsView> => ipcRenderer.invoke('dhvw:memoryStats'),
  /** 重建 FTS5 + 向量索引（派生数据，正文不动） */
  memoryRebuild: (): Promise<{ ok: boolean; total?: number; fts?: number; vec?: number; error?: string }> =>
    ipcRenderer.invoke('dhvw:memoryRebuild'),
  /** 按遗忘曲线结算（dryRun=true 只报数，不写库） */
  memoryForget: (dryRun: boolean): Promise<Record<string, unknown>> =>
    ipcRenderer.invoke('dhvw:memoryForget', dryRun),
  /** 最接近遗忘的记忆（保持率升序） */
  memoryCurve: (k?: number): Promise<MemoryCurveView | { ok: false; error: string }> =>
    ipcRenderer.invoke('dhvw:memoryCurve', k ?? 8),
  /** 把记忆向量运行时依赖装进共享 site-packages */
  memoryDepsInstall: (): Promise<{ ok: boolean; output?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:memoryDepsInstall'),
  /** 在资源管理器里打开一个已存在的目录 */
  openDirectory: (dir: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dhvw:openDirectory', dir),
  /** 在资源管理器里打开现用 Live2D 模型文件夹 */
  openLive2dDir: (): Promise<{ ok: boolean; path: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:openLive2dDir'),
  armPreview: (): Promise<{ url: string | null; localUrl?: string | null; error?: string }> =>
    ipcRenderer.invoke('dhvw:armPreview'),
  setDisplay: (
    state: 'overview' | 'present',
  ): Promise<{ ok: boolean; delivered?: number; state?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:setDisplay', state),
  /** ARM 世界生活控制台快照（经编排器转发，不直连设备） */
  armConsoleSnapshot: (): Promise<ArmConsoleResult> => ipcRenderer.invoke('dhvw:armConsoleSnapshot'),
  /** 远程控制台命令：trigger / speed / llm-set / llm-clear / open */
  armConsoleCommand: (command: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dhvw:armConsoleCommand', command),
  scenes: (): Promise<{
    reachable: boolean
    jobs: SceneJobView[]
    requests: SceneRequestView[]
    outputs: SceneOutputView[]
    autoPush?: boolean
    error?: string
  }> => ipcRenderer.invoke('dhvw:scenes'),
  sceneGenerate: (spec: {
    kind?: string
    name?: string
    seed?: string
    distance?: number
    note?: string
  }): Promise<{ ok: boolean; job?: SceneJobView; error?: string }> => ipcRenderer.invoke('dhvw:sceneGenerate', spec),
  sceneRetry: (id: string): Promise<{ ok: boolean; job?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:sceneRetry', id),
  scenePush: (id: string): Promise<{ ok: boolean; state?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:scenePush', id),
  sceneJobRetry: (id: string): Promise<{ ok: boolean; job?: SceneJobView; error?: string }> =>
    ipcRenderer.invoke('dhvw:sceneJobRetry', id),
  sceneDelete: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dhvw:sceneDelete', id),
  saves: (): Promise<{ ok: boolean; saves: SaveView[]; error?: string }> => ipcRenderer.invoke('dhvw:saves'),
  saveBackup: (): Promise<{ ok: boolean; requested?: number; error?: string }> =>
    ipcRenderer.invoke('dhvw:save-backup'),
  saveRestore: (id: string): Promise<{ ok: boolean; sent?: number; error?: string }> =>
    ipcRenderer.invoke('dhvw:save-restore', id),
  setBoost: (
    enabled: boolean,
    gateways?: Partial<{ qq: boolean; feishu: boolean }>,
  ): Promise<{ ok: boolean; settings?: SettingsView }> => ipcRenderer.invoke('dhvw:setBoost', enabled, gateways),
  setBoostGateways: (
    gateways: Partial<{ qq: boolean; feishu: boolean }>,
  ): Promise<{ ok: boolean; settings?: SettingsView }> => ipcRenderer.invoke('dhvw:setBoostGateways', gateways),
  copyText: (text: string): Promise<boolean> => ipcRenderer.invoke('dhvw:copyText', text),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('dhvw:openExternal', url),
  qqBotStatus: (): Promise<QqBotStatusView> => ipcRenderer.invoke('dhvw:qqBotStatus'),
  qqBotSave: (patch: {
    appId?: string
    clientSecret?: string
    sandbox?: boolean
    proactive?: boolean
    stickerEagerness?: number
    activateBoost?: boolean
  }): Promise<{ ok: boolean; error?: string; settings?: SettingsView; status?: QqBotStatusView }> =>
    ipcRenderer.invoke('dhvw:qqBotSave', patch),
  qqBotRebind: (): Promise<{ ok: boolean; error?: string; settings?: SettingsView; status?: QqBotStatusView }> =>
    ipcRenderer.invoke('dhvw:qqBotRebind'),
  feishuBotSave: (patch: {
    appId?: string
    appSecret?: string
    proactive?: boolean
    stickerEagerness?: number
    activateBoost?: boolean
  }): Promise<{ ok: boolean; error?: string; settings?: SettingsView; status?: QqBotStatusView }> =>
    ipcRenderer.invoke('dhvw:feishuBotSave', patch),
  feishuBotRebind: (): Promise<{ ok: boolean; error?: string; settings?: SettingsView; status?: QqBotStatusView }> =>
    ipcRenderer.invoke('dhvw:feishuBotRebind'),
  gatewayPair: (): Promise<{ code: string; expiresAt: number } | null> => ipcRenderer.invoke('dhvw:gatewayPair'),
  gatewayBrowserPair: (name?: string): Promise<GatewayPairResult> =>
    ipcRenderer.invoke('dhvw:gatewayBrowserPair', name),
  gatewayScan: (): Promise<ArmDeviceView[]> => ipcRenderer.invoke('dhvw:gatewayScan'),
  gatewayPairArm: (req: { host: string; name?: string }): Promise<GatewayPairResult> =>
    ipcRenderer.invoke('dhvw:gatewayPairArm', req),
  gatewayClosePair: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:gatewayClosePair'),
  gatewayForget: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:gatewayForget'),
  gatewayRestart: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:gatewayRestart'),
  personaImportCard: (filePath?: string): Promise<PersonaCardImportResult> =>
    ipcRenderer.invoke('dhvw:personaImportCard', filePath),
  personaAvatar: (): Promise<{ ok: boolean; avatarDataUrl?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:personaAvatar'),
  personaExportCard: (req: {
    card: CharacterCardData
    format?: 'png' | 'json'
  }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('dhvw:personaExportCard', req),
  personaJobs: (): Promise<{ ok: boolean; jobs: PersonaJobView[]; error?: string }> =>
    ipcRenderer.invoke('dhvw:personaJobs'),
  personaGenerate: (input: PersonaGenerateInput): Promise<{ ok: boolean; job?: PersonaJobView; error?: string }> =>
    ipcRenderer.invoke('dhvw:personaGenerate', input),
  personaStopJob: (jobId: string): Promise<{ ok: boolean; job?: PersonaJobView; error?: string }> =>
    ipcRenderer.invoke('dhvw:personaStopJob', jobId),
  personaRetryJob: (jobId: string): Promise<{ ok: boolean; job?: PersonaJobView; error?: string }> =>
    ipcRenderer.invoke('dhvw:personaRetryJob', jobId),
  personaDeleteJob: (jobId: string): Promise<{ ok: boolean; deleted?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:personaDeleteJob', jobId),
  personaApply: (payload: {
    card?: CharacterCardData | null
    characterName: string
    humanName?: string
    personaPrompt: string
    l0Facts?: Array<{ id?: string; text: string; importance?: number }>
  }): Promise<{ ok: boolean; settings?: SettingsView; factsResult?: Record<string, unknown> | null; error?: string }> =>
    ipcRenderer.invoke('dhvw:personaApply', payload),
  memoryFacts: (tier = '', limit = 120): Promise<{ ok: boolean; facts: MemoryFactView[]; error?: string }> =>
    ipcRenderer.invoke('dhvw:memoryFacts', tier, limit),
  memoryAddFacts: (
    facts: Array<{ id?: string; text: string; tier?: string; importance?: number }>,
  ): Promise<{ ok: boolean; accepted?: string[]; merged?: string[]; rejected?: string[]; pushed?: number; error?: string }> =>
    ipcRenderer.invoke('dhvw:memoryAddFacts', facts),
  memoryDeleteFact: (factId: string): Promise<{ ok: boolean; deleted?: string; pushed?: number; error?: string }> =>
    ipcRenderer.invoke('dhvw:memoryDeleteFact', factId),
  characters: (): Promise<{
    ok: boolean
    activeId: string | null
    characters: CharacterSheetView[]
    error?: string
  }> => ipcRenderer.invoke('dhvw:characters'),
  characterPickImage: (): Promise<{
    ok: boolean
    canceled?: boolean
    filename?: string
    imageBase64?: string
    dataUrl?: string
    error?: string
  }> => ipcRenderer.invoke('dhvw:characterPickImage'),
  characterSamples: (): Promise<{ ok: boolean; samples: CharacterSampleView[] }> =>
    ipcRenderer.invoke('dhvw:characterSamples'),
  characterGenerate: (
    input: CharacterGenerateInput,
  ): Promise<{
    ok: boolean
    character?: CharacterSheetView
    activeId?: string | null
    apply?: { activeId: string; updatedScenes: string[]; syncedDevPaths: string[] } | null
    settings?: SettingsView
    error?: string
  }> => ipcRenderer.invoke('dhvw:characterGenerate', input),
  characterRegenerate: (
    charId: string,
    patch: {
      rowOrder?: string
      frameW?: number
      frameH?: number
      name?: string
      autoFixDir?: boolean
      cleanInnerWhite?: boolean
      manualFlips?: Record<string, boolean[]>
    },
  ): Promise<{ ok: boolean; character?: CharacterSheetView; error?: string }> =>
    ipcRenderer.invoke('dhvw:characterRegenerate', charId, patch),
  characterApply: (
    charId: string,
    opts?: { applyToScenes?: boolean; syncToolchain?: boolean },
  ): Promise<{
    ok: boolean
    activeId?: string | null
    updatedScenes?: string[]
    syncedDevPaths?: string[]
    delivered?: number
    settings?: SettingsView
    error?: string
  }> => ipcRenderer.invoke('dhvw:characterApply', charId, opts),
  characterDelete: (
    charId: string,
  ): Promise<{ ok: boolean; deleted?: string; activeId?: string | null; settings?: SettingsView; error?: string }> =>
    ipcRenderer.invoke('dhvw:characterDelete', charId),
  characterRename: (
    charId: string,
    name: string,
  ): Promise<{ ok: boolean; character?: CharacterSheetView; settings?: SettingsView; error?: string }> =>
    ipcRenderer.invoke('dhvw:characterRename', charId, name),
  characterAssets: (
    charId: string,
  ): Promise<{
    ok: boolean
    meta?: CharacterSheetMetaJson
    sheetDataUrl?: string
    previewDataUrl?: string
    sourceDataUrl?: string
    error?: string
  }> => ipcRenderer.invoke('dhvw:characterAssets', charId),
  saveImageGenKey: (key: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('dhvw:saveImageGenKey', key),
  clearImageGenKey: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:clearImageGenKey'),
  listImageModels: (req?: { baseUrl?: string; apiKey?: string }): Promise<{ ok: boolean; models: string[]; error?: string; url?: string }> =>
    ipcRenderer.invoke('dhvw:listImageModels', req),
  characterRef3dGet: (): Promise<{ ok: boolean; hasRef3d: boolean; dataUrl?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:characterRef3dGet'),
  characterRef3dPick: (): Promise<{
    ok: boolean
    canceled?: boolean
    hasRef3d?: boolean
    dataUrl?: string
    settings?: SettingsView
    error?: string
  }> => ipcRenderer.invoke('dhvw:characterRef3dPick'),
  characterRef3dClear: (): Promise<{ ok: boolean; hasRef3d?: boolean; settings?: SettingsView; error?: string }> =>
    ipcRenderer.invoke('dhvw:characterRef3dClear'),
  imageGenerate: (req: {
    mode?: 'character_4x4' | 'raw' | 'scene_fusion'
    prompt?: string
    refImageBase64?: string
    use3dRef?: boolean
    size?: string
    force?: boolean
  }): Promise<{ ok: boolean; imageBase64?: string; mime?: string; dataUrl?: string; promptUsed?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:imageGenerate', req),
  imageHistory: (): Promise<{ ok: boolean; items?: import('../shared/types').Generated4x4ItemView[]; error?: string }> =>
    ipcRenderer.invoke('dhvw:imageHistory'),
  imageHistoryDelete: (itemId: string): Promise<{ ok: boolean; deleted?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:imageHistoryDelete', itemId),
  characterExport: (req: {
    charId: string
    name?: string
    file: 'sheet.png' | 'sheet.json' | 'preview.png'
  }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
    ipcRenderer.invoke('dhvw:characterExport', req),
  installComponent: (id: string): Promise<ComponentStatus> => ipcRenderer.invoke('dhvw:componentInstall', id),
  openComponentDir: (id: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:openComponentDir', id),
  activateLocalLlm: (): Promise<{
    ok: boolean
    settings?: SettingsView
    baseUrl?: string
    model?: string
    error?: string
  }> => ipcRenderer.invoke('dhvw:activateLocalLlm'),
  switchLlmMode: (
    mode: LlmMode,
  ): Promise<{
    ok: boolean
    settings?: SettingsView
    mode?: LlmMode
    baseUrl?: string
    model?: string
    error?: string
  }> => ipcRenderer.invoke('dhvw:switchLlmMode', mode),
  inspectAudio: (filePath: string, ttsDir?: string): Promise<{ ok: boolean; duration?: number | null; error?: string }> =>
    ipcRenderer.invoke('dhvw:inspectAudio', filePath, ttsDir),
  readRefAudio: (
    filePath: string,
    ttsDir?: string,
  ): Promise<{ ok: boolean; duration?: number | null; mime?: string; audioBase64?: string; canClip?: boolean; error?: string }> =>
    ipcRenderer.invoke('dhvw:readRefAudio', filePath, ttsDir),
  clipRefAudio: (
    filePath: string,
    seconds?: number,
    ttsDir?: string,
  ): Promise<{ ok: boolean; path?: string; duration?: number; mime?: string; audioBase64?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:clipRefAudio', filePath, seconds, ttsDir),
  testTts: (req: {
    refAudioPath: string
    refText: string
    refLang: string
    textLang: string
    sampleText?: string
  }): Promise<{
    ok: boolean
    duration?: number | null
    bytes?: number
    audioBase64?: string
    canClip?: boolean
    error?: string
  }> => ipcRenderer.invoke('dhvw:testTts', req),
  onComponentProgress: (cb: (p: ComponentProgress) => void): (() => void) => {
    const h = (_e: unknown, p: ComponentProgress): void => cb(p)
    ipcRenderer.on('dhvw:componentProgress', h)
    return () => ipcRenderer.removeListener('dhvw:componentProgress', h)
  },
  onSnapshot: (cb: (s: AppSnapshot) => void): (() => void) => {
    const h = (_e: unknown, s: AppSnapshot): void => cb(s)
    ipcRenderer.on('dhvw:snapshot', h)
    return () => ipcRenderer.removeListener('dhvw:snapshot', h)
  },
  onEvent: (cb: (evt: HostEvent) => void): (() => void) => {
    const h = (_e: unknown, evt: HostEvent): void => cb(evt)
    ipcRenderer.on('dhvw:event', h)
    return () => ipcRenderer.removeListener('dhvw:event', h)
  },
}

contextBridge.exposeInMainWorld('dhvw', api)

export type DhvwApi = typeof api
