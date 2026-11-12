import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { dataDir } from './paths'
import { log } from './logger'

export interface ShellConfig {
  pythonPath: string
  autoLaunch: boolean
  window: { width: number; height: number }
  llm: { baseUrl: string; model: string; temperature: number }
  /** 固定端口（0 = 自动分配），用于对接外部工具或防火墙放行 */
  ports: { olvt: number; tts: number }
  asr: { enabled: boolean }
  /** 把占位 sidecar 换成真实进程：id -> 可执行文件 + 参数（{port} 替换为分配端口） */
  sidecars: Record<string, { command: string[]; cwd?: string; env?: Record<string, string> }>
  /** 组件下载地址覆盖（企业镜像/离线包），不填则用内置镜像列表 */
  componentUrls: Record<string, string[]>
  /** 组件依赖安装使用的 PyPI 镜像 */
  pipIndex: string
  services: Record<string, { enabled: boolean }>
}

const DEFAULTS: ShellConfig = {
  pythonPath: '',
  autoLaunch: false,
  window: { width: 1020, height: 720 },
  llm: { baseUrl: 'https://codex.mintcat.work', model: 'deepseek-v4.1-flash', temperature: 0.7 },
  ports: { olvt: 0, tts: 0 },
  asr: { enabled: true },
  sidecars: {},
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
