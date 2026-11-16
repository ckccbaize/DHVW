import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { dataDir } from './paths'
import { log } from './logger'

export interface ShellConfig {
  pythonPath: string
  autoLaunch: boolean
  window: { width: number; height: number }
  llm: { baseUrl: string; model: string; temperature: number; protocol: 'openai-compatible' | 'anthropic' }
  /** 固定端口（0 = 自动分配），用于对接外部工具或防火墙放行 */
  ports: { olvt: number; tts: number; orchestrator: number }
  asr: { enabled: boolean }
  /** OLVT 后端：dir 为空时用组件目录；其余项直接写进生成的 conf.yaml */
  olvt: { dir: string; characterName: string; humanName: string; personaPrompt: string }
  /** GPT-SoVITS：backendDir 为本机后端目录（含 api_v2.py 与 runtime/python.exe），留空则用占位 worker */
  tts: { backendDir: string; refAudioPath: string; refText: string; refLang: string; textLang: string }
  /** 局域网网关：自签证书 + HTTPS/WSS 反代，端口固定便于设备记住地址 */
  gateway: { enabled: boolean; port: number }
  /** 把占位 sidecar 换成真实进程：id -> 可执行文件 + 参数（{port} 替换为分配端口） */
  sidecars: Record<string, { command: string[]; cwd?: string; env?: Record<string, string> }>
  /** 组件下载地址覆盖（企业镜像/离线包），不填则用内置镜像列表 */
  componentUrls: Record<string, string[]>
  /** 角色形象：PC 舞台与 OLVT 共用同一个 Live2D 模型（模型 id，见 live2d-models.ts） */
  live2d: { model: string }
  /** 地图推送：false = 生成后必须在产出验收里手动「提交 ARM 侧」；true = 核验通过即自动推 */
  scene: { autoPush: boolean }
  /** 主动说话（仅 OLVT）：显现模式下由编排器按节奏驱动 */
  proactive: {
    enabled: boolean
    idleSeconds: number
    gapSeconds: number
    maxGapSeconds: number
    dailyMax: number
    quietStart: string
    quietEnd: string
  }
  /** 世界模式增强：联动激活 ARM 侧 QQ 官方 Bot */
  boost: { enabled: boolean }
  /** QQ 官方 Bot 基础配置（clientSecret 由 secret.ts DPAPI 加密另存） */
  qqBot: {
    appId: string
    sandbox: boolean
    ownerOpenId: string
    proactive: boolean
    stickerEagerness: number
  }
  /** 组件依赖安装使用的 PyPI 镜像 */
  pipIndex: string
  services: Record<string, { enabled: boolean }>
}

const DEFAULTS: ShellConfig = {
  pythonPath: '',
  autoLaunch: false,
  window: { width: 1020, height: 720 },
  llm: { baseUrl: 'https://codex.mintcat.work', model: '', temperature: 0.7, protocol: 'openai-compatible' },
  ports: { olvt: 0, tts: 0, orchestrator: 8877 },
  asr: { enabled: true },
  olvt: {
    dir: '',
    characterName: '小仓',
    humanName: '主人',
    personaPrompt: '你是住在数字人虚拟仓里的小仓，语气自然、口语化，回答简短。不要使用 Markdown，不要输出括号里的动作描写。',
  },
  tts: { backendDir: '', refAudioPath: '', refText: '', refLang: 'ja', textLang: 'zh' },
  gateway: { enabled: true, port: 8443 },
  sidecars: {},
  live2d: { model: 'mao_pro' },
  scene: { autoPush: false },
  proactive: {
    enabled: true,
    idleSeconds: 150,
    gapSeconds: 240,
    maxGapSeconds: 1200,
    dailyMax: 10,
    quietStart: '23:30',
    quietEnd: '07:30',
  },
  boost: { enabled: false },
  qqBot: { appId: '', sandbox: true, ownerOpenId: '', proactive: true, stickerEagerness: 2 },
  componentUrls: {},
  pipIndex: 'https://mirrors.aliyun.com/pypi/simple',
  services: {},
}

export const configDbFile = path.join(dataDir, 'config.db')

let db: DatabaseSync | null = null

function open(): DatabaseSync | null {
  try {
    const conn = new DatabaseSync(configDbFile)
    conn.exec(`
      create table if not exists kv (
        key text primary key,
        value text not null
      );
      create table if not exists meta (
        key text primary key,
        value text not null
      );
    `)
    const row = conn.prepare('select value from meta where key = ?').get('schema_version') as { value?: string } | undefined
    if (!row) conn.prepare('insert into meta(key, value) values(?, ?)').run('schema_version', '1')
    db = conn
    return conn
  } catch (err) {
    log('error', 'config', '配置库打开失败', { error: String(err), file: configDbFile })
    return null
  }
}

export function loadConfig(): ShellConfig {
  const conn = db ?? open()
  if (!conn) return structuredClone(DEFAULTS)
  try {
    const row = conn.prepare('select value from kv where key = ?').get('shell') as { value?: string } | undefined
    if (!row?.value) return structuredClone(DEFAULTS)
    const raw = JSON.parse(row.value) as Partial<ShellConfig>
    return {
      ...DEFAULTS,
      ...raw,
      window: { ...DEFAULTS.window, ...raw.window },
      llm: { ...DEFAULTS.llm, ...raw.llm },
      ports: { ...DEFAULTS.ports, ...raw.ports },
      asr: { ...DEFAULTS.asr, ...raw.asr },
      olvt: { ...DEFAULTS.olvt, ...raw.olvt },
      tts: { ...DEFAULTS.tts, ...raw.tts },
      gateway: { ...DEFAULTS.gateway, ...raw.gateway },
      live2d: { ...DEFAULTS.live2d, ...raw.live2d },
      scene: { ...DEFAULTS.scene, ...raw.scene },
      proactive: { ...DEFAULTS.proactive, ...raw.proactive },
      boost: { ...DEFAULTS.boost, ...raw.boost },
      qqBot: { ...DEFAULTS.qqBot, ...raw.qqBot },
      sidecars: { ...DEFAULTS.sidecars, ...raw.sidecars },
      componentUrls: { ...DEFAULTS.componentUrls, ...raw.componentUrls },
    }
  } catch (err) {
    log('warn', 'config', '配置读取失败，使用默认值', { error: String(err) })
    return structuredClone(DEFAULTS)
  }
}

export function saveConfig(cfg: ShellConfig): void {
  const conn = db ?? open()
  if (!conn) throw new Error('配置库不可用')
  conn.prepare('insert into kv(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(
    'shell',
    JSON.stringify(cfg),
  )
}
