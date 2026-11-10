import { contextBridge, ipcRenderer } from 'electron'
import type { ActionRequest, AppSnapshot, HostEvent } from '../shared/types'

const api = {
  snapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke('dhvw:snapshot'),
  action: (req: ActionRequest): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('dhvw:action', req),
  tailLog: (id: string, lines = 80): Promise<string> => ipcRenderer.invoke('dhvw:tailLog', { id, lines }),
  setAutoLaunch: (enabled: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:setAutoLaunch', enabled),
  openDataDir: (): Promise<string> => ipcRenderer.invoke('dhvw:openDataDir'),
  restartHost: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('dhvw:restartHost'),
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
