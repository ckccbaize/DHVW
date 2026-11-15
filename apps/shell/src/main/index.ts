import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell as electronShell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, logDir, rendererIndex, resourcesRoot, runtimeDir } from './paths'
import { log } from './logger'
import { loadConfig, saveConfig, type ShellConfig } from './config'
import { allocatePorts, isPortFree } from './ports'
import { HostSupervisor } from './host'
import { startLive2dServer, stopLive2dServer } from './live2d'
import {
  findModel,
  listModels as listLive2dModels,
  modelUrlPath,
  type Live2dModelRef,
} from './live2d-models'
import { resolveArmWwwDir, startArmPreviewServer, stopArmPreviewServer } from './arm-preview'
import type {
  ActionRequest,
  AppSnapshot,
  ServiceDef,
  SettingsPatch,
  SceneJobView,
  SceneOutputView,
  SceneRequestView,
  SaveView,
  SettingsView,
  StatsView,
  WorkTier,
  WorldView,
} from '../shared/types'
import { createTray } from './tray'
import { applyNetworkHardening, hardenSessionSetup } from './hardening'
import { listModels, probeLlm } from './network'
import { COMPONENTS, componentStatus, ensureComponent, resolveSpec } from './components'
import { clearApiKey, hasApiKey, readApiKey, saveApiKey } from './secret'
import { asrModelPaths, prepareOlvt, resolveOlvtDir, syncOlvtModel } from './olvt'
import { Gateway, type GatewayTarget } from './gateway'

applyNetworkHardening()

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

let win: BrowserWindow | null = null
let supervisor: HostSupervisor | null = null
let gateway: Gateway | null = null
let gatewayTargets: GatewayTarget[] = []
let config: ShellConfig = loadConfig()
let quitting = false

/** 编排器端口（0 = 还没分配）；设备通道与配置下发都靠它 */
let orchestratorPort = 0
let olvtServicePort = 0
let refreshTimer: NodeJS.Timeout | null = null

/**
 * 把外壳侧的事实推给编排器：TTS 是否就绪（决定 present:grant/deny）、LLM 端点与密钥
 * （编成 llm:config 下发给设备）。走回环 HTTP，不进设备通道，避免自己给自己发消息。
 */
async function pushOrchestratorConfig(): Promise<boolean> {
  if (!orchestratorPort) return false
  const tts = supervisor?.snapshots.find((s) => s.id === 'tts')?.healthy === true
  const body = {
    tts,
    live2d: true,
    olvtPort: olvtServicePort,
    gatewayPort: config.gateway.enabled ? config.gateway.port : 0,
    boost: config.boost.enabled,
    autoPushScene: config.scene.autoPush,
    llm: {
      baseUrl: config.llm.baseUrl,
      model: config.llm.model || undefined,
      apiKey: readApiKey() || undefined,
    },
  }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    log('info', 'orchestrator', '已下发编排器配置', { tts, model: config.llm.model || '-' })
    return true
  } catch (err) {
    return false
  }
}

/**
 * 世界状态快照：编排器是唯一数据源，界面只做只读展示。
 * 编排器没起来不是错误——返回 reachable:false，界面显示「未运行」。
 */
