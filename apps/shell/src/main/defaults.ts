import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { CharacterCardData } from '../shared/types'
import { dataDir } from './paths'
import { log } from './logger'

/**
 * 随包默认内容（`resources/defaults`，只读）：
 *   persona/deepseek.json    默认角色人设卡与 OLVT 人设提示词
 *   memory/l0.json           默认 L0 记忆（只带 L0，历史记忆一律不带）
 *   characters/<id>/         默认像素角色图集（已扩展 22 动作）
 *   assets-char/             内置精灵原图（鲸鱼娘 ojj_sheet）
 *   scenes/                  地图工具链的参考 spec 与动作表
 *
 * 用户数据目录里没有时才拷一份，绝不覆盖已有内容；每一步各有自己的 marker，
 * 失败的下次启动会重试，不会因为一次失败就永久跳过。
 */
export function defaultsRoot(): string {
  return path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'defaults')
}

export interface PersonaSeed {
  characterName: string
  humanName: string
  personaPrompt: string
  personaCard: CharacterCardData | null
}

export interface MemorySeedFact {
  text: string
  tier: string
  conf: number
}

/** 默认像素角色 id（与 defaults/characters 下的目录同名） */
export const DEFAULT_PIXEL_CHARACTER = 'deepseek-54e633'

/** 默认 Live2D 模型 id（与 resources/live2d/models 下的目录同名） */
export const DEFAULT_LIVE2D_MODEL = 'DeepSeek'

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function mark(name: string, payload: Record<string, unknown>): void {
  const file = path.join(dataDir, 'data', `.seeded-${name}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...payload }), 'utf8')
}

/** 默认人设；缺文件时返回 null，调用方退回内置文案 */
export function readDefaultPersona(): PersonaSeed | null {
  const raw = readJson<Partial<PersonaSeed>>(path.join(defaultsRoot(), 'persona', 'deepseek.json'))
  if (!raw || typeof raw.characterName !== 'string' || typeof raw.personaPrompt !== 'string') return null
  return {
    characterName: raw.characterName,
    humanName: typeof raw.humanName === 'string' && raw.humanName ? raw.humanName : '主人',
    personaPrompt: raw.personaPrompt,
    personaCard: raw.personaCard ?? null,
  }
}

export function readDefaultL0(): MemorySeedFact[] {
  const raw = readJson<{ facts?: MemorySeedFact[] }>(path.join(defaultsRoot(), 'memory', 'l0.json'))
  const facts = Array.isArray(raw?.facts) ? raw!.facts! : []
  return facts
    .filter((f) => f && typeof f.text === 'string' && f.text.trim())
    .map((f) => ({ text: f.text.trim(), tier: 'L0', conf: Number(f.conf) || 0.95 }))
}

/**
 * 把随包默认像素角色拷进用户数据目录。只在首次运行时执行：
 * 老用户已有自己的角色与场景，塞进一个新的像素角色只会造成困惑。
 */
export function seedCharacters(): { copied: string[]; skipped: string[] } {
  const copied: string[] = []
  const skipped: string[] = []
  if (fs.existsSync(path.join(dataDir, 'data', '.seeded-characters'))) return { copied, skipped }
  const src = path.join(defaultsRoot(), 'characters')
  const dest = path.join(dataDir, 'data', 'characters')
  let entries: string[] = []
  try {
    entries = fs.readdirSync(src, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    log('warn', 'seed', '随包默认像素角色缺失', { dir: src })
    return { copied, skipped }
  }
  fs.mkdirSync(dest, { recursive: true })
  // 数据目录里已经有任何像素角色 = 老用户，不再塞新的默认角色
  const existing = fs.readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory())
  if (existing.length) {
    mark('characters', { skipped: 'existing-characters', ids: existing.map((e) => e.name).slice(0, 20) })
    log('info', 'seed', '已有像素角色，跳过默认角色拷贝', { count: existing.length })
    return { copied, skipped }
  }
  for (const id of entries) {
    const target = path.join(dest, id)
    if (fs.existsSync(target)) {
      skipped.push(id)
      continue
    }
    try {
      fs.cpSync(path.join(src, id), target, { recursive: true })
      copied.push(id)
    } catch (err) {
      log('warn', 'seed', '默认像素角色拷贝失败', { id, error: String(err) })
    }
  }
  if (copied.length || skipped.length) mark('characters', { copied, skipped })
  if (copied.length) log('info', 'seed', '已落地默认像素角色', { copied })
  return { copied, skipped }
}

/**
 * 默认 L0 记忆：只在「从未写过记忆」的干净数据目录里写一次。
 * 老用户的 memory.db 已有内容，任何自动写入都会污染他们自己的记忆；
 * 判定用编排器自己的 stats（库为空且没写过），不猜文件是否存在。
 * 写入走 `/dhvw/facts` 正常路径，避免 FTS/向量索引与正文不一致。
 */
export async function seedL0Memory(port: number, tries = 60): Promise<void> {
  if (port <= 0 || fs.existsSync(path.join(dataDir, 'data', '.seeded-memory-l0'))) return
  const facts = readDefaultL0()
  if (!facts.length) {
    log('warn', 'seed', '随包默认 L0 记忆缺失')
    return
  }
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/dhvw/memory/stats`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const stats = (await res.json()) as { total?: number }
      // 已有任意记忆 = 老用户，直接打标记退出，绝不覆盖
      if (Number(stats.total) > 0) {
        mark('memory-l0', { skipped: 'existing-memory', total: stats.total })
        log('info', 'seed', '已有记忆，跳过默认 L0 写入', { total: stats.total })
        return
      }
      const write = await fetch(`http://127.0.0.1:${port}/dhvw/facts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ facts }),
        signal: AbortSignal.timeout(8000),
      })
      if (!write.ok) throw new Error(`HTTP ${write.status}`)
      const body = (await write.json()) as { accepted?: string[]; merged?: string[] }
      mark('memory-l0', { accepted: body.accepted?.length ?? 0, merged: body.merged?.length ?? 0 })
      log('info', 'seed', '已写入默认 L0 记忆', {
        accepted: body.accepted?.length ?? 0,
        merged: body.merged?.length ?? 0,
      })
      return
    } catch {
      // 编排器还在启动（依赖安装可能要几分钟），1 s 后重试
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  log('warn', 'seed', '编排器未就绪，默认 L0 记忆下次启动再写')
}
