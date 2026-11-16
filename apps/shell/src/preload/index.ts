import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionRequest,
  AppSnapshot,
  ComponentProgress,
  ComponentStatus,
  GatewayStatusView,
  HostEvent,
  LlmProtocol,
  SettingsPatch,
  SceneJobView,
  SceneOutputView,
  Live2dModelView,
  MemoryCurveView,
  MemoryStatsView,
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
  armPreview: (): Promise<{ url: string | null; error?: string }> => ipcRenderer.invoke('dhvw:armPreview'),
  setDisplay: (
    state: 'overview' | 'present',
  ): Promise<{ ok: boolean; delivered?: number; state?: string; error?: string }> =>
    ipcRenderer.invoke('dhvw:setDisplay', state),
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
  setBoost: (enabled: boolean): Promise<{ ok: boolean; settings?: SettingsView }> =>
    ipcRenderer.invoke('dhvw:setBoost', enabled),
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
  gatewayPair: (): Promise<{ code: string; expiresAt: number } | null> => ipcRenderer.invoke('dhvw:gatewayPair'),
  gatewayClosePair: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:gatewayClosePair'),
  gatewayForget: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:gatewayForget'),
  gatewayRestart: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:gatewayRestart'),
  installComponent: (id: string): Promise<ComponentStatus> => ipcRenderer.invoke('dhvw:componentInstall', id),
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