async function readWorld(): Promise<WorldView> {
  const empty: WorldView = {
    reachable: false,
    device: { connected: false, id: null, tier: 'idle' },
    memory: 0,
    digest: null,
    mood: null,
  }
  if (!orchestratorPort) return empty
  const get = async (p: string): Promise<Record<string, unknown>> => {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}${p}`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  }
  try {
    const health = await get('/health')
    const [digestRaw, moodRaw] = await Promise.all([
      get('/dhvw/digest').catch(() => ({}) as Record<string, unknown>),
      get('/dhvw/mood').catch(() => ({}) as Record<string, unknown>),
    ])
    const device = (health.device ?? {}) as Record<string, unknown>
    const clock = (digestRaw.clock ?? {}) as Record<string, unknown>
    const agenda = Array.isArray(digestRaw.agenda) ? (digestRaw.agenda as Array<Record<string, unknown>>) : []
    const scenes = Array.isArray(digestRaw.sceneRequests)
      ? (digestRaw.sceneRequests as Array<Record<string, unknown>>)
      : []
    const dims = (moodRaw.dims ?? {}) as Record<string, unknown>
    const hasDigest = Object.keys(digestRaw).length > 0
    const hasMood = Object.keys(moodRaw).length > 0
    return {
      reachable: true,
      device: {
        connected: Boolean(device.connected),
        id: typeof device.id === 'string' ? device.id : null,
        tier: (device.tier === 'host' || device.tier === 'edge' ? device.tier : 'idle') as WorkTier,
      },
      memory: Number(health.memory ?? 0),
      digest: hasDigest
        ? {
            ts: Number(digestRaw.ts ?? 0),
            seq: Number(digestRaw.seq ?? 0),
            day: String(clock.day ?? ''),
            minute: Number(clock.minute ?? 0),
            phase: String(clock.phase ?? ''),
            weekdayName: String(clock.weekdayName ?? ''),
            date: String(clock.date ?? ''),
            display: String((digestRaw.world as Record<string, unknown> | undefined)?.display ?? ''),
            agendaDone: agenda.filter((a) => a.status === 'done').length,
            agendaTotal: agenda.length,
            scenesPending: scenes.filter((s) => s.status === 'pending').length,
            pcActions: Array.isArray(digestRaw.pcActions) ? digestRaw.pcActions.length : 0,
          }
        : null,
      mood: hasMood
        ? {
            band: String(moodRaw.band ?? ''),
            dims: Object.entries(dims).map(([key, value]) => ({ key, value: Number(value) })),
          }
        : null,
    }
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 状态机统计表：数据源只有编排器，拿不到就如实显示不可达 */
async function readStats(): Promise<StatsView> {
  const empty: StatsView = {
    reachable: false,
    device: { connected: false, id: null, tier: 'idle', lastSeenS: null },
    digest: null,
    tierTransitions: {},
    events24h: {},
    memory: 0,
    uptime: 0,
  }
  if (!orchestratorPort) return empty
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/stats`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = (await res.json()) as Record<string, any>
    const device = raw.device ?? {}
    const digest = raw.digest ?? null
    return {
      reachable: true,
      device: {
        connected: Boolean(device.connected),
        id: typeof device.id === 'string' ? device.id : null,
        tier: (device.tier === 'host' || device.tier === 'edge' ? device.tier : 'idle') as WorkTier,
        lastSeenS: typeof device.last_seen_s === 'number' ? device.last_seen_s : null,
      },
      digest: digest
        ? {
            seq: Number(digest.seq ?? 0),
            ageS: typeof digest.age_s === 'number' ? digest.age_s : null,
            day: String(digest.clock?.day ?? ''),
            minute: Number(digest.clock?.minute ?? 0),
            phase: String(digest.clock?.phase ?? ''),
            weekdayName: String(digest.clock?.weekdayName ?? ''),
            date: String(digest.clock?.date ?? ''),
            agenda: (digest.agenda ?? {}) as Record<string, number>,
            sceneRequests: (digest.scene_requests ?? {}) as Record<string, number>,
            pcActions: (digest.pc_actions ?? {}) as Record<string, number>,
            behaviors: Number(digest.behaviors ?? 0),
            eventPool: Number(digest.event_pool ?? 0),
          }
        : null,
      tierTransitions: (raw.tier_transitions ?? {}) as Record<string, number>,
      events24h: (raw.events_24h ?? {}) as Record<string, number>,
      memory: Number(raw.memory ?? 0),
      uptime: Number(raw.uptime ?? 0),
    }
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 设备显示态二切：只发指令，成不生效看设备回传的 digest.world.display */
async function setDisplay(
  state: 'overview' | 'present',
): Promise<{ ok: boolean; delivered?: number; state?: string; error?: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/display`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state }),
      signal: AbortSignal.timeout(3000),
    })
    const raw = (await res.json()) as { ok?: boolean; delivered?: number; state?: string; error?: string }
    return { ok: Boolean(raw.ok), delivered: raw.delivered, state: raw.state, error: raw.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 场景任务列表：编排器不可达时返回空表并带上原因 */
async function readScenes(): Promise<{
  reachable: boolean
  jobs: SceneJobView[]
  requests: SceneRequestView[]
  outputs: SceneOutputView[]
  autoPush?: boolean
  error?: string
}> {
  if (!orchestratorPort) return { reachable: false, jobs: [], requests: [], outputs: [] }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/scenes`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = (await res.json()) as {
      jobs?: SceneJobView[]
      requests?: SceneRequestView[]
      outputs?: SceneOutputView[]
      autoPush?: boolean
    }
    return {
      reachable: true,
      jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
      requests: Array.isArray(raw.requests) ? raw.requests : [],
      outputs: Array.isArray(raw.outputs) ? raw.outputs : [],
      autoPush: raw.autoPush === true,
    }
  } catch (err) {
    return { reachable: false, jobs: [], requests: [], outputs: [], error: err instanceof Error ? err.message : String(err) }
  }
}

