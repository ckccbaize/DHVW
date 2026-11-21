import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, screen, shell as electronShell } from 'electron'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { appIconPath, bundledResourceDir, dataDir, logDir, rendererIndex, resourcesRoot, runtimeDir } from './paths'
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
import {
  getArmPreviewLocalUrl,
  getArmPreviewPort,
  resolveArmWwwDir,
  startArmPreviewServer,
  stopArmPreviewServer,
} from './arm-preview'
import type {
  ActionRequest,
  AppSnapshot,
  ArmConsoleResult,
  CharacterCardData,
  CharacterGenerateInput,
  CharacterSampleView,
  CharacterSheetMetaJson,
  CharacterSheetView,
  FeishuBotStatusView,
  Live2dModelView,
  LlmMode,
  MemoryCurveView,
  MemoryFactView,
  MemoryStatsView,
  PersonaCardImportResult,
  PersonaGenerateInput,
  PersonaJobView,
  ProactiveStateView,
  PathPickArgs,
  QqBotStatusView,
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
import {
  buildTavernPng,
  compilePersonaPrompt,
  parseTavernJson,
  parseTavernPng,
  toSillyTavernV2Json,
} from './persona-card'
import { createTray } from './tray'
import { applyNetworkHardening, hardenSessionSetup } from './hardening'
import { listImageModels, listModels, probeLlm } from './network'
import { COMPONENTS, componentStatus, ensureComponent, resolveSpec, uvBinary } from './components'
import {
  clearApiKey,
  clearImageGenKey,
  hasApiKey,
  hasFeishuSecret,
  hasImageGenKey,
  hasQqSecret,
  readApiKey,
  readFeishuSecret,
  readImageGenKey,
  readQqSecret,
  saveApiKey,
  saveFeishuSecret,
  saveImageGenKey,
  saveQqSecret,
} from './secret'
import { asrModelPaths, prepareOlvt, resolveOlvtDir, syncOlvtModel } from './olvt'
import { Gateway, type GatewayTarget } from './gateway'
import { pairArmDevice, scanArmDevices } from './arm-pair'
import {
  buildNemotronLlamaArgs,
  isLoopbackUrl,
  NEMOTRON_MODEL_ID,
  NEMOTRON_RECOMMENDED_TEMP,
  preferredLlamaDir,
  resolveLlamaServer,
  resolveNemotronMmproj,
  resolveNemotronModel,
} from './local-llm'

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
let llamaServicePort = 0
let allocatedPorts: number[] = []
let refreshTimer: NodeJS.Timeout | null = null

const effectiveApiKey = (baseUrl: string): string =>
  readApiKey() || (isLoopbackUrl(baseUrl) ? 'local-llama' : '')

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
    boostGateways: { ...config.boost.gateways },
    qqBot: {
      appId: config.qqBot.appId,
      clientSecret: readQqSecret() || undefined,
      sandbox: config.qqBot.sandbox,
      ownerOpenId: config.qqBot.ownerOpenId,
      proactive: config.qqBot.proactive,
      stickerEagerness: config.qqBot.stickerEagerness,
    },
    feishuBot: {
      appId: config.feishuBot.appId,
      appSecret: readFeishuSecret() || undefined,
      ownerOpenId: config.feishuBot.ownerOpenId,
      proactive: config.feishuBot.proactive,
      stickerEagerness: config.feishuBot.stickerEagerness,
    },
    autoPushScene: config.scene.autoPush,
    pixelCharacterId: config.pixelCharacterId ?? '',
    persona: {
      characterName: config.olvt?.characterName || '',
      personaPrompt: config.olvt?.personaPrompt || '',
      cardName: config.olvt?.personaCard?.name || '',
    },
    proactive: { ...config.proactive },
    llm: {
      mode: config.llmMode,
      baseUrl: config.llm.baseUrl,
      model: config.llm.model || undefined,
      apiKey: effectiveApiKey(config.llm.baseUrl) || undefined,
      supportsVision: Boolean(config.llm.supportsVision),
    },
    imageGen: {
      enabled: Boolean(config.imageGen?.enabled),
      protocol: config.imageGen?.protocol || 'openai-images',
      baseUrl: (config.imageGen?.baseUrl || '').trim() || config.llm.baseUrl,
      model: (config.imageGen?.model || '').trim(),
      fusionStylePrompt: config.imageGen?.fusionStylePrompt ?? '',
      apiKey: readImageGenKey() || effectiveApiKey((config.imageGen?.baseUrl || '').trim() || config.llm.baseUrl) || '',
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

/** ARM 世界生活控制台：快照与控制都经编排器转发给设备，PC 不直连设备。 */
async function armConsoleSnapshot(): Promise<ArmConsoleResult> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/console/snapshot`, {
      signal: AbortSignal.timeout(6000),
    })
    const raw = (await res.json()) as ArmConsoleResult
    return raw
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function armConsoleCommand(
  command: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/console/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(6000),
    })
    const raw = (await res.json()) as { ok?: boolean; error?: string }
    return { ok: Boolean(raw.ok), error: raw.error }
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
/** 记忆向量服务信息：编排器自报模型/依赖/索引计数，外壳只做转发与可达性标注 */
async function readMemoryStats(): Promise<MemoryStatsView> {
  if (!orchestratorPort) return { reachable: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/memory/stats`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const raw = (await res.json()) as Omit<MemoryStatsView, 'reachable'>
    return { reachable: true, ...raw }
  } catch (err) {
    return { reachable: false, error: (err as Error).message || String(err) }
  }
}

/** 删除并由正文重建 FTS5 + 向量索引（只重建派生数据，正文不动） */
async function rebuildMemory(): Promise<{ ok: boolean; total?: number; fts?: number; vec?: number; error?: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/memory/rebuild`, {
      method: 'POST',
      // 全量重新编码 512 维向量，条数多时要几十秒
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as { ok: boolean; total: number; fts: number; vec: number }
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) }
  }
}

/** 按遗忘曲线结算：标记过期 + 物理删除超期行；dryRun 只报数 */
async function forgetMemory(dryRun: boolean): Promise<Record<string, unknown>> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(
      `http://127.0.0.1:${orchestratorPort}/dhvw/memory/forget${dryRun ? '?dry_run=true' : ''}`,
      { method: 'POST', signal: AbortSignal.timeout(60_000) },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as Record<string, unknown>
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) }
  }
}

/** 遗忘曲线：保持率最低的活跃记忆 */
async function memoryCurve(k = 8): Promise<MemoryCurveView | { ok: false; error: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/memory/curve?k=${k}`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as MemoryCurveView
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) }
  }
}

/** 把记忆向量的运行时依赖装进共享 site-packages（模型随包，只装库） */
async function installMemoryDeps(): Promise<{ ok: boolean; output?: string; error?: string }> {
  const uv = uvBinary()
  if (!uv) return { ok: false, error: '缺少 uv（打包时应随 tools/uv.exe 提供）' }
  const req = path.join(bundledResourceDir(), 'memory-requirements.txt')
  if (!fs.existsSync(req)) return { ok: false, error: `缺少依赖清单：${req}` }
  const args = [
    'pip',
    'install',
    '--python',
    path.join(runtimeDir(), 'python.exe'),
    '--target',
    path.join(runtimeDir(), 'site-packages'),
    '--index-url',
    'https://mirrors.aliyun.com/pypi/simple',
    '--no-cache',
    '--quiet',
    '-r',
    req,
  ]
  log('info', 'memory', '安装记忆向量依赖', { uv, req })
  const out = spawnSync(uv, args, { encoding: 'utf8', timeout: 30 * 60 * 1000 })
  if (out.error) return { ok: false, error: String(out.error) }
  if (out.status !== 0) {
    return { ok: false, error: String(out.stderr ?? '').slice(-600) || String(out.stdout ?? '').slice(-600) }
  }
  // site-packages 变了：重启编排器才会重新 import onnxruntime / sqlite_vec
  log('info', 'memory', '记忆向量依赖已安装，重启编排器生效')
  return { ok: true, output: String(out.stdout ?? '').slice(-600) }
}

/** 主动说话现状（编排器 + OLVT 自报，只读聚合） */
async function readProactiveState(): Promise<ProactiveStateView> {
  if (!orchestratorPort) return { error: '编排器未运行' }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/proactive`, {
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as ProactiveStateView
  } catch (err) {
    return { error: (err as Error).message || String(err) }
  }
}

/** 在资源管理器里打开一个已存在的目录（模型目录、数据目录等） */
async function openDirectory(dir: string): Promise<{ ok: boolean; error?: string }> {
  const target = String(dir ?? '').trim()
  if (!target) return { ok: false, error: '路径为空' }
  try {
    if (!fs.statSync(target).isDirectory()) return { ok: false, error: '不是文件夹' }
  } catch {
    return { ok: false, error: '目录不存在' }
  }
  const err = await electronShell.openPath(target)
  return err ? { ok: false, error: err } : { ok: true }
}

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
  if (config.llmMode === 'local') return { ok: false, error: '本地 LLM 模式不开放地图生成' }
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
  { id: 'llama', name: '本地推理 (llama)', module: 'dhvw_worker', args: ['--name', 'llama'], healthPath: '/health', autoStart: false },
]

