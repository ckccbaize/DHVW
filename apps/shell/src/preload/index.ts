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