/** 手动把一条产出推给设备；核验失败/设备离线都原样带原因回来 */
async function pushScene(id: string): Promise<{
  ok: boolean
  job?: string
  state?: string
  sent?: number
  error?: string
}> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/scenes/${encodeURIComponent(id)}/push`, {
      method: 'POST',
      // 核验要读整个产出包（含 sha256），给足时间
      signal: AbortSignal.timeout(20_000),
    })
    return (await res.json()) as { ok: boolean; job?: string; state?: string; sent?: number; error?: string }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 重提一条设备场景请求（失败后手动重试，避免坏 spec 自动反复烧 token） */
async function listSaves(): Promise<{ ok: boolean; saves: SaveView[]; error?: string }> {
  if (!orchestratorPort) return { ok: false, saves: [], error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/saves`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = (await res.json()) as { saves?: SaveView[] }
    return { ok: true, saves: raw.saves ?? [] }
  } catch (err) {
    return { ok: false, saves: [], error: err instanceof Error ? err.message : String(err) }
  }
}

async function backupSave(): Promise<{ ok: boolean; requested?: number; error?: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/saves/backup`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    })
    const raw = (await res.json()) as { ok?: boolean; requested?: number; error?: string }
    return { ok: raw.ok === true, requested: raw.requested, error: raw.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function restoreSave(id: string): Promise<{ ok: boolean; sent?: number; error?: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/saves/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    })
    const raw = (await res.json()) as { ok?: boolean; sent?: number; error?: string }
    return { ok: raw.ok === true, sent: raw.sent, error: raw.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function retryScene(id: string): Promise<{ ok: boolean; job?: string; error?: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/scene/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(3000),
    })
    return (await res.json()) as { ok: boolean; job?: string; error?: string }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 续画/重试失败或超时的场景任务 */
async function retrySceneJob(id: string): Promise<{ ok: boolean; job?: SceneJobView; error?: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/scene/job-retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(3000),
    })
    return (await res.json()) as { ok: boolean; job?: SceneJobView; error?: string }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 删除已产出的地图目录及任务记录 */
async function deleteSceneOutput(id: string): Promise<{ ok: boolean; error?: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/scenes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000),
    })
    const text = await res.text()
    try {
      return JSON.parse(text) as { ok: boolean; error?: string }
    } catch {
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 120)}` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 提交一次地图生成（走编排器的场景任务，agent 由编排器拉起） */
async function requestScene(spec: Record<string, unknown>): Promise<{ ok: boolean; job?: SceneJobView; error?: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/scene`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(5000),
    })
    const raw = (await res.json()) as { ok?: boolean; job?: SceneJobView; error?: string }
    if (!res.ok || !raw.ok) return { ok: false, error: raw.error ?? `HTTP ${res.status}` }
    return { ok: true, job: raw.job }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 编排器起步比外壳晚，启动阶段按 1 s 间隔重试，成功后不再打扰 */
async function pushOrchestratorConfigUntilReady(tries = 30): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await pushOrchestratorConfig()) return
    await new Promise((r) => setTimeout(r, 1000))
  }
  log('warn', 'orchestrator', '编排器未就绪，配置未下发')
}

const SERVICE_CATALOG: Array<Omit<ServiceDef, 'port'>> = [
  { id: 'olvt', name: 'OLVT 后端', module: 'dhvw_worker', args: ['--name', 'olvt'], healthPath: '/health' },
  { id: 'tts', name: '语音合成', module: 'dhvw_worker', args: ['--name', 'tts'], healthPath: '/health' },
  { id: 'waketrace', name: '唤醒词', module: 'dhvw_worker', args: ['--name', 'waketrace'], healthPath: '/health' },
  { id: 'orchestrator', name: '编排器', module: 'dhvw_orchestrator', args: [], healthPath: '/health' },
]

/** 随包内置的 CPython（scripts/fetch-runtime.mjs 产出）；不存在则退回系统 Python。 */
function bundledPython(): string {
  const candidates = [path.join(runtimeDir(), 'python.exe')]
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

const PROTOCOLS = ['openai-compatible', 'anthropic'] as const

function settingsView(): SettingsView {
  return {
    boost: { ...config.boost },
    llm: { ...config.llm, hasKey: hasApiKey() },
    ports: { ...config.ports },
    asr: { ...config.asr, ready: Boolean(asrModelPaths(config.asr.enabled).modelPath) },
    live2d: { model: live2dModel?.id ?? config.live2d.model },
    scene: { ...config.scene },
    olvt: { ...config.olvt },
    tts: { ...config.tts },
    gateway: { ...config.gateway },
  }
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
  // 面板数量随版本增长（服务/事件/组件/设备接入），默认尺寸取屏幕可用区域，但不小于原设定
  const area = screen.getPrimaryDisplay().workAreaSize
  win = new BrowserWindow({
    width: Math.min(Math.max(config.window.width, 960), area.width),
    height: Math.min(Math.max(config.window.height, 720), area.height),
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
  ipcMain.handle('dhvw:live2d', () => {
    // 每次调用都按当前模型拼地址：设置里换了模型，渲染进程重新取一次就能换 iframe
    const url =
      live2dUrl && live2dModel ? `${live2dUrl}?model=${encodeURIComponent(modelUrlPath(live2dModel))}` : live2dUrl
    return {
      url,
      model: live2dModel?.id ?? null,
      error: live2dUrl ? (live2dModel ? undefined : '模型库里没有可用模型') : '角色资源缺失（resources/live2d）',
    }
  })
  ipcMain.handle('dhvw:live2dModels', () => ({
    current: live2dModel?.id ?? null,
    models: listLive2dModels(live2dRoots).map((m) => ({ id: m.id, source: m.source, file: m.file })),
  }))
  ipcMain.handle('dhvw:armPreview', () => ({
    url: armPreviewUrl,
    error: armPreviewUrl ? undefined : 'ARM 预览资源缺失（arm/www/preview.html）',
  }))
  ipcMain.handle('dhvw:saves', () => listSaves())
  ipcMain.handle('dhvw:save-backup', () => backupSave())
  ipcMain.handle('dhvw:save-restore', (_e, id: string) => restoreSave(id))
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
  ipcMain.handle('dhvw:settings', () => settingsView())
  ipcMain.handle('dhvw:gateway', () => gateway?.status ?? null)
  ipcMain.handle('dhvw:gatewayPair', () => gateway?.openPairing() ?? null)
  ipcMain.handle('dhvw:gatewayClosePair', () => {
    gateway?.closePairing()
    return { ok: true }
  })
  ipcMain.handle('dhvw:gatewayForget', () => {
    gateway?.forgetDevices()
    return { ok: true }
  })
  ipcMain.handle('dhvw:world', () => readWorld())
  ipcMain.handle('dhvw:stats', () => readStats())
  ipcMain.handle('dhvw:setDisplay', (_e, state: 'overview' | 'present') => setDisplay(state))
  ipcMain.handle('dhvw:scenes', () => readScenes())
  ipcMain.handle('dhvw:sceneGenerate', (_e, spec: Record<string, unknown>) => requestScene(spec))
  ipcMain.handle('dhvw:sceneRetry', (_e, id: string) => retryScene(id))
  ipcMain.handle('dhvw:scenePush', (_e, id: string) => pushScene(id))
  ipcMain.handle('dhvw:sceneJobRetry', (_e, id: string) => retrySceneJob(id))
  ipcMain.handle('dhvw:sceneDelete', (_e, id: string) => deleteSceneOutput(id))
  ipcMain.handle('dhvw:setBoost', (_e, enabled: boolean) => {
    config = { ...config, boost: { enabled: Boolean(enabled) } }
    saveConfig(config)
    log('info', 'settings', '世界模式增强开关', { enabled: config.boost.enabled })
    void pushOrchestratorConfig()
    return { ok: true, settings: settingsView() }
  })
  ipcMain.handle('dhvw:gatewayRestart', async () => {
    await gateway?.stop()
    gateway?.start()
    return { ok: true }
  })
  ipcMain.handle('dhvw:saveSettings', (_e, patch: SettingsPatch) => {
    const next = loadConfig()
    if (patch.llm?.baseUrl !== undefined) {
      if (!/^https?:\/\/[^\s]+$/.test(patch.llm.baseUrl)) return { ok: false, error: '端点必须是 http(s) URL' }
      next.llm.baseUrl = patch.llm.baseUrl.trim()
    }
    if (patch.llm?.model !== undefined) {
      const model = String(patch.llm.model).trim()
      if (!model) return { ok: false, error: '模型不能为空（可先拉取模型列表）' }
      next.llm.model = model
    }
    if (patch.llm?.protocol !== undefined) {
      if (!PROTOCOLS.includes(patch.llm.protocol)) return { ok: false, error: '不支持的协议' }
      next.llm.protocol = patch.llm.protocol
    }
    if (patch.llm?.temperature !== undefined) {
      const t = Number(patch.llm.temperature)
      if (!(t >= 0 && t <= 2)) return { ok: false, error: 'temperature 需在 0–2' }
      next.llm.temperature = t
    }
    if (patch.ports) {
      for (const key of ['olvt', 'tts'] as const) {
        const v = patch.ports[key]
        if (v === undefined) continue
        if (!Number.isInteger(v) || v < 0 || v > 65535) return { ok: false, error: '端口需为 0–65535 的整数' }
        next.ports[key] = v
      }
    }
    if (patch.asr?.enabled !== undefined) next.asr.enabled = Boolean(patch.asr.enabled)
    let live2dChanged = false
    if (patch.scene?.autoPush !== undefined) next.scene.autoPush = Boolean(patch.scene.autoPush)
    if (patch.live2d?.model !== undefined) {
      const want = String(patch.live2d.model).trim()
      const ref = findModel(live2dRoots, want)
      if (!ref) return { ok: false, error: `模型库里没有 ${want}（可点「刷新模型列表」）` }
      live2dChanged = ref.id !== live2dModel?.id
      live2dModel = ref
      next.live2d.model = ref.id
    }
    for (const key of ['characterName', 'humanName', 'personaPrompt'] as const) {
      const v = patch.olvt?.[key]
      if (v !== undefined) next.olvt[key] = String(v)
    }
    for (const key of ['backendDir', 'refAudioPath', 'refText', 'refLang', 'textLang'] as const) {
      const v = patch.tts?.[key]
      if (v !== undefined) next.tts[key] = String(v)
    }
    let gatewayChanged = false
    if (patch.gateway?.port !== undefined) {
      const port = Number(patch.gateway.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: '网关端口需为 1–65535 的整数' }
      if (port !== next.gateway.port) gatewayChanged = true
      next.gateway.port = port
    }
    if (patch.gateway?.enabled !== undefined) {
      if (Boolean(patch.gateway.enabled) !== next.gateway.enabled) gatewayChanged = true
      next.gateway.enabled = Boolean(patch.gateway.enabled)
    }
    saveConfig(next)
    config = next
    log('info', 'settings', '设置已保存', {
      llm: next.llm.baseUrl,
      model: next.llm.model,
      live2d: next.live2d.model,
      ports: next.ports,
    })
    if (live2dChanged) applyLive2dModel()
    void pushOrchestratorConfig()
    if (gatewayChanged && gateway) {
      // 端口/开关变化需要重建监听；CA 与设备表不变
      void gateway.stop().then(() => {
        gateway = new Gateway({ port: next.gateway.port, targets: gatewayTargets })
        if (next.gateway.enabled) gateway.start()
      })
    }
    return { ok: true, settings: settingsView() }
  })
  ipcMain.handle(
    'dhvw:listModels',
    (_e, req?: { baseUrl?: string; protocol?: 'openai-compatible' | 'anthropic'; apiKey?: string }) =>
      listModels({
        baseUrl: req?.baseUrl ?? config.llm.baseUrl,
        protocol: req?.protocol ?? config.llm.protocol,
        // 允许用界面上刚输入但尚未保存的密钥试拉取
        apiKey: req?.apiKey?.trim() || readApiKey(),
      }),
  )
  ipcMain.handle('dhvw:saveApiKey', (_e, key: string) => {
    saveApiKey(String(key ?? ''))
    void pushOrchestratorConfig()
    return { ok: true }
  })
  ipcMain.handle('dhvw:clearApiKey', () => {
    clearApiKey()
    return { ok: true }
  })
  ipcMain.handle('dhvw:components', () =>
    COMPONENTS.map((c) => componentStatus(resolveSpec(c, config.componentUrls[c.id]))),
  )
  ipcMain.handle('dhvw:componentInstall', async (_e, id: string) => {
    const base = COMPONENTS.find((c) => c.id === id)
    if (!base) return { id, name: id, version: '-', state: 'failed', error: '未知组件' }
    const spec = resolveSpec(base, config.componentUrls[id])
    log('info', 'component', '开始下载组件', { id: spec.id, version: spec.version, urls: spec.urls.length })
    const status = await ensureComponent(
      spec,
      (pct) => {
        if (win && !win.isDestroyed()) win.webContents.send('dhvw:componentProgress', { id: spec.id, progress: pct })
      },
      config.pipIndex,
    )
    log(status.state === 'ready' ? 'info' : 'error', 'component', status.state === 'ready' ? '组件就绪' : '组件下载失败', {
      id: spec.id,
      error: status.error,
    })
    return status
  })
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

/** 换模型后：模型文件与 model_dict 同步进 OLVT，再重启 OLVT（conf 只在启动时读一次） */
function applyLive2dModel(): void {
  const dir = resolveOlvtDir(config.sidecars.olvt?.cwd || config.olvt.dir)
  const snapshots = supervisor?.snapshots ?? []
  const olvt = snapshots.find((w) => w.id === 'olvt')
  const tts = snapshots.find((w) => w.id === 'tts')
  log('info', 'live2d', '角色模型切换', { model: live2dModel?.id, olvtDir: dir || undefined })
  if (!dir) {
    log('warn', 'live2d', 'OLVT 目录未就绪，模型只在本机舞台生效')
    return
  }
  if (live2dModel) syncOlvtModel(dir, live2dModel)
  if (!olvt?.port) {
    log('warn', 'live2d', 'OLVT 未运行，下次启动时使用新模型')
    return
  }
  prepareOlvt({
    dir,
    port: olvt.port,
    live2dModel: live2dModel?.id ?? config.live2d.model,
    characterName: config.olvt.characterName,
    humanName: config.olvt.humanName,
    personaPrompt: config.olvt.personaPrompt,
    llm: { ...config.llm, apiKey: readApiKey() ?? 'missing-api-key' },
    tts: { apiUrl: `http://127.0.0.1:${tts?.port ?? 0}/tts`, ...config.tts },
    asr: { enabled: config.asr.enabled, ...asrModelPaths(config.asr.enabled) },
  })
  supervisor?.send({ cmd: 'restart', service: 'olvt' })
}

