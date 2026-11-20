import { safeStorage } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { configDbFile } from './config'
import { log } from './logger'

/**
 * API Key 只以 DPAPI 加密后的密文落库（ADR-PC-013 后果）。
 * 明文不落盘、不进日志、不出主进程——渲染层只能拿到 hasKey 布尔值。
 */
const KEY = 'llm.apiKey'
const QQ_SECRET_KEY = 'qqBot.clientSecret'
const FEISHU_SECRET_KEY = 'feishuBot.appSecret'
const IMAGE_GEN_KEY = 'imageGen.apiKey'

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

function hasSecretByKey(key: string): boolean {
  const conn = open()
  if (!conn) return false
  const row = conn.prepare('select value from secrets where key = ?').get(key) as { value?: string } | undefined
  return Boolean(row?.value)
}

function saveSecretByKey(key: string, label: string, plain: string): { ok: boolean; error?: string } {
  const conn = open()
  if (!conn) return { ok: false, error: '密钥库不可用' }
  if (!plain.trim()) return { ok: false, error: '密钥为空' }
  if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: '系统加密不可用（DPAPI 未就绪）' }
  try {
    const cipher = safeStorage.encryptString(plain.trim()).toString('base64')
    conn
      .prepare('insert into secrets(key, value) values(?, ?) on conflict(key) do update set value = excluded.value')
      .run(key, cipher)
    log('info', 'secret', `${label} 已更新`, { length: plain.trim().length })
    return { ok: true }
  } catch (err) {
    log('error', 'secret', `${label} 保存失败`, { error: String(err) })
    return { ok: false, error: '加密保存失败' }
  }
}

function readSecretByKey(key: string, label: string): string | null {
  const conn = open()
  if (!conn) return null
  const row = conn.prepare('select value from secrets where key = ?').get(key) as { value?: string } | undefined
  if (!row?.value) return null
  try {
    return safeStorage.decryptString(Buffer.from(row.value, 'base64'))
  } catch (err) {
    log('warn', 'secret', `${label} 解密失败，按未配置处理`, { error: String(err) })
    return null
  }
}

function clearSecretByKey(key: string, label: string): void {
  const conn = open()
  if (!conn) return
  conn.prepare('delete from secrets where key = ?').run(key)
  log('info', 'secret', `${label} 已清除`)
}

export const hasApiKey = (): boolean => hasSecretByKey(KEY)
export const saveApiKey = (plain: string): { ok: boolean; error?: string } => saveSecretByKey(KEY, 'API Key', plain)
/** 只在主进程内部使用（组装请求头），永不跨 IPC 返回明文 */
export const readApiKey = (): string | null => readSecretByKey(KEY, 'API Key')
export const clearApiKey = (): void => clearSecretByKey(KEY, 'API Key')

export const hasQqSecret = (): boolean => hasSecretByKey(QQ_SECRET_KEY)
export const saveQqSecret = (plain: string): { ok: boolean; error?: string } =>
  saveSecretByKey(QQ_SECRET_KEY, 'QQ Bot Secret', plain)
export const readQqSecret = (): string | null => readSecretByKey(QQ_SECRET_KEY, 'QQ Bot Secret')
export const clearQqSecret = (): void => clearSecretByKey(QQ_SECRET_KEY, 'QQ Bot Secret')

export const hasFeishuSecret = (): boolean => hasSecretByKey(FEISHU_SECRET_KEY)
export const saveFeishuSecret = (plain: string): { ok: boolean; error?: string } =>
  saveSecretByKey(FEISHU_SECRET_KEY, '飞书 AppSecret', plain)
export const readFeishuSecret = (): string | null => readSecretByKey(FEISHU_SECRET_KEY, '飞书 AppSecret')
export const clearFeishuSecret = (): void => clearSecretByKey(FEISHU_SECRET_KEY, '飞书 AppSecret')

export const hasImageGenKey = (): boolean => hasSecretByKey(IMAGE_GEN_KEY)
export const saveImageGenKey = (plain: string): { ok: boolean; error?: string } =>
  saveSecretByKey(IMAGE_GEN_KEY, '生图模型 API Key', plain)
export const readImageGenKey = (): string | null => readSecretByKey(IMAGE_GEN_KEY, '生图模型 API Key')
export const clearImageGenKey = (): void => clearSecretByKey(IMAGE_GEN_KEY, '生图模型 API Key')