function buildRuntimeServices(ports: number[]): ServiceDef[] {
  const olvtDir = resolveOlvtDir(config.sidecars.olvt?.cwd || config.olvt.dir)
  const ttsOverride = config.sidecars.tts
  const ttsDir = (ttsOverride?.cwd || config.tts.backendDir || '').trim()
  const ttsPython = ttsDir ? path.join(ttsDir, 'runtime', 'python.exe') : ''
  const llamaServer = resolveLlamaServer()
  const nemotronModel = resolveNemotronModel()
  const portOf = (id: string): number => ports[SERVICE_CATALOG.findIndex((s) => s.id === id)] ?? 0

  return SERVICE_CATALOG.map((svc, i) => {
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
      const isLocalLlm = config.llmMode === 'local' || isLoopbackUrl(config.llm.baseUrl)
      const env: Record<string, string> = {
        ...override?.env,
        PYTHONUNBUFFERED: '1',
        DHVW_ORCHESTRATOR_URL: `http://127.0.0.1:${portOf('orchestrator')}`,
      }
      if (!isLocalLlm) {
        // 云端 API 思考模型可关闭 reasoning_effort；本地 llama 保留思考与完整输出欲望
        env.OLVT_LLM_EXTRA_BODY = '{"reasoning_effort":"none"}'
      }
      return {
        ...svc,
        command: override?.command ?? [resolvePython(), 'run_server.py'],
        cwd: olvtDir,
        env,
        healthMode: 'tcp',
        healthPath: undefined,
        healthTimeout: 180,
        port,
      }
    }
    if (svc.id === 'llama') {
      const nemotronMmproj = resolveNemotronMmproj()
      if (override?.command || (llamaServer && nemotronModel)) {
        return {
          ...svc,
          command: override?.command ?? [llamaServer!.exe, ...buildNemotronLlamaArgs(nemotronModel!.path, nemotronMmproj?.path)],
          cwd: override?.cwd ?? llamaServer?.dir,
          env: { ...override?.env },
          healthMode: 'http',
          healthPath: '/health',
          healthTimeout: 90,
          autoStart: config.llmMode === 'local' || isLoopbackUrl(config.llm.baseUrl),
          port,
        }
      }
      return { ...svc, autoStart: false, port }
    }
    return { ...svc, ...(override ?? {}), port }
  })
}

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

function ref3dFilePath(): string {
  return path.join(dataDir, 'data', 'character_ref_3d.png')
}

