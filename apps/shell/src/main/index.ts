import { app, BrowserWindow, dialog, ipcMain, Menu, shell as electronShell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, logDir, rendererIndex, resourcesRoot } from './paths'
import { log } from './logger'
import { loadConfig, saveConfig, type ShellConfig } from './config'
import { allocatePorts } from './ports'
import { HostSupervisor } from './host'
import type { ActionRequest, AppSnapshot, ServiceDef } from '../shared/types'
import { createTray } from './tray'
import { applyNetworkHardening, hardenSessionSetup } from './hardening'
import { probeLlm } from './network'

applyNetworkHardening()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let win: BrowserWindow | null = null
let supervisor: HostSupervisor | null = null
let config: ShellConfig = loadConfig()
let quitting = false

const SERVICE_CATALOG: Array<Omit<ServiceDef, 'port'>> = [
  { id: 'olvt', name: 'OLVT 后端', module: 'dhvw_worker', args: ['--name', 'olvt'], healthPath: '/health' },
  { id: 'tts', name: '语音合成', module: 'dhvw_worker', args: ['--name', 'tts'], healthPath: '/health' },
  { id: 'waketrace', name: '唤醒词', module: 'dhvw_worker', args: ['--name', 'waketrace'], healthPath: '/health' },
  { id: 'orchestrator', name: '编排器', module: 'dhvw_worker', args: ['--name', 'orchestrator'] },
]

/** 随包内置的 CPython（scripts/fetch-runtime.mjs 产出）；不存在则退回系统 Python。 */
function bundledPython(): string {
  const candidates = [
    path.join(resourcesRoot(), 'runtime', 'python.exe'),
    path.join(app.getAppPath(), 'runtime', 'python.exe'),
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? ''
}

function resolvePython(): string {
  const candidates = [config.pythonPath, bundledPython(), process.env.DHVW_PYTHON ?? '', 'python']
  for (const c of candidates) {
    if (!c) continue
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c
      continue
    }
    return c
  }
  return 'python'
}

function snapshot(): AppSnapshot {
  return {
    hostPid: supervisor?.pid ?? null,
    hostReady: supervisor?.ready ?? false,
    workers: supervisor?.snapshots ?? [],
    dataDir,
    logDir,
    autoLaunch: config.autoLaunch,
    pythonPath: resolvePython(),
    llm: config.llm,
  }
}

function broadcast(): void {
  if (win && !win.isDestroyed()) win.webContents.send('dhvw:snapshot', snapshot())
}

function showWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function createWindow(): void {
  win = new BrowserWindow({
    width: config.window.width,
    height: config.window.height,
    show: true,
    backgroundColor: '#12151c',
    title: 'DHVW 主机端',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault()
  })
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win?.hide()
  })
  win.on('closed', () => {
    win = null
  })
  win.loadFile(rendererIndex())
}

function registerIpc(): void {
  ipcMain.handle('dhvw:snapshot', () => snapshot())
  ipcMain.handle('dhvw:action', (_e, req: ActionRequest) => {
    if (!supervisor) return { ok: false, error: '宿主未启动' }
    const ok = supervisor.send({ cmd: req.action, service: req.id })
    log('info', 'ipc', '服务操作', { ...req, ok })
    return { ok }
  })
  ipcMain.handle('dhvw:tailLog', (_e, req: { id: string; lines?: number }) => {
    const file = path.join(logDir, req.id === 'host' ? 'host.log' : `${req.id}.log`)
    try {
      const text = fs.readFileSync(file, 'utf8')
      const lines = text.split(/\r?\n/)
      return lines.slice(-(req.lines ?? 80)).join('\n')
    } catch {
      return `（暂无日志：${file}）`
    }
  })
  ipcMain.handle('dhvw:setAutoLaunch', (_e, enabled: boolean) => {
    config = { ...config, autoLaunch: enabled }
    saveConfig(config)
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath })
    log('info', 'config', '自启设置更新', { enabled })
    return { ok: true }
  })
  ipcMain.handle('dhvw:openDataDir', () => electronShell.openPath(dataDir))
  ipcMain.handle('dhvw:probe', async () => {
    const result = await probeLlm(config.llm.baseUrl)
    log(result.ok ? 'info' : 'warn', 'network', 'LLM 端点探测', { ...result })
    return result
  })
  ipcMain.handle('dhvw:restartHost', async () => {
    if (!supervisor) return { ok: false }
    await supervisor.stop('manual-restart')
    supervisor.start()
    return { ok: true }
  })
}

async function boot(): Promise<void> {
  Menu.setApplicationMenu(null)
  hardenSessionSetup()
  log('info', 'app', '外壳启动', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    resources: resourcesRoot(),
  })

  const ports = await allocatePorts(SERVICE_CATALOG.length)
  const services: ServiceDef[] = SERVICE_CATALOG.map((svc, i) => {
    const override = config.sidecars[svc.id]
    return { ...svc, ...(override ?? {}), port: ports[i] ?? 0 }
  })
  const real = services.filter((s) => s.command).map((s) => s.id)
  if (real.length) log('info', 'sidecar', '使用真实 sidecar', { services: real })
  log('info', 'ports', '端口分配完成', { ports })

  supervisor = new HostSupervisor({ pythonPath: resolvePython(), shellPid: process.pid, services })
  supervisor.on('event', (evt) => {
    if (win && !win.isDestroyed()) win.webContents.send('dhvw:event', evt)
  })
  supervisor.on('state', broadcast)
  supervisor.start()

  createWindow()
  createTray({
    onShow: showWindow,
    onQuit: () => app.quit(),
    onRestartHost: () => {
      void supervisor?.stop('tray-restart').then(() => supervisor?.start())
    },
  })
  registerIpc()

  app.on('second-instance', showWindow)
  app.on('before-quit', async (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    log('info', 'app', '外壳退出，等待宿主回收子进程')
    await supervisor?.stop('app-quit')
    app.exit(0)
  })
}

app.whenReady().then(boot).catch((err) => {
  log('error', 'app', '启动失败', { error: String(err) })
  dialog.showErrorBox('DHVW 启动失败', String(err))
  app.exit(1)
})