let live2dUrl: string | null = null
let armPreviewUrl: string | null = null
/** 模型库根：随包资源优先，其次 OLVT 组件的 live2d-models（两者目录结构一致） */
let live2dRoots: Array<{ root: string; source: Live2dModelRef['source'] }> = []
let live2dModel: Live2dModelRef | null = null

async function boot(): Promise<void> {
  Menu.setApplicationMenu(null)
  hardenSessionSetup()
  log('info', 'app', '外壳启动', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    resources: resourcesRoot(),
  })

  const live2dRoot = path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'live2d')
  const olvtRootDir = resolveOlvtDir(config.sidecars.olvt?.cwd || config.olvt.dir)
  live2dRoots = [
    { root: path.join(live2dRoot, 'models'), source: 'bundled' as const },
    ...(olvtRootDir ? [{ root: path.join(olvtRootDir, 'live2d-models'), source: 'olvt' as const }] : []),
  ]
  live2dModel = findModel(live2dRoots, config.live2d.model) ?? findModel(live2dRoots, 'mao_pro')
  if (!live2dModel) {
    log('warn', 'live2d', '模型库里没有可用模型', {
      want: config.live2d.model,
      roots: live2dRoots.map((r) => r.root),
    })
  }
  live2dUrl = await startLive2dServer(live2dRoot, (id) => findModel(live2dRoots, id)).catch((err) => {
    log('warn', 'live2d', '角色舞台服务启动失败', { error: String(err) })
    return null
  })
  log(live2dUrl ? 'info' : 'warn', 'live2d', live2dUrl ? '角色舞台就绪' : '角色资源缺失', {
    url: live2dUrl ?? undefined,
    root: live2dRoot,
    model: live2dModel?.id,
    models: listLive2dModels(live2dRoots).map((m) => m.id),
  })

  const armWww = resolveArmWwwDir([
    process.env.DHVW_ARM_WWW ?? '',
    path.join(process.resourcesPath, 'arm-www'),
    path.resolve(app.getAppPath(), '..', '..', '..', 'arm', 'www'),
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'arm', 'www'),
    path.resolve(process.cwd(), 'arm', 'www'),
    path.resolve(process.cwd(), '..', '..', 'arm', 'www'),
  ])
  if (armWww) {
    armPreviewUrl = await startArmPreviewServer(armWww, () => orchestratorPort).catch((err) => {
      log('warn', 'arm-preview', 'ARM 预览服务启动失败', { error: String(err) })
      return null
    })
  }
  log(armPreviewUrl ? 'info' : 'warn', 'arm-preview', armPreviewUrl ? 'ARM 预览服务就绪' : 'ARM 预览资源缺失', {
    url: armPreviewUrl ?? undefined,
    root: armWww ?? undefined,
  })

  const dynamic = await allocatePorts(SERVICE_CATALOG.length)
  const fixed: Record<string, number> = {
    olvt: config.ports.olvt,
    tts: config.ports.tts,
    orchestrator: config.ports.orchestrator,
  }
  const ports = await Promise.all(
    SERVICE_CATALOG.map(async (svc, i) => {
      const want = fixed[svc.id] ?? 0
      return want > 0 && (await isPortFree(want)) ? want : (dynamic[i] ?? 0)
    }),
  )
  const portOf = (id: string): number => ports[SERVICE_CATALOG.findIndex((s) => s.id === id)] ?? 0
  const olvtDir = olvtRootDir
  const olvtPort = portOf('olvt')
  olvtServicePort = olvtPort
  if (olvtDir) {
    if (live2dModel) syncOlvtModel(olvtDir, live2dModel)
    const asr = asrModelPaths(config.asr.enabled)
    if (config.asr.enabled && !asr.modelPath) {
      log('warn', 'olvt', 'ASR 已启用但 SenseVoice 模型未下载，语音输入不可用', { component: 'asr-sensevoice' })
    }
    prepareOlvt({
      dir: olvtDir,
      port: olvtPort,
      live2dModel: live2dModel?.id ?? config.live2d.model,
      characterName: config.olvt.characterName,
      humanName: config.olvt.humanName,
      personaPrompt: config.olvt.personaPrompt,
      llm: { ...config.llm, apiKey: readApiKey() ?? 'missing-api-key' },
      tts: { apiUrl: `http://127.0.0.1:${portOf('tts')}/tts`, ...config.tts },
      asr: { enabled: config.asr.enabled, ...asr },
    })
  } else {
    log('warn', 'olvt', '未找到 OLVT 后端目录，使用占位 worker', {
      component: 'olvt',
      hint: '在组件面板下载 OLVT，或在设置里指定已有目录',
    })
  }
  // GPT-SoVITS：目录来自设置（或 sidecars.tts 覆盖），入口固定 api_v2.py
  const ttsOverride = config.sidecars.tts
  const ttsDir = (ttsOverride?.cwd || config.tts.backendDir || '').trim()
  const ttsPython = ttsDir ? path.join(ttsDir, 'runtime', 'python.exe') : ''
  if (ttsDir && !fs.existsSync(ttsDir)) {
    log('warn', 'tts', '设置的语音合成目录不存在', { dir: ttsDir })
  }
  const services: ServiceDef[] = SERVICE_CATALOG.map((svc, i) => {
    const override = config.sidecars[svc.id]
    const port = ports[i] ?? 0
    if (svc.id === 'tts' && ttsDir) {
      return {
        ...svc,
        command: override?.command ?? [
          fs.existsSync(ttsPython) ? ttsPython : resolvePython(),
          'api_v2.py',
          '-a',
          '127.0.0.1',
          '-p',
          '{port}',
        ],
        cwd: ttsDir,
        env: { ...override?.env },
        healthMode: 'tcp',
        healthPath: undefined,
        // 模型加载 12–60 s，超时告警后继续探测
        healthTimeout: 180,
        port,
      }
    }
    if (svc.id === 'olvt' && olvtDir) {
      return {
        ...svc,
        command: override?.command ?? [resolvePython(), 'run_server.py'],
        cwd: olvtDir,
        env: {
          ...override?.env,
          PYTHONUNBUFFERED: '1',
          // 思考模型默认带 reasoning_content，首字多 1–2 s 且内容无法出声
          OLVT_LLM_EXTRA_BODY: '{"reasoning_effort":"none"}',
          DHVW_ORCHESTRATOR_URL: `http://127.0.0.1:${portOf('orchestrator')}`,
        },
        healthMode: 'tcp',
        healthPath: undefined,
        healthTimeout: 180,
        port,
      }
    }
    return { ...svc, ...(override ?? {}), port }
  })
  const real = services.filter((s) => s.command).map((s) => s.id)
  if (real.length) log('info', 'sidecar', '使用真实 sidecar', { services: real })
  log('info', 'ports', '端口分配完成', { ports })

  supervisor = new HostSupervisor({ pythonPath: resolvePython(), shellPid: process.pid, services })
  supervisor.on('event', (evt) => {
    if (win && !win.isDestroyed()) win.webContents.send('dhvw:event', evt)
    // TTS 起来之后 present:grant 才有依据，健康变化就重推一次
    if (evt.type === 'worker.healthy' || evt.type === 'worker.unhealthy') void pushOrchestratorConfig()
  })
  supervisor.on('state', broadcast)
  supervisor.start()
  orchestratorPort = portOf('orchestrator')
  void pushOrchestratorConfigUntilReady()
  // 兜底刷新：设备重启/服务重连后配置不会被测试或旧值钉住
  refreshTimer = setInterval(() => void pushOrchestratorConfig(), 60_000)
  refreshTimer.unref()

  // 局域网网关：证书与配对独立于 sidecar，服务端口就绪即可转发
  gatewayTargets = [
    { name: 'olvt', port: portOf('olvt'), wsPath: '/client-ws' },
    { name: 'orchestrator', port: portOf('orchestrator'), wsPath: '/dhvw' },
    { name: 'waketrace', port: portOf('waketrace') },
  ]
  gateway = new Gateway({ port: config.gateway.port, targets: gatewayTargets })
  if (config.gateway.enabled) gateway.start()

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
    await gateway?.stop()
    await supervisor?.stop('app-quit')
    app.exit(0)
  })
}

app.on('before-quit', () => {
  stopLive2dServer()
  stopArmPreviewServer()
})

app.whenReady().then(boot).catch((err) => {
  log('error', 'app', '启动失败', { error: String(err) })
  dialog.showErrorBox('DHVW 启动失败', String(err))
  app.exit(1)
})