function settingsView(): SettingsView {
  return {
    boost: { enabled: config.boost.enabled, gateways: { ...config.boost.gateways } },
    qqBot: { ...config.qqBot, hasSecret: hasQqSecret() },
    feishuBot: { ...config.feishuBot, hasSecret: hasFeishuSecret() },
    llmMode: config.llmMode,
    llmApi: { ...config.llmApi },
    localLlmReady: Boolean(resolveLlamaServer() && resolveNemotronModel()),
    localLlmModel: NEMOTRON_MODEL_ID,
    llm: { ...config.llm, hasKey: hasApiKey() },
    imageGen: { ...config.imageGen, hasKey: hasImageGenKey() },
    hasRef3d: fs.existsSync(ref3dFilePath()),
    ports: { ...config.ports },
    asr: { ...config.asr, ready: Boolean(asrModelPaths(config.asr.enabled).modelPath) },
    live2d: { model: live2dModel?.id ?? config.live2d.model },
    pixelCharacterId: config.pixelCharacterId ?? '',
    scene: { ...config.scene },
    proactive: { ...config.proactive },
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
    // 开发期任务栏/Alt-Tab 走窗口图标；打包后由 exe 内嵌的 icon.ico 提供
    icon: appIconPath(),
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
    models: live2dModelsView(),
  }))
  ipcMain.handle('dhvw:pickPath', async (_e, args: PathPickArgs) => {
    const opts: Electron.OpenDialogOptions = {
      title: args?.title,
      defaultPath: args?.defaultPath?.trim() || undefined,
      properties: args?.kind === 'dir' ? ['openDirectory', 'createDirectory'] : ['openFile'],
      filters: args?.kind === 'file' ? args.filters : undefined,
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const picked = res.canceled ? '' : (res.filePaths[0] ?? '')
    return picked ? { ok: true, path: picked } : { ok: false }
  })
  ipcMain.handle('dhvw:openLive2dDir', async () => {
    const dir = activeLive2dDir()
    fs.mkdirSync(dir, { recursive: true })
    const err = await electronShell.openPath(dir)
    return { ok: !err, path: dir, error: err || undefined }
  })
  ipcMain.handle('dhvw:armPreview', () => ({
    url: armPreviewUrl,
    localUrl: getArmPreviewLocalUrl(),
    error: armPreviewUrl ? undefined : 'ARM 预览资源缺失（arm/www/preview.html）',
  }))
  ipcMain.handle('dhvw:memoryStats', () => readMemoryStats())
  ipcMain.handle('dhvw:proactiveState', () => readProactiveState())
  ipcMain.handle('dhvw:memoryRebuild', () => rebuildMemory())
  ipcMain.handle('dhvw:memoryForget', (_e, dryRun: boolean) => forgetMemory(dryRun === true))
  ipcMain.handle('dhvw:memoryCurve', (_e, k: number) => memoryCurve(Number(k) || 8))
  ipcMain.handle('dhvw:memoryDepsInstall', () => installMemoryDeps())
  ipcMain.handle('dhvw:openDirectory', (_e, dir: string) => openDirectory(dir))
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
  ipcMain.handle('dhvw:gatewayBrowserPair', (_e, name?: string) => {
    if (!gateway) return { ok: false, error: '网关未启动' }
    if (!gateway.status.running) gateway.start()
    const device = gateway.createDevice(name || '浏览器测试')
    const wsUrl = gateway.wsUrlFor(device.token)
    if (!wsUrl) return { ok: false, error: '网关没有局域网地址' }
    const armPort = getArmPreviewPort()
    let armUrl: string | undefined
    if (armPort > 0) {
      try {
        const u = new URL(wsUrl)
        armUrl = `https://${u.host}/arm/?token=${encodeURIComponent(device.token)}&host=${encodeURIComponent(wsUrl)}&remote=1`
      } catch {
        armUrl = undefined
      }
    }
    return { ok: true, token: device.token, wsUrl, armUrl, name: device.name }
  })
  ipcMain.handle('dhvw:gatewayScan', () => scanArmDevices())
  ipcMain.handle('dhvw:gatewayPairArm', async (_e, req: { host?: string; name?: string }) => {
    if (!gateway) return { ok: false, error: '网关未启动' }
    if (!gateway.status.running) gateway.start()
    const host = String(req?.host || '').trim()
    if (!host) return { ok: false, error: '缺少设备地址' }
    const device = gateway.createDevice(req?.name || `ARM ${host}`)
    const wsUrl = gateway.wsUrlFor(device.token, host)
    if (!wsUrl) return { ok: false, error: '网关没有局域网地址' }
    const result = await pairArmDevice(host, wsUrl, device.name, gateway.caPem)
    if (!result.ok) {
      gateway.forgetDevice(device.token)
      return { ok: false, error: result.error || '设备配对失败' }
    }
    log('info', 'gateway', 'ARM 已配对', { host, name: device.name })
    return { ok: true, wsUrl, name: device.name }
  })
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
  ipcMain.handle('dhvw:armConsoleSnapshot', () => armConsoleSnapshot())
  ipcMain.handle('dhvw:armConsoleCommand', (_e, command: Record<string, unknown>) =>
    armConsoleCommand(command),
  )
  ipcMain.handle('dhvw:scenes', () => readScenes())
  ipcMain.handle('dhvw:sceneGenerate', (_e, spec: Record<string, unknown>) => requestScene(spec))
  ipcMain.handle('dhvw:sceneRetry', (_e, id: string) => retryScene(id))
  ipcMain.handle('dhvw:scenePush', (_e, id: string) => pushScene(id))
  ipcMain.handle('dhvw:sceneJobRetry', (_e, id: string) => retrySceneJob(id))
  ipcMain.handle('dhvw:sceneDelete', (_e, id: string) => deleteSceneOutput(id))
  ipcMain.handle('dhvw:personaImportCard', async (_e, filePath?: string): Promise<PersonaCardImportResult> => {
    let target = String(filePath ?? '').trim()
    if (!target) {
      const opts: Electron.OpenDialogOptions = {
        title: '选择酒馆角色卡（PNG / JSON）',
        properties: ['openFile'],
        filters: [{ name: '角色卡（PNG / JSON）', extensions: ['png', 'json'] }],
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      target = res.canceled ? '' : (res.filePaths[0] ?? '')
    }
    if (!target) return { ok: false, error: '已取消选择' }
    try {
      const ext = path.extname(target).toLowerCase()
      const parsed =
        ext === '.png'
          ? parseTavernPng(fs.readFileSync(target))
          : parseTavernJson(fs.readFileSync(target, 'utf8'))
      if (parsed.ok && parsed.card) {
        parsed.compiledPrompt = compilePersonaPrompt(parsed.card, config.olvt.humanName)
      }
      return parsed
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
  ipcMain.handle('dhvw:personaAvatar', async () => {
    const opts: Electron.OpenDialogOptions = {
      title: '选择角色卡 PNG 立绘底图',
      properties: ['openFile'],
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const target = res.canceled ? '' : (res.filePaths[0] ?? '')
    if (!target) return { ok: false }
    try {
      const buf = fs.readFileSync(target)
      if (buf.length < 8 || !buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return { ok: false, error: '请选择有效的 PNG 图片文件' }
      }
      return { ok: true, avatarDataUrl: `data:image/png;base64,${buf.toString('base64')}` }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
  ipcMain.handle(
    'dhvw:personaExportCard',
    async (_e, req: { card: CharacterCardData; format?: 'png' | 'json' }) => {
      if (!req?.card) return { ok: false, error: '缺少角色卡数据' }
      const fmt = req.format === 'json' ? 'json' : 'png'
      const safeName = (req.card.name || 'character').replace(/[\\/:*?"<>|]/g, '_').trim() || 'character'
      const opts: Electron.SaveDialogOptions = {
        title: fmt === 'png' ? '导出酒馆角色卡（PNG）' : '导出角色卡（JSON）',
        defaultPath: `${safeName}.${fmt}`,
        filters: [fmt === 'png' ? { name: 'PNG 角色卡', extensions: ['png'] } : { name: 'JSON 角色卡', extensions: ['json'] }],
      }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      try {
        if (fmt === 'json') {
          fs.writeFileSync(res.filePath, JSON.stringify(toSillyTavernV2Json(req.card), null, 2), 'utf8')
        } else {
          let basePng: Buffer | undefined
          const dataUrl = req.card.avatarDataUrl || ''
          const m = /^data:image\/png;base64,(.+)$/i.exec(dataUrl)
          if (m?.[1]) basePng = Buffer.from(m[1], 'base64')
          fs.writeFileSync(res.filePath, buildTavernPng(req.card, basePng))
        }
        return { ok: true, path: res.filePath }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    },
  )
  ipcMain.handle('dhvw:personaJobs', async (): Promise<{ ok: boolean; jobs: PersonaJobView[]; error?: string }> => {
    const r = await orchJson<{ ok?: boolean; jobs?: PersonaJobView[]; error?: string }>('/dhvw/persona/jobs')
    return { ok: Boolean(r.ok), jobs: r.jobs ?? [], error: r.error }
  })
  ipcMain.handle(
    'dhvw:personaGenerate',
    async (_e, input: PersonaGenerateInput): Promise<{ ok: boolean; job?: PersonaJobView; error?: string }> =>
      orchJson('/dhvw/persona/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input ?? {}),
      }),
  )
  ipcMain.handle('dhvw:personaStopJob', async (_e, jobId: string) =>
    orchJson(`/dhvw/persona/jobs/${encodeURIComponent(String(jobId || ''))}/stop`, { method: 'POST' }),
  )
  ipcMain.handle('dhvw:personaRetryJob', async (_e, jobId: string) =>
    orchJson(`/dhvw/persona/jobs/${encodeURIComponent(String(jobId || ''))}/retry`, { method: 'POST' }),
  )
  ipcMain.handle('dhvw:personaDeleteJob', async (_e, jobId: string) =>
    orchJson(`/dhvw/persona/jobs/${encodeURIComponent(String(jobId || ''))}`, { method: 'DELETE' }),
  )
  ipcMain.handle(
    'dhvw:personaApply',
    async (
      _e,
      payload: {
        card?: CharacterCardData | null
        characterName: string
        humanName?: string
        personaPrompt: string
        l0Facts?: Array<{ id?: string; text: string; importance?: number }>
      },
    ) => {
      const charName = String(payload?.characterName ?? '').trim() || config.olvt.characterName
      const humanName =
        payload?.humanName !== undefined ? String(payload.humanName).trim() || '主人' : config.olvt.humanName
      const personaPrompt = String(payload?.personaPrompt ?? '').trim() || config.olvt.personaPrompt
      const olvtChanged =
        charName !== config.olvt.characterName ||
        humanName !== config.olvt.humanName ||
        personaPrompt !== config.olvt.personaPrompt

      const next: ShellConfig = {
        ...config,
        olvt: {
          ...config.olvt,
          characterName: charName,
          humanName,
          personaPrompt,
          personaCard: payload?.card !== undefined ? payload.card : config.olvt.personaCard ?? null,
        },
      }
      saveConfig(next)
      config = next
      if (olvtChanged) syncOlvtConfig(false)
      void pushOrchestratorConfig()

      let factsResult: Record<string, unknown> | null = null
      const facts = Array.isArray(payload?.l0Facts)
        ? payload.l0Facts
            .map((f) => ({
              ...(f.id ? { id: String(f.id) } : {}),
              text: String(f.text || '').trim(),
              tier: 'L0',
              importance: Number.isFinite(Number(f.importance)) ? Number(f.importance) : 0.95,
            }))
            .filter((f) => Boolean(f.text))
        : []
      if (facts.length) {
        factsResult = await orchJson('/dhvw/facts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facts }),
        })
      }
      log('info', 'persona', '已应用角色人设与核心记忆', {
        characterName: charName,
        olvtRestarted: olvtChanged,
        l0Count: facts.length,
      })
      return { ok: true, settings: settingsView(), factsResult }
    },
  )
  ipcMain.handle(
    'dhvw:memoryFacts',
    async (_e, tier = '', limit = 120): Promise<{ ok: boolean; facts: MemoryFactView[]; error?: string }> => {
      const q = new URLSearchParams({ tier: String(tier || ''), limit: String(limit || 120) }).toString()
      const r = await orchJson<{ ok?: boolean; facts?: MemoryFactView[]; error?: string }>(`/dhvw/memory/facts?${q}`)
      return { ok: Boolean(r.ok), facts: r.facts ?? [], error: r.error }
    },
  )
  ipcMain.handle(
    'dhvw:memoryAddFacts',
    async (_e, facts: Array<{ id?: string; text: string; tier?: string; importance?: number }>) =>
      orchJson('/dhvw/facts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facts: Array.isArray(facts) ? facts : [] }),
      }),
  )
  ipcMain.handle('dhvw:memoryDeleteFact', async (_e, factId: string) =>
    orchJson(`/dhvw/memory/facts/${encodeURIComponent(String(factId || ''))}`, { method: 'DELETE' }),
  )
  ipcMain.handle(
    'dhvw:characters',
    async (): Promise<{ ok: boolean; activeId: string | null; characters: CharacterSheetView[]; error?: string }> => {
      const r = await orchJson<{ ok?: boolean; activeId?: string | null; characters?: CharacterSheetView[]; error?: string }>(
        '/dhvw/characters',
      )
      return { ok: Boolean(r.ok), activeId: r.activeId ?? null, characters: r.characters ?? [], error: r.error }
    },
  )
  ipcMain.handle('dhvw:characterPickImage', async () => {
    const opts: Electron.OpenDialogOptions = {
      title: '选择角色 4×4 行走图（PNG / JPG / WebP）',
      properties: ['openFile'],
      filters: [{ name: '角色行走图', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const target = res.canceled ? '' : (res.filePaths[0] ?? '')
    if (!target) return { ok: false, canceled: true }
    try {
      const buf = fs.readFileSync(target)
      const ext = path.extname(target).toLowerCase().replace('.', '')
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      const b64 = buf.toString('base64')
      return {
        ok: true,
        filename: path.basename(target),
        imageBase64: b64,
        dataUrl: `data:${mime};base64,${b64}`,
      }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
  ipcMain.handle('dhvw:characterSamples', async (): Promise<{ ok: boolean; samples: CharacterSampleView[] }> => {
    const candidateDirs = [
      path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'char-samples'),
      path.resolve(app.getAppPath(), '..', '..', 'assets', 'char'),
      path.resolve(process.cwd(), 'assets', 'char'),
    ]
    const specs: Array<{
      id: string
      filename: string
      name: string
      badge: string
      description: string
      rowOrder: string
    }> = [
      {
        id: 'ojj',
        filename: 'ojj.jpg',
        name: '鲸鱼娘',
        badge: '标准 4×4 原素材',
        description: '处理前 4 方向×4 帧原始白底素材（32×48 推荐），可直接自动去背并扩展全套 22 种动作。',
        rowOrder: 'auto',
      },
      {
        id: 'miku_err',
        filename: 'miku_err.jpg',
        name: '初音未来（方向纠偏示例）',
        badge: '含方向错误 · 可自动纠偏',
        description: 'AI 生成素材中第 2 行第 4 帧人物朝向反转（朝右），且双马尾间含闭合白底；载入后可验证自动方向纠偏与白隙清理。',
        rowOrder: 'auto',
      },
    ]
    const samples: CharacterSampleView[] = []
    for (const sp of specs) {
      let found: string | null = null
      for (const d of candidateDirs) {
        const p = path.join(d, sp.filename)
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          found = p
          break
        }
      }
      if (!found) continue
      try {
        const buf = fs.readFileSync(found)
        const b64 = buf.toString('base64')
        samples.push({
          ...sp,
          imageBase64: b64,
          dataUrl: `data:image/jpeg;base64,${b64}`,
        })
      } catch {
        /* ignore */
      }
    }
    return { ok: true, samples }
  })
  ipcMain.handle(
    'dhvw:characterGenerate',
    async (
      _e,
      input: CharacterGenerateInput,
    ): Promise<{
      ok: boolean
      character?: CharacterSheetView
      activeId?: string | null
      apply?: { activeId: string; updatedScenes: string[]; syncedDevPaths: string[] } | null
      settings?: SettingsView
      error?: string
    }> => {
      const res = await orchJson<{
        ok?: boolean
        character?: CharacterSheetView
        activeId?: string | null
        apply?: { activeId: string; updatedScenes: string[]; syncedDevPaths: string[] } | null
        error?: string
      }>(
        '/dhvw/characters/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input ?? {}),
        },
        30_000,
      )
      if (res.ok && input?.autoApply !== false && res.character?.id) {
        config = { ...config, pixelCharacterId: res.character.id }
        saveConfig(config)
      }
      return { ...res, settings: settingsView() }
    },
  )
  ipcMain.handle(
    'dhvw:characterRegenerate',
    async (
      _e,
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
      orchJson(
        `/dhvw/characters/${encodeURIComponent(String(charId || ''))}/regenerate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch ?? {}),
        },
        30_000,
      ),
  )
  ipcMain.handle(
    'dhvw:characterApply',
    async (
      _e,
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
    }> => {
      const targetId = String(charId || '').trim() || 'default'
      const res = await orchJson<{
        ok?: boolean
        activeId?: string | null
        updatedScenes?: string[]
        syncedDevPaths?: string[]
        delivered?: number
        error?: string
      }>(
        `/dhvw/characters/${encodeURIComponent(targetId)}/apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(opts ?? { applyToScenes: true, syncToolchain: true }),
        },
        30_000,
      )
      if (res.ok) {
        config = { ...config, pixelCharacterId: targetId === 'default' ? '' : (res.activeId ?? targetId) }
        saveConfig(config)
      }
      return { ...res, settings: settingsView() }
    },
  )
  ipcMain.handle('dhvw:characterDelete', async (_e, charId: string) => {
    const res = await orchJson<{ ok?: boolean; deleted?: string; activeId?: string | null; error?: string }>(
      `/dhvw/characters/${encodeURIComponent(String(charId || ''))}`,
      { method: 'DELETE' },
    )
    if (res.ok && config.pixelCharacterId === charId) {
      config = { ...config, pixelCharacterId: res.activeId ?? '' }
      saveConfig(config)
    }
    return { ...res, settings: settingsView() }
  })
  ipcMain.handle('dhvw:characterRename', async (_e, charId: string, name: string) => {
    const res = await orchJson<{ ok?: boolean; character?: CharacterSheetView; error?: string }>(
      `/dhvw/characters/${encodeURIComponent(String(charId || ''))}/rename`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: String(name ?? '').trim() }),
      },
    )
    return { ...res, settings: settingsView() }
  })
  ipcMain.handle(
    'dhvw:characterAssets',
    async (
      _e,
      charId: string,
    ): Promise<{
      ok: boolean
      meta?: CharacterSheetMetaJson
      sheetDataUrl?: string
      previewDataUrl?: string
      sourceDataUrl?: string
      error?: string
    }> => {
      if (!orchestratorPort) return { ok: false, error: '编排器尚未就绪' }
      const safeId = encodeURIComponent(String(charId || ''))
      const base = `http://127.0.0.1:${orchestratorPort}/dhvw/characters/${safeId}`
      try {
        const [metaRes, sheetRes, prevRes, srcRes] = await Promise.all([
          fetch(`${base}/sheet.json`, { signal: AbortSignal.timeout(5000) }),
          fetch(`${base}/sheet.png`, { signal: AbortSignal.timeout(5000) }),
          fetch(`${base}/preview.png`, { signal: AbortSignal.timeout(5000) }),
          fetch(`${base}/source.png`, { signal: AbortSignal.timeout(5000) }),
        ])
        if (!metaRes.ok || !sheetRes.ok) return { ok: false, error: '图集文件读取失败' }
        const meta = (await metaRes.json()) as CharacterSheetMetaJson
        const sheetBuf = Buffer.from(await sheetRes.arrayBuffer())
        const prevBuf = prevRes.ok ? Buffer.from(await prevRes.arrayBuffer()) : null
        const srcBuf = srcRes.ok ? Buffer.from(await srcRes.arrayBuffer()) : null
        return {
          ok: true,
          meta,
          sheetDataUrl: `data:image/png;base64,${sheetBuf.toString('base64')}`,
          previewDataUrl: prevBuf ? `data:image/png;base64,${prevBuf.toString('base64')}` : undefined,
          sourceDataUrl: srcBuf ? `data:image/png;base64,${srcBuf.toString('base64')}` : undefined,
        }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    },
  )
  ipcMain.handle('dhvw:saveImageGenKey', (_e, key: string) => {
    const r = saveImageGenKey(String(key ?? ''))
    if (r.ok) void pushOrchestratorConfig()
    return r
  })
  ipcMain.handle('dhvw:clearImageGenKey', () => {
    clearImageGenKey()
    void pushOrchestratorConfig()
    return { ok: true }
  })
  ipcMain.handle(
    'dhvw:listImageModels',
    async (_e, req?: { baseUrl?: string; apiKey?: string }) => {
      const base = String(req?.baseUrl || config.imageGen?.baseUrl || config.llm.baseUrl || '').trim()
      if (!base) return { ok: false, models: [], error: '请先填写生图模型端点或 LLM 端点' }
      const k = req?.apiKey?.trim() || readImageGenKey() || effectiveApiKey(base) || null
      return listImageModels({ baseUrl: base, apiKey: k })
    },
  )
  ipcMain.handle('dhvw:characterRef3dGet', async () => {
    const p = ref3dFilePath()
    if (!fs.existsSync(p)) return { ok: true, hasRef3d: false }
    try {
      const buf = fs.readFileSync(p)
      return { ok: true, hasRef3d: true, dataUrl: `data:image/png;base64,${buf.toString('base64')}` }
    } catch (e) {
      return { ok: false, hasRef3d: false, error: String(e) }
    }
  })
  ipcMain.handle('dhvw:characterRef3dPick', async () => {
    const opts: Electron.OpenDialogOptions = {
      title: '选择角色三维 / 三视图参考图片（用于生图融图）',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const target = res.canceled ? '' : (res.filePaths[0] ?? '')
    if (!target) return { ok: false, canceled: true }
    try {
      const b64 = fs.readFileSync(target).toString('base64')
      const r = await orchJson<{ ok?: boolean; hasRef3d?: boolean; updatedAt?: number; error?: string }>(
        '/dhvw/character-ref-3d',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: b64 }),
        },
        15_000,
      )
      if (!r.ok) return { ok: false, error: r.error ?? '保存三维参考图失败' }
      const p = ref3dFilePath()
      const outB64 = fs.existsSync(p) ? fs.readFileSync(p).toString('base64') : b64
      return {
        ok: true,
        hasRef3d: true,
        dataUrl: `data:image/png;base64,${outB64}`,
        settings: settingsView(),
      }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })
  ipcMain.handle('dhvw:characterRef3dClear', async () => {
    const r = await orchJson('/dhvw/character-ref-3d', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clear: true }),
    })
    try {
      const p = ref3dFilePath()
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch {}
    return { ...r, settings: settingsView() }
  })
  ipcMain.handle('dhvw:imageHistory', () => orchJson('/dhvw/image/history'))
  ipcMain.handle('dhvw:imageHistoryDelete', (_e, itemId: string) =>
    orchJson(`/dhvw/image/history/${encodeURIComponent(String(itemId || ''))}`, { method: 'DELETE' }),
  )
  ipcMain.handle(
    'dhvw:imageGenerate',
    async (
      _e,
      req: {
        mode?: 'character_4x4' | 'raw' | 'scene_fusion'
        prompt?: string
        refImageBase64?: string
        use3dRef?: boolean
        size?: string
        force?: boolean
      },
    ): Promise<{ ok: boolean; imageBase64?: string; mime?: string; dataUrl?: string; promptUsed?: string; error?: string }> =>
      orchJson(
        '/dhvw/image/generate',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req ?? {}),
        },
        120_000,
      ),
  )
  ipcMain.handle(
    'dhvw:characterExport',
    async (_e, req: { charId: string; name?: string; file: 'sheet.png' | 'sheet.json' | 'preview.png' }) => {
      if (!orchestratorPort) return { ok: false, error: '编排器尚未就绪' }
      const file = req?.file === 'sheet.json' ? 'sheet.json' : req?.file === 'preview.png' ? 'preview.png' : 'sheet.png'
      const safeName = (req?.name || 'character').replace(/[\\/:*?"<>|]/g, '_').trim() || 'character'
      const defaultName = file === 'sheet.json' ? `${safeName}_sheet.json` : file === 'preview.png' ? `${safeName}_preview.png` : `${safeName}_sheet.png`
      const ext = file.endsWith('.json') ? 'json' : 'png'
      const opts: Electron.SaveDialogOptions = {
        title: `导出 ${defaultName}`,
        defaultPath: defaultName,
        filters: [ext === 'json' ? { name: 'JSON 动作配置', extensions: ['json'] } : { name: 'PNG 图像', extensions: ['png'] }],
      }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false, canceled: true }
      try {
        const safeId = encodeURIComponent(String(req?.charId || ''))
        const upstream = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/characters/${safeId}/${file}`, {
          signal: AbortSignal.timeout(8000),
        })
        if (!upstream.ok) return { ok: false, error: `HTTP ${upstream.status}` }
        const buf = Buffer.from(await upstream.arrayBuffer())
        fs.writeFileSync(res.filePath, buf)
        return { ok: true, path: res.filePath }
      } catch (e) {
        return { ok: false, error: String(e) }
      }
    },
  )
  ipcMain.handle(
    'dhvw:setBoost',
    (_e, enabled: boolean, gateways?: Partial<{ qq: boolean; feishu: boolean }>) => {
      const nextGw = {
        qq: gateways?.qq !== undefined ? Boolean(gateways.qq) : config.boost.gateways.qq,
        feishu: gateways?.feishu !== undefined ? Boolean(gateways.feishu) : config.boost.gateways.feishu,
      }
      config = { ...config, boost: { enabled: Boolean(enabled), gateways: nextGw } }
      saveConfig(config)
      log('info', 'settings', '世界模式增强开关', { enabled: config.boost.enabled, gateways: config.boost.gateways })
      void pushOrchestratorConfig()
      return { ok: true, settings: settingsView() }
    },
  )
  ipcMain.handle('dhvw:setBoostGateways', (_e, gateways: Partial<{ qq: boolean; feishu: boolean }>) => {
    const nextGw = {
      qq: gateways?.qq !== undefined ? Boolean(gateways.qq) : config.boost.gateways.qq,
      feishu: gateways?.feishu !== undefined ? Boolean(gateways.feishu) : config.boost.gateways.feishu,
    }
    config = { ...config, boost: { ...config.boost, gateways: nextGw } }
    saveConfig(config)
    log('info', 'settings', '更新 Boost 启用网关', { gateways: nextGw })
    void pushOrchestratorConfig()
    return { ok: true, settings: settingsView() }
  })
  ipcMain.handle('dhvw:copyText', (_e, text: string) => {
    try {
      clipboard.writeText(String(text ?? ''))
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('dhvw:openExternal', async (_e, url: string) => {
    try {
      const clean = String(url ?? '').trim()
      if (!/^https?:\/\//i.test(clean)) return false
      await electronShell.openExternal(clean)
      return true
    } catch {
      return false
    }
  })
  const readQqBotStatus = async (): Promise<QqBotStatusView> => {
    const fsConfigured = Boolean(config.feishuBot.appId && hasFeishuSecret())
    const base: QqBotStatusView = {
      reachable: false,
      configured: Boolean(config.qqBot.appId && hasQqSecret()) || fsConfigured,
      hasSecret: hasQqSecret(),
      boostActive: config.boost.enabled,
      gateways: { ...config.boost.gateways },
      connected: false,
      sandbox: config.qqBot.sandbox,
      appId: config.qqBot.appId,
      appIdMasked: config.qqBot.appId ? `${config.qqBot.appId.slice(0, 4)}***` : '',
      paired: Boolean(config.qqBot.ownerOpenId),
      ownerOpenId: config.qqBot.ownerOpenId,
      ownerOpenIdMasked: config.qqBot.ownerOpenId ? `${config.qqBot.ownerOpenId.slice(0, 4)}****${config.qqBot.ownerOpenId.slice(-3)}` : '',
      awaitingActivation: Boolean(config.qqBot.appId && hasQqSecret() && !config.qqBot.ownerOpenId),
      proactive: config.qqBot.proactive,
      stickerEagerness: config.qqBot.stickerEagerness,
      feishu: {
        enabled: config.boost.gateways.feishu,
        configured: fsConfigured,
        hasSecret: hasFeishuSecret(),
        connected: false,
        appId: config.feishuBot.appId,
        appIdMasked: config.feishuBot.appId ? `${config.feishuBot.appId.slice(0, 4)}***` : '',
        paired: Boolean(config.feishuBot.ownerOpenId),
        ownerOpenId: config.feishuBot.ownerOpenId,
        ownerOpenIdMasked: config.feishuBot.ownerOpenId
          ? `${config.feishuBot.ownerOpenId.slice(0, 4)}****${config.feishuBot.ownerOpenId.slice(-3)}`
          : '',
        awaitingActivation: Boolean(fsConfigured && !config.feishuBot.ownerOpenId),
        proactive: config.feishuBot.proactive,
        unlimitedProactive: true,
      },
    }
    if (!orchestratorPort) return base
    try {
      const res = await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/qqbot/status`, {
        signal: AbortSignal.timeout(2500),
      })
      if (!res.ok) return base
      const data = (await res.json()) as Partial<QqBotStatusView> & { ok?: boolean }
      let dirty = false
      if (data.paired && data.ownerOpenId && data.ownerOpenId !== config.qqBot.ownerOpenId) {
        config = { ...config, qqBot: { ...config.qqBot, ownerOpenId: String(data.ownerOpenId) } }
        dirty = true
      }
      if (data.feishu?.paired && data.feishu?.ownerOpenId && data.feishu.ownerOpenId !== config.feishuBot.ownerOpenId) {
        config = { ...config, feishuBot: { ...config.feishuBot, ownerOpenId: String(data.feishu.ownerOpenId) } }
        dirty = true
      }
      if (dirty) saveConfig(config)
      const baseFeishu: FeishuBotStatusView = base.feishu ?? {
        enabled: config.boost.gateways.feishu,
        configured: fsConfigured,
        connected: false,
        appId: config.feishuBot.appId,
        appIdMasked: '',
        paired: Boolean(config.feishuBot.ownerOpenId),
        ownerOpenId: config.feishuBot.ownerOpenId,
        ownerOpenIdMasked: '',
        proactive: config.feishuBot.proactive,
      }
      return {
        ...base,
        ...data,
        reachable: true,
        hasSecret: base.hasSecret,
        feishu: { ...baseFeishu, ...(data.feishu || {}), hasSecret: hasFeishuSecret() },
      }
    } catch {
      return base
    }
  }
  ipcMain.handle('dhvw:qqBotStatus', () => readQqBotStatus())
  ipcMain.handle(
    'dhvw:qqBotSave',
    async (
      _e,
      patch: {
        appId?: string
        clientSecret?: string
        sandbox?: boolean
        proactive?: boolean
        stickerEagerness?: number
        activateBoost?: boolean
      },
    ) => {
      const nextQq = { ...config.qqBot }
      if (patch?.appId !== undefined) nextQq.appId = String(patch.appId).trim()
      if (patch?.sandbox !== undefined) nextQq.sandbox = Boolean(patch.sandbox)
      if (patch?.proactive !== undefined) nextQq.proactive = Boolean(patch.proactive)
      if (patch?.stickerEagerness !== undefined) {
        const n = Number(patch.stickerEagerness)
        if (Number.isFinite(n)) nextQq.stickerEagerness = Math.max(0, Math.min(3, Math.floor(n)))
      }
      if (patch?.clientSecret && patch.clientSecret.trim()) {
        const secRes = saveQqSecret(patch.clientSecret.trim())
        if (!secRes.ok) return { ok: false, error: secRes.error }
      }
      const nextBoostEnabled = patch?.activateBoost === true ? true : config.boost.enabled
      const nextGateways =
        patch?.activateBoost === true
          ? { ...config.boost.gateways, qq: true }
          : config.boost.gateways
      config = { ...config, qqBot: nextQq, boost: { enabled: nextBoostEnabled, gateways: nextGateways } }
      saveConfig(config)
      await pushOrchestratorConfig()
      const status = await readQqBotStatus()
      return { ok: true, settings: settingsView(), status }
    },
  )
  ipcMain.handle('dhvw:qqBotRebind', async () => {
    config = {
      ...config,
      qqBot: { ...config.qqBot, ownerOpenId: '' },
      boost: { enabled: true, gateways: { ...config.boost.gateways, qq: true } },
    }
    saveConfig(config)
    await pushOrchestratorConfig()
    if (orchestratorPort) {
      try {
        await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/qqbot/rebind`, {
          method: 'POST',
          signal: AbortSignal.timeout(3000),
        })
      } catch {}
    }
    const status = await readQqBotStatus()
    return { ok: true, settings: settingsView(), status }
  })
  ipcMain.handle(
    'dhvw:feishuBotSave',
    async (
      _e,
      patch: {
        appId?: string
        appSecret?: string
        proactive?: boolean
        stickerEagerness?: number
        activateBoost?: boolean
      },
    ) => {
      const nextFs = { ...config.feishuBot }
      if (patch?.appId !== undefined) nextFs.appId = String(patch.appId).trim()
      if (patch?.proactive !== undefined) nextFs.proactive = Boolean(patch.proactive)
      if (patch?.stickerEagerness !== undefined) {
        const n = Number(patch.stickerEagerness)
        if (Number.isFinite(n)) nextFs.stickerEagerness = Math.max(0, Math.min(3, Math.floor(n)))
      }
      if (patch?.appSecret && patch.appSecret.trim()) {
        const secRes = saveFeishuSecret(patch.appSecret.trim())
        if (!secRes.ok) return { ok: false, error: secRes.error }
      }
      const nextBoostEnabled = patch?.activateBoost === true ? true : config.boost.enabled
      const nextGateways =
        patch?.activateBoost === true
          ? { ...config.boost.gateways, feishu: true }
          : config.boost.gateways
      config = { ...config, feishuBot: nextFs, boost: { enabled: nextBoostEnabled, gateways: nextGateways } }
      saveConfig(config)
      await pushOrchestratorConfig()
      const status = await readQqBotStatus()
      return { ok: true, settings: settingsView(), status }
    },
  )
  ipcMain.handle('dhvw:feishuBotRebind', async () => {
    config = {
      ...config,
      feishuBot: { ...config.feishuBot, ownerOpenId: '' },
      boost: { enabled: true, gateways: { ...config.boost.gateways, feishu: true } },
    }
    saveConfig(config)
    await pushOrchestratorConfig()
    if (orchestratorPort) {
      try {
        await fetch(`http://127.0.0.1:${orchestratorPort}/dhvw/feishubot/rebind`, {
          method: 'POST',
          signal: AbortSignal.timeout(3000),
        })
      } catch {}
    }
    const status = await readQqBotStatus()
    return { ok: true, settings: settingsView(), status }
  })
  ipcMain.handle('dhvw:gatewayRestart', async () => {
    await gateway?.stop()
    gateway?.start()
    return { ok: true }
  })
  ipcMain.handle('dhvw:saveSettings', (_e, patch: SettingsPatch) => {
    const next = loadConfig()
    let llmChanged = false
    if (patch.llm?.baseUrl !== undefined) {
      if (!/^https?:\/\/[^\s]+$/.test(patch.llm.baseUrl)) return { ok: false, error: '端点必须是 http(s) URL' }
      const url = patch.llm.baseUrl.trim()
      if (url !== next.llm.baseUrl) llmChanged = true
      next.llm.baseUrl = url
    }
    if (patch.llm?.model !== undefined) {
      const model = String(patch.llm.model).trim()
      if (!model) return { ok: false, error: '模型不能为空（可先拉取模型列表）' }
      if (model !== next.llm.model) llmChanged = true
      next.llm.model = model
    }
    if (patch.llm?.protocol !== undefined) {
      if (!PROTOCOLS.includes(patch.llm.protocol)) return { ok: false, error: '不支持的协议' }
      if (patch.llm.protocol !== next.llm.protocol) llmChanged = true
      next.llm.protocol = patch.llm.protocol
    }
    if (patch.llm?.temperature !== undefined) {
      const t = Number(patch.llm.temperature)
      if (!(t >= 0 && t <= 2)) return { ok: false, error: 'temperature 需在 0–2' }
      if (t !== next.llm.temperature) llmChanged = true
      next.llm.temperature = t
    }
    if (patch.llm?.supportsVision !== undefined) {
      next.llm.supportsVision = Boolean(patch.llm.supportsVision)
    }
    if (next.llmMode === 'api') {
      next.llmApi = { ...next.llm }
    }
    if (patch.imageGen) {
      if (patch.imageGen.enabled !== undefined) next.imageGen.enabled = Boolean(patch.imageGen.enabled)
      if (patch.imageGen.protocol !== undefined) next.imageGen.protocol = patch.imageGen.protocol
      if (patch.imageGen.baseUrl !== undefined) {
        const u = String(patch.imageGen.baseUrl ?? '').trim()
        if (u && !/^https?:\/\/[^\s]+$/.test(u)) return { ok: false, error: '生图端点必须是 http(s) URL（或留空复用 LLM 端点）' }
        next.imageGen.baseUrl = u
      }
      if (patch.imageGen.model !== undefined) next.imageGen.model = String(patch.imageGen.model ?? '').trim()
      if (patch.imageGen.fusionStylePrompt !== undefined) {
        next.imageGen.fusionStylePrompt = String(patch.imageGen.fusionStylePrompt ?? '').replace(/\r\n/g, '\n').trim()
      }
    }
    if (patch.ports) {
      for (const key of ['olvt', 'tts', 'llama'] as const) {
        const v = patch.ports[key]
        if (v === undefined) continue
        if (!Number.isInteger(v) || v < 0 || v > 65535) return { ok: false, error: '端口需为 0–65535 的整数' }
        next.ports[key] = v
      }
    }
    if (patch.boost) {
      if (patch.boost.enabled !== undefined) next.boost.enabled = Boolean(patch.boost.enabled)
      if (patch.boost.gateways) {
        if (patch.boost.gateways.qq !== undefined) next.boost.gateways.qq = Boolean(patch.boost.gateways.qq)
        if (patch.boost.gateways.feishu !== undefined) next.boost.gateways.feishu = Boolean(patch.boost.gateways.feishu)
      }
    }
    if (patch.asr?.enabled !== undefined) next.asr.enabled = Boolean(patch.asr.enabled)
    let live2dChanged = false
    if (patch.scene?.autoPush !== undefined) next.scene.autoPush = Boolean(patch.scene.autoPush)
    if (patch.proactive) {
      const p = patch.proactive
      if (p.enabled !== undefined) next.proactive.enabled = Boolean(p.enabled)
      for (const key of ['idleSeconds', 'gapSeconds', 'maxGapSeconds', 'dailyMax'] as const) {
        const raw = p[key]
        if (raw === undefined) continue
        const num = Number(raw)
        if (!Number.isFinite(num) || num < 0 || num > 86400) return { ok: false, error: `${key} 必须是 0..86400 的整数` }
        next.proactive[key] = Math.round(num)
      }
      for (const key of ['quietStart', 'quietEnd'] as const) {
        const raw = p[key]
        if (raw === undefined) continue
        const text = String(raw).trim()
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return { ok: false, error: `${key} 需要 HH:MM` }
        next.proactive[key] = text
      }
      // 最短间隔不能大于退避上限，否则节奏会自我矛盾
      if (next.proactive.gapSeconds > next.proactive.maxGapSeconds) {
        next.proactive.maxGapSeconds = next.proactive.gapSeconds
      }
    }
    if (patch.live2d?.model !== undefined) {
      const want = String(patch.live2d.model).trim()
      const ref = findModel(live2dRoots, want)
      if (!ref) return { ok: false, error: `模型库里没有 ${want}（可点「刷新模型列表」）` }
      live2dChanged = ref.id !== live2dModel?.id
      live2dModel = ref
      next.live2d.model = ref.id
    }
    if (patch.pixelCharacterId !== undefined) {
      next.pixelCharacterId = String(patch.pixelCharacterId ?? '').trim()
    }
    let olvtChanged = false
    for (const key of ['characterName', 'humanName', 'personaPrompt'] as const) {
      const v = patch.olvt?.[key]
      if (v !== undefined) {
        const s = String(v)
        if (s !== next.olvt[key]) olvtChanged = true
        next.olvt[key] = s
      }
    }
    if (patch.olvt && 'personaCard' in patch.olvt) {
      next.olvt.personaCard = patch.olvt.personaCard ?? null
    }
    let ttsChanged = false
    let ttsBackendChanged = false
    for (const key of ['backendDir', 'refAudioPath', 'refText', 'refLang', 'textLang'] as const) {
      const v = patch.tts?.[key]
      if (v !== undefined) {
        const s = String(v)
        if (s !== next.tts[key]) {
          ttsChanged = true
          if (key === 'backendDir') ttsBackendChanged = true
        }
        next.tts[key] = s
      }
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
    if (ttsBackendChanged && supervisor && allocatedPorts.length) {
      supervisor.updateServices(buildRuntimeServices(allocatedPorts))
      void supervisor.stop('tts-backend-changed').then(() => supervisor?.start())
    } else if (live2dChanged || olvtChanged || llmChanged || ttsChanged) {
      syncOlvtConfig(live2dChanged)
    }
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
  ipcMain.handle('dhvw:openComponentDir', async (_e, id: string) => {
    if (id === 'llama-runtime') {
      const dir = preferredLlamaDir()
      fs.mkdirSync(dir, { recursive: true })
      const err = await electronShell.openPath(dir)
      return err ? { ok: false, error: err } : { ok: true, path: dir }
    }
    const base = COMPONENTS.find((c) => c.id === id)
    if (!base) return { ok: false, error: '未知组件' }
    const st = componentStatus(resolveSpec(base, config.componentUrls[id]))
    if (!st.path) return { ok: false, error: '组件目录未知' }
    fs.mkdirSync(st.path, { recursive: true })
    const err = await electronShell.openPath(st.path)
    return err ? { ok: false, error: err } : { ok: true, path: st.path }
  })
  async function switchLlmMode(mode: LlmMode): Promise<{
    ok: boolean
    settings?: SettingsView
    mode?: LlmMode
    baseUrl?: string
    model?: string
    error?: string
  }> {
    if (mode === 'local') {
      const llamaServer = resolveLlamaServer()
      if (!llamaServer) {
        return { ok: false, error: `未找到 llama-server.exe，请将推理程序放入 ${preferredLlamaDir()}` }
      }
      const nemotron = resolveNemotronModel()
      if (!nemotron) return { ok: false, error: '未找到 Nemotron-3.5-Bolt-E4B 模型文件，请先一键下载或放入模型目录' }
      const port = llamaServicePort || config.ports.llama || 8089
      const baseUrl = `http://127.0.0.1:${port}`
      const savedApi =
        config.llmMode === 'api' && !isLoopbackUrl(config.llm.baseUrl) ? { ...config.llm } : { ...config.llmApi }
      const next: ShellConfig = {
        ...config,
        llmMode: 'local',
        llmApi: savedApi,
        llm: {
          protocol: 'openai-compatible',
          baseUrl,
          model: NEMOTRON_MODEL_ID,
          temperature: NEMOTRON_RECOMMENDED_TEMP,
        },
      }
      saveConfig(next)
      config = next
      if (supervisor && allocatedPorts.length) {
        const services = buildRuntimeServices(allocatedPorts)
        supervisor.updateServices(services)
        const cur = supervisor.snapshots.find((w) => w.id === 'llama')
        if (!cur?.pid || cur.state !== 'running') supervisor.send({ cmd: 'start', service: 'llama' })
      }
      syncOlvtConfig(false)
      void pushOrchestratorConfigUntilReady(15)
      log('info', 'llm', '已切换为本地 llama 模型并同步双端', {
        exe: llamaServer.exe,
        model: nemotron.path,
        baseUrl,
        temperature: NEMOTRON_RECOMMENDED_TEMP,
      })
      return { ok: true, settings: settingsView(), mode: 'local', baseUrl, model: NEMOTRON_MODEL_ID }
    }

    const restored = { ...config.llmApi }
    const next: ShellConfig = {
      ...config,
      llmMode: 'api',
      llm: restored,
    }
    saveConfig(next)
    config = next
    if (supervisor) {
      if (allocatedPorts.length) supervisor.updateServices(buildRuntimeServices(allocatedPorts))
      const cur = supervisor.snapshots.find((w) => w.id === 'llama')
      if (cur && (cur.state === 'running' || cur.state === 'starting')) {
        supervisor.send({ cmd: 'stop', service: 'llama' })
      }
    }
    syncOlvtConfig(false)
    void pushOrchestratorConfigUntilReady(5)
    log('info', 'llm', '已切换回云端 API 并同步双端', {
      baseUrl: restored.baseUrl,
      model: restored.model || '-',
    })
    return {
      ok: true,
      settings: settingsView(),
      mode: 'api',
      baseUrl: restored.baseUrl,
      model: restored.model,
    }
  }

  ipcMain.handle('dhvw:switchLlmMode', async (_e, mode: LlmMode) =>
    switchLlmMode(mode === 'local' ? 'local' : 'api'),
  )
  ipcMain.handle('dhvw:activateLocalLlm', async () => switchLlmMode('local'))
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
    if (
      status.state === 'ready' &&
      (spec.id === 'llm-nemotron-e4b' || spec.id === 'llm-nemotron-mmproj') &&
      supervisor &&
      allocatedPorts.length
    ) {
      supervisor.updateServices(buildRuntimeServices(allocatedPorts))
      if (spec.id === 'llm-nemotron-mmproj' && config.llmMode === 'local') {
        void supervisor.stop('mmproj-installed').then(() => supervisor?.start())
      }
    }
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
  ipcMain.handle('dhvw:inspectAudio', (_e, filePath: string, ttsBackendDir?: string) => {
    const target = String(filePath ?? '').trim()
    if (!target || !fs.existsSync(target)) return { ok: false, error: '音频文件不存在' }
    const dur = probeAudioDuration(target, ttsBackendDir)
    return { ok: true, duration: dur }
  })
  ipcMain.handle('dhvw:readRefAudio', (_e, filePath: string, ttsBackendDir?: string) => {
    const target = String(filePath ?? '').trim()
    if (!target || !fs.existsSync(target)) return { ok: false, error: '音频文件不存在' }
    const dur = probeAudioDuration(target, ttsBackendDir)
    if (dur !== null && (dur < 3 || dur > 10)) {
      return {
        ok: false,
        duration: dur,
        canClip: dur > 10,
        error: `参考音频时长 ${dur.toFixed(2)}s，不在 3~10 秒要求范围内，请先裁剪或更换后再试听`,
      }
    }
    const stat = fs.statSync(target)
    if (stat.size > 20 * 1024 * 1024) {
      return { ok: false, duration: dur, error: '参考音频文件超过 20 MB 上限' }
    }
    const ext = path.extname(target).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.wav': 'audio/wav',
      '.mp3': 'audio/mpeg',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
    }
    const mime = mimeMap[ext] || 'audio/wav'
    const buf = fs.readFileSync(target)
    return { ok: true, duration: dur, mime, audioBase64: buf.toString('base64') }
  })
  ipcMain.handle('dhvw:clipRefAudio', (_e, filePath: string, seconds = 8.5, ttsBackendDir?: string) => {
    const target = String(filePath ?? '').trim()
    if (!target || !fs.existsSync(target)) return { ok: false, error: '音频文件不存在' }
    const py = resolveTtsPython(ttsBackendDir)
    if (!py) return { ok: false, error: '未找到 GPT-SoVITS Python 运行时，无法裁剪音频' }
    const outDir = path.join(dataDir, 'voice')
    fs.mkdirSync(outDir, { recursive: true })
    const stem = path.basename(target, path.extname(target)).replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')
    const outPath = path.join(outDir, `${stem}_clip${Math.round(seconds)}s.wav`)
    const script =
      "import sys, soundfile as sf; data, sr = sf.read(sys.argv[1]); n = int(float(sys.argv[3]) * sr); sf.write(sys.argv[2], data[:n], sr, subtype='PCM_16'); print(round(len(data[:n]) / sr, 3))"
    const res = spawnSync(py, ['-c', script, target, outPath, String(seconds)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    })
    if (res.status !== 0 || !fs.existsSync(outPath)) {
      return { ok: false, error: (res.stderr || res.stdout || '音频裁剪失败').trim().slice(-300) }
    }
    const dur = Number(res.stdout.trim()) || seconds
    const audioBase64 = fs.readFileSync(outPath).toString('base64')
    return { ok: true, path: outPath, duration: dur, mime: 'audio/wav', audioBase64 }
  })
  ipcMain.handle(
    'dhvw:testTts',
    async (
      _e,
      req: { refAudioPath: string; refText: string; refLang: string; textLang: string; sampleText?: string },
    ) => {
      const refAudioPath = String(req?.refAudioPath ?? '').trim()
      if (!refAudioPath) return { ok: false, error: '请先选择参考音色音频路径' }
      if (!fs.existsSync(refAudioPath)) return { ok: false, error: `参考音频不存在：${refAudioPath}` }
      const duration = probeAudioDuration(refAudioPath)
      if (duration !== null && (duration < 3 || duration > 10)) {
        return {
          ok: false,
          duration,
          canClip: duration > 10,
          error: `参考音频时长 ${duration.toFixed(2)}s，超出 GPT-SoVITS 要求的 3~10 秒范围`,
        }
      }
      const promptText = String(req.refText ?? '').trim()
      if (!promptText) {
        return {
          ok: false,
          duration,
          error: '请先填写与当前参考音频一致的「参考音色文本」（可点“试听参考原音”直接播放核对内容）',
        }
      }
      const tts = supervisor?.snapshots.find((w) => w.id === 'tts')
      if (!tts?.port || tts.state !== 'running') {
        return { ok: false, duration, error: 'TTS 服务尚未运行（请先启动语音合成服务）' }
      }
      const params = new URLSearchParams({
        text: (req.sampleText || '你好呀，我是你的数字伙伴，现在测试一下新的音色效果。').trim(),
        text_lang: (req.textLang || 'zh').trim(),
        ref_audio_path: refAudioPath,
        prompt_lang: (req.refLang || 'zh').trim(),
        prompt_text: promptText,
        text_split_method: 'cut5',
        batch_size: '1',
        media_type: 'wav',
        streaming_mode: 'false',
      })
      try {
        const res = await fetch(`http://127.0.0.1:${tts.port}/tts?${params.toString()}`, {
          signal: AbortSignal.timeout(45_000),
        })
        if (!res.ok) {
          const text = await res.text()
          let detail = text
          try {
            const j = JSON.parse(text) as { Exception?: string; message?: string }
            detail = j.Exception || j.message || text
          } catch {}
          return {
            ok: false,
            duration,
            canClip: duration !== null && duration > 10,
            error: `TTS 服务返回 ${res.status}：${detail}`,
          }
        }
        const buf = Buffer.from(await res.arrayBuffer())
        return {
          ok: true,
          duration,
          bytes: buf.length,
          audioBase64: buf.toString('base64'),
        }
      } catch (err) {
        return { ok: false, duration, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
  ipcMain.handle('dhvw:restartHost', async () => {
    if (!supervisor) return { ok: false }
    await supervisor.stop('manual-restart')
    supervisor.start()
    return { ok: true }
  })
}

/** 统一请求编排器 HTTP JSON 接口，避免各个 IPC 处理器重复 fetch/超时逻辑。 */
function resolveTtsPython(overrideDir?: string): string {
  const dir = (overrideDir?.trim() || config.sidecars.tts?.cwd || config.tts.backendDir || '').trim()
  if (!dir) return ''
  const py = path.join(dir, 'runtime', 'python.exe')
  return fs.existsSync(py) ? py : ''
}

function probeAudioDuration(filePath: string, overrideTtsDir?: string): number | null {
  const py = resolveTtsPython(overrideTtsDir)
  if (!py) return null
  const res = spawnSync(py, ['-c', 'import sys, soundfile as sf; print(round(sf.info(sys.argv[1]).duration, 3))', filePath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 8000,
  })
  if (res.status !== 0) return null
  const val = Number(res.stdout.trim())
  return Number.isFinite(val) ? val : null
}

async function orchJson<T extends Record<string, unknown>>(
  urlPath: string,
  init?: RequestInit,
  timeoutMs = 5000,
): Promise<T & { ok: boolean; error?: string }> {
  if (!orchestratorPort) return { ok: false, error: '编排器尚未就绪' } as T & { ok: boolean; error?: string }
  try {
    const res = await fetch(`http://127.0.0.1:${orchestratorPort}${urlPath}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = (await res.json()) as T & { ok?: boolean; error?: string }
    return { ...data, ok: data.ok ?? res.ok }
  } catch (e) {
    return { ok: false, error: String(e) } as T & { ok: boolean; error?: string }
  }
}

/** 换模型或人设后：按需同步模型进 OLVT，重写 conf.yaml 并重启 OLVT（conf 只在启动时读一次）。 */
function syncOlvtConfig(withModelSync: boolean): void {
  const dir = resolveOlvtDir(config.sidecars.olvt?.cwd || config.olvt.dir)
  const snapshots = supervisor?.snapshots ?? []
  const olvt = snapshots.find((w) => w.id === 'olvt')
  const tts = snapshots.find((w) => w.id === 'tts')
  if (withModelSync) log('info', 'live2d', '角色模型切换', { model: live2dModel?.id, olvtDir: dir || undefined })
  if (!dir) {
    if (withModelSync) log('warn', 'live2d', 'OLVT 目录未就绪，模型只在本机舞台生效')
    return
  }
  if (withModelSync && live2dModel) syncOlvtModel(dir, live2dModel)
  if (!olvt?.port) {
    log('warn', 'olvt', 'OLVT 未运行，下次启动时应用最新配置')
    return
  }
  prepareOlvt({
    dir,
    port: olvt.port,
    live2dModel: live2dModel?.id ?? config.live2d.model,
    characterName: config.olvt.characterName,
    humanName: config.olvt.humanName,
    personaPrompt: config.olvt.personaPrompt,
    proxyUrl: orchestratorPort ? `http://127.0.0.1:${orchestratorPort}/dhvw/llm/v1` : undefined,
    llm: { ...config.llm, apiKey: effectiveApiKey(config.llm.baseUrl) || 'missing-api-key' },
    tts: { apiUrl: `http://127.0.0.1:${tts?.port ?? 0}/tts`, ...config.tts },
    asr: { enabled: config.asr.enabled, ...asrModelPaths(config.asr.enabled) },
  })
  supervisor?.send({ cmd: 'restart', service: 'olvt' })
}

let live2dUrl: string | null = null
let armPreviewUrl: string | null = null
const bundledLive2dRoot = (): string =>
  path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'live2d')
/** 打开现用 Live2D 模型目录：优先 OLVT 组件的 live2d-models（直接对 OLVT 生效且含当前角色），未就绪时退回随包 models */
const activeLive2dDir = (): string => {
  const olvtDir = resolveOlvtDir(config.sidecars.olvt?.cwd || config.olvt.dir)
  if (olvtDir) return path.join(olvtDir, 'live2d-models')
  return live2dModel ? path.dirname(live2dModel.dir) : path.join(bundledLive2dRoot(), 'models')
}
const live2dModelsView = (): Live2dModelView[] =>
  listLive2dModels(live2dRoots).map((m) => ({ id: m.id, source: m.source, file: m.file }))

/** 模型库根：随包资源 → OLVT 组件自带（两者扫描结构一致） */
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

  const live2dRoot = bundledLive2dRoot()
  const olvtRootDir = resolveOlvtDir(config.sidecars.olvt?.cwd || config.olvt.dir)
  const legacyUserModelsDir = path.join(dataDir, 'live2d-models')
  live2dRoots = [
    { root: path.join(live2dRoot, 'models'), source: 'bundled' as const },
    ...(olvtRootDir ? [{ root: path.join(olvtRootDir, 'live2d-models'), source: 'olvt' as const }] : []),
    ...(fs.existsSync(legacyUserModelsDir) ? [{ root: legacyUserModelsDir, source: 'olvt' as const }] : []),
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
    armPreviewUrl = await startArmPreviewServer(armWww, () => orchestratorPort, () => gateway?.caPem ?? '').catch((err) => {
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
    llama: config.ports.llama,
  }
  const ports = await Promise.all(
    SERVICE_CATALOG.map(async (svc, i) => {
      const want = fixed[svc.id] ?? 0
      return want > 0 && (await isPortFree(want)) ? want : (dynamic[i] ?? 0)
    }),
  )
  allocatedPorts = ports
  const portOf = (id: string): number => ports[SERVICE_CATALOG.findIndex((s) => s.id === id)] ?? 0
  const olvtDir = olvtRootDir
  const olvtPort = portOf('olvt')
  olvtServicePort = olvtPort
  llamaServicePort = portOf('llama')
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
      proxyUrl: `http://127.0.0.1:${portOf('orchestrator')}/dhvw/llm/v1`,
      llm: { ...config.llm, apiKey: effectiveApiKey(config.llm.baseUrl) || 'missing-api-key' },
      tts: { apiUrl: `http://127.0.0.1:${portOf('tts')}/tts`, ...config.tts },
      asr: { enabled: config.asr.enabled, ...asr },
    })
  } else {
    log('warn', 'olvt', '未找到 OLVT 后端目录，使用占位 worker', {
      component: 'olvt',
      hint: '在组件面板下载 OLVT，或在设置里指定已有目录',
    })
  }
  const ttsDir = (config.sidecars.tts?.cwd || config.tts.backendDir || '').trim()
  if (ttsDir && !fs.existsSync(ttsDir)) {
    log('warn', 'tts', '设置的语音合成目录不存在', { dir: ttsDir })
  }
  const services = buildRuntimeServices(ports)
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
  const previewPort = getArmPreviewPort()
  gatewayTargets = [
    { name: 'olvt', port: portOf('olvt'), wsPath: '/client-ws' },
    { name: 'orchestrator', port: portOf('orchestrator'), wsPath: '/dhvw' },
    { name: 'waketrace', port: portOf('waketrace') },
    { name: 'llm', port: portOf('llama') },
    ...(previewPort > 0 ? [{ name: 'arm', port: previewPort }] : []),
  ]
  gateway = new Gateway({ port: config.gateway.port, targets: gatewayTargets })
  if (config.gateway.enabled) gateway.start()

  registerIpc()
  createWindow()
  createTray({
    onShow: showWindow,
    onQuit: () => app.quit(),
    onRestartHost: () => {
      void supervisor?.stop('tray-restart').then(() => supervisor?.start())
    },
  })

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
