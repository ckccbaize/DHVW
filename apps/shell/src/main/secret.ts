import { safeStorage } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { configDbFile } from './config'
import { log } from './logger'

/**
 * API Key 只以 DPAPI 加密后的密文落库（ADR-PC-013 后果）。
 * 明文不落盘、不进日志、不出主进程——渲染层只能拿到 hasKey 布尔值。
 */
const KEY = 'llm.apiKey'

let db: DatabaseSync | null = null

function open(): DatabaseSync | null {
  if (db) return db
  try {
    const conn = new DatabaseSync(configDbFile)
    conn.exec('create table if not exists secrets (key text primary key, value text not null)')
    db = conn
    return conn
  } catch (err) {
    log('error', 'secret', '密钥库打开失败', { error: String(err) })
    return null
  }
}

export function hasApiKey(): boolean {
  const conn = open()
  if (!conn) return false
  const row = conn.prepare('select value from secrets where key = ?').get(KEY) as { value?: string } | undefined
  return Boolean(row?.value)
}

export function saveApiKey(plain: string): { ok: boolean; error?: string } {
  const conn = open()
  if (!conn) return { ok: false, error: '密钥库不可用' }
  if (!plain.trim()) return { ok: false, error: '密钥为空' }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '系统加密不可用（DPAPI 未就绪）' }
  try {
    const cipher = safeStorage.encryptString(plain.trim()).toString('base64')
    conn
      .prepare('insert into secrets(key, value) values(?, ?) on conflict(key) do update set value = excluded.value')
      .run(KEY, cipher)
    log('info', 'secret', 'API Key 已更新', { length: plain.trim().length })
    return { ok: true }
  } catch (err) {
    log('error', 'secret', 'API Key 保存失败', { error: String(err) })
    return { ok: false, error: '加密保存失败' }
  }
}

/** 只在主进程内部使用（组装请求头），永不跨 IPC 返回明文 */
export function readApiKey(): string | null {
  const conn = open()
  if (!conn) return null
  const row = conn.prepare('select value from secrets where key = ?').get(KEY) as { value?: string } | undefined
  if (!row?.value) return null
  try {
    return safeStorage.decryptString(Buffer.from(row.value, 'base64'))
  } catch (err) {
    log('warn', 'secret', 'API Key 解密失败，按未配置处理', { error: String(err) })
    return null
  }
}

export function clearApiKey(): void {
  const conn = open()
  if (!conn) return
  conn.prepare('delete from secrets where key = ?').run(KEY)
  log('info', 'secret', 'API Key 已清除')
}
