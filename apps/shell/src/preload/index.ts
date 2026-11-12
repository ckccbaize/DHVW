import { contextBridge, ipcRenderer } from 'electron'
import type {
  ActionRequest,
  AppSnapshot,
  ComponentProgress,
  ComponentStatus,
  HostEvent,
  LlmProtocol,
  SettingsPatch,
  SettingsView,
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
