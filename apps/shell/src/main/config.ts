import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { dataDir } from './paths'
import { log } from './logger'

export interface ShellConfig {
  pythonPath: string
  autoLaunch: boolean
  window: { width: number; height: number }
  llm: { baseUrl: string; model: string }
  services: Record<string, { enabled: boolean }>
}

const DEFAULTS: ShellConfig = {
  pythonPath: '',
  autoLaunch: false,
  window: { width: 1020, height: 720 },
  llm: { baseUrl: 'https://codex.mintcat.work', model: 'deepseek-v4.1-flash' },
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
