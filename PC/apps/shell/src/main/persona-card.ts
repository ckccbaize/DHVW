import * as zlib from 'node:zlib'
import type { CharacterCardData, PersonaCardImportResult } from '../shared/types'

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function makeChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.allocUnsafe(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcInput = Buffer.concat([typeBuf, data])
  const crcBuf = Buffer.allocUnsafe(4)
  crcBuf.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([lenBuf, crcInput, crcBuf])
}

/** 从 PNG Buffer 读取全部 chunk（校验 PNG 文件头）。 */
function readPngChunks(buf: Buffer): Array<{ type: string; data: Buffer }> {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('不是有效的 PNG 图片文件')
  }
  const chunks: Array<{ type: string; data: Buffer }> = []
  let offset = 8
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii')
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buf.length) {
      throw new Error(`PNG 数据块 ${type} 长度越界`)
    }
    chunks.push({ type, data: buf.subarray(dataStart, dataEnd) })
    offset = dataEnd + 4
    if (type === 'IEND') break
  }
  return chunks
}

function decodeTextChunk(data: Buffer): { key: string; value: string } | null {
  const nul = data.indexOf(0)
  if (nul <= 0) return null
  const key = data.subarray(0, nul).toString('latin1')
  const value = data.subarray(nul + 1).toString('utf8')
  return { key, value }
}

function decodeItxtChunk(data: Buffer): { key: string; value: string } | null {
  const kEnd = data.indexOf(0)
  if (kEnd <= 0 || kEnd + 3 > data.length) return null
  const key = data.subarray(0, kEnd).toString('latin1')
  const compFlag = data[kEnd + 1]
  // compMethod at kEnd + 2
  let pos = data.indexOf(0, kEnd + 3) // language tag
  if (pos < 0) return null
  pos = data.indexOf(0, pos + 1) // translated keyword
  if (pos < 0) return null
  const raw = data.subarray(pos + 1)
  const textBuf = compFlag === 1 ? zlib.inflateSync(raw) : raw
  return { key, value: textBuf.toString('utf8') }
}

function decodeZtxtChunk(data: Buffer): { key: string; value: string } | null {
  const kEnd = data.indexOf(0)
  if (kEnd <= 0 || kEnd + 2 > data.length) return null
  const key = data.subarray(0, kEnd).toString('latin1')
  const textBuf = zlib.inflateSync(data.subarray(kEnd + 2))
  return { key, value: textBuf.toString('utf8') }
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  return typeof v === 'string' ? v.trim() : ''
}

/** 归一化 SillyTavern V1/V2/V3 JSON 为统一的 CharacterCardData。 */
export function normalizeCharacterCard(rawInput: unknown, avatarDataUrl = ''): {
  card: CharacterCardData
  specDetected: string
  extraSeedFacts: Array<{ text: string; importance: number }>
} {
  if (!rawInput || typeof rawInput !== 'object') {
    throw new Error('角色卡 JSON 格式无效')
  }
  const root = rawInput as Record<string, unknown>
  const specRaw = typeof root.spec === 'string' ? root.spec : ''
  const nested = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : null
  const src = nested || root
  const specDetected =
    specRaw === 'chara_card_v3'
      ? 'chara_card_v3'
      : specRaw === 'chara_card_v2' || nested
        ? 'chara_card_v2'
        : 'chara_card_v1'

  const tagsRaw = Array.isArray(src.tags) ? src.tags : []
  const tags = tagsRaw.map((t) => String(t).trim()).filter(Boolean)

  const sourcesRaw = Array.isArray(src.sources)
    ? src.sources
    : root.extensions && typeof root.extensions === 'object' && Array.isArray((root.extensions as Record<string, unknown>).dhvw_sources)
      ? ((root.extensions as Record<string, unknown>).dhvw_sources as unknown[])
      : []
  const sources: Array<{ title: string; url: string }> = []
  for (const s of sourcesRaw) {
    if (s && typeof s === 'object') {
      const title = String((s as Record<string, unknown>).title || '').trim()
      const url = String((s as Record<string, unknown>).url || '').trim()
      if (url) sources.push({ title: title || url, url })
    }
  }

  const card: CharacterCardData = {
    name: strField(src, 'name') || strField(root, 'name') || '未命名角色',
    description: strField(src, 'description') || strField(root, 'description'),
    personality: strField(src, 'personality') || strField(root, 'personality'),
    scenario: strField(src, 'scenario') || strField(root, 'scenario'),
    first_mes: strField(src, 'first_mes') || strField(root, 'first_mes'),
    mes_example: strField(src, 'mes_example') || strField(root, 'mes_example'),
    system_prompt: strField(src, 'system_prompt'),
    post_history_instructions: strField(src, 'post_history_instructions'),
    creator_notes: strField(src, 'creator_notes') || strField(src, 'creatorcomment'),
    tags,
    creator: strField(src, 'creator') || 'DHVW',
    character_version: strField(src, 'character_version') || '1.0',
    spec: specDetected === 'chara_card_v3' ? 'chara_card_v3' : 'chara_card_v2',
    ...(avatarDataUrl ? { avatarDataUrl } : {}),
    ...(sources.length ? { sources } : {}),
  }

  const extraSeedFacts = cardToSeedL0Facts(card)
  return { card, specDetected, extraSeedFacts }
}

/** 将 SillyTavern 字段编译为适合 OLVT + TTS 语音播报的角色人设 Prompt。 */
export function compilePersonaPrompt(card: CharacterCardData, humanName = '主人'): string {
  const charName = card.name.trim() || '小仓'
  const userLabel = humanName.trim() || '主人'
  const sub = (s: string) =>
    s
      .replace(/\{\{char\}\}|<BOT>/gi, charName)
      .replace(/\{\{user\}\}|<USER>/gi, userLabel)
      .trim()

  const blocks: string[] = []
  if (card.system_prompt) {
    blocks.push(sub(card.system_prompt))
  } else {
    blocks.push(
      `你是${charName}，正在与${userLabel}进行自然实时语音陪伴对话。请始终保持角色人设，语气口语化、自然亲切，每次回复简短明确（通常1到3句话）。不要使用 Markdown 格式，不要输出括号里的动作或心理描写。每次换不同开头接话，口癖和特殊后缀只偶尔点缀；对方聊日常人或事时顺着接下去，不强行拉回世界设定。`,
    )
  }
  if (card.description) blocks.push(`【角色设定】\n${sub(card.description)}`)
  if (card.personality) blocks.push(`【性格与说话风格】\n${sub(card.personality)}`)
  if (card.scenario) blocks.push(`【所处情景与日常】\n${sub(card.scenario)}`)
  if (card.mes_example) blocks.push(`【口吻示例】\n${sub(card.mes_example)}`)
  if (card.post_history_instructions) blocks.push(`【表达约束】\n${sub(card.post_history_instructions)}`)
  return blocks.join('\n\n')
}

/** 从酒馆角色卡抽取建议的 L0 核心锚点记忆（最多 6 条），方便导入后一键写入记忆库。 */
export function cardToSeedL0Facts(card: CharacterCardData): Array<{ text: string; importance: number }> {
  const out: Array<{ text: string; importance: number }> = []
  const seen = new Set<string>()
  const add = (text: string, importance = 0.9) => {
    const cleaned = text.replace(/\s+/g, ' ').trim()
    if (!cleaned || cleaned.length < 4 || seen.has(cleaned)) return
    seen.add(cleaned)
    out.push({ text: cleaned.slice(0, 120), importance })
  }
  if (card.name) {
    add(`角色身份：我的名字是${card.name}${card.tags.length ? `（${card.tags.slice(0, 4).join('、')}）` : ''}`, 1.0)
  }
  const splitSentences = (block: string) =>
    block
      .split(/[。！？\n；]+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6 && s.length <= 90 && !s.includes('{{'))

  for (const s of splitSentences(card.personality).slice(0, 2)) {
    add(`性格与口癖：${s}`, 0.92)
  }
  for (const s of splitSentences(card.description).slice(0, 2)) {
    add(`核心设定：${s}`, 0.9)
  }
  for (const s of splitSentences(card.scenario).slice(0, 1)) {
    add(`背景情景：${s}`, 0.88)
  }
  return out.slice(0, 6)
}

/** 解析 SillyTavern 导出的 PNG 角色卡（支持 tEXt / iTXt / zTXt 的 chara 与 ccv3 块）。 */
export function parseTavernPng(pngBuffer: Buffer): PersonaCardImportResult {
  const chunks = readPngChunks(pngBuffer)
  let ccv3Json: string | null = null
  let charaJson: string | null = null

  for (const chunk of chunks) {
    let decoded: { key: string; value: string } | null = null
    try {
      if (chunk.type === 'tEXt') decoded = decodeTextChunk(chunk.data)
      else if (chunk.type === 'iTXt') decoded = decodeItxtChunk(chunk.data)
      else if (chunk.type === 'zTXt') decoded = decodeZtxtChunk(chunk.data)
    } catch {
      continue
    }
    if (!decoded) continue
    const k = decoded.key.toLowerCase()
    if (k === 'ccv3') {
      ccv3Json = Buffer.from(decoded.value.trim(), 'base64').toString('utf8')
    } else if (k === 'chara') {
      charaJson = Buffer.from(decoded.value.trim(), 'base64').toString('utf8')
    }
  }

  const payloadStr = ccv3Json || charaJson
  if (!payloadStr) {
    return { ok: false, error: '该 PNG 中未检测到酒馆角色卡数据块（chara / ccv3）' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(payloadStr)
  } catch {
    return { ok: false, error: 'PNG 中的角色卡 Base64 JSON 解析失败' }
  }
  const avatarDataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`
  const { card, specDetected, extraSeedFacts } = normalizeCharacterCard(parsed, avatarDataUrl)
  return {
    ok: true,
    card,
    compiledPrompt: compilePersonaPrompt(card),
    suggestedL0: extraSeedFacts,
    specDetected,
  }
}

/** 解析 JSON 格式酒馆角色卡。 */
export function parseTavernJson(jsonText: string): PersonaCardImportResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    return { ok: false, error: 'JSON 文件格式无效' }
  }
  const { card, specDetected, extraSeedFacts } = normalizeCharacterCard(parsed)
  return {
    ok: true,
    card,
    compiledPrompt: compilePersonaPrompt(card),
    suggestedL0: extraSeedFacts,
    specDetected,
  }
}

/** 构建标准的 1x1 占位 PNG（当尚未上传立绘封面时用于导出酒馆 PNG）。 */
function fallbackPngBuffer(): Buffer {
  const ihdr = Buffer.allocUnsafe(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  // 2x2 warm cel cream pixels
  const raw = Buffer.from([
    0, 250, 246, 238, 255, 250, 246, 238, 255,
    0, 240, 212, 168, 255, 240, 212, 168, 255,
  ])
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([PNG_SIG, makeChunk('IHDR', ihdr), makeChunk('IDAT', idat), makeChunk('IEND', Buffer.alloc(0))])
}

/** 将 CharacterCardData 序列化为 SillyTavern V2 JSON 对象。 */
export function toSillyTavernV2Json(card: CharacterCardData): Record<string, unknown> {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: card.name,
      description: card.description,
      personality: card.personality,
      scenario: card.scenario,
      first_mes: card.first_mes,
      mes_example: card.mes_example,
      creator_notes: card.creator_notes,
      system_prompt: card.system_prompt,
      post_history_instructions: card.post_history_instructions,
      alternate_greetings: [],
      tags: card.tags || [],
      creator: card.creator || 'DHVW',
      character_version: card.character_version || '1.0',
      extensions: card.sources?.length ? { dhvw_sources: card.sources } : {},
    },
  }
}

/** 将 CharacterCardData 打包为兼容 SillyTavern 的 PNG 文件（保留底图并写入/替换 tEXt chara 块）。 */
export function buildTavernPng(card: CharacterCardData, basePng?: Buffer): Buffer {
  const sourcePng = basePng && basePng.length > 8 && basePng.subarray(0, 8).equals(PNG_SIG) ? basePng : fallbackPngBuffer()
  const chunks = readPngChunks(sourcePng).filter((c) => {
    if (c.type !== 'tEXt' && c.type !== 'iTXt' && c.type !== 'zTXt') return true
    const nul = c.data.indexOf(0)
    if (nul <= 0) return true
    const key = c.data.subarray(0, nul).toString('latin1').toLowerCase()
    return key !== 'chara' && key !== 'ccv3'
  })

  const v2Payload = JSON.stringify(toSillyTavernV2Json(card))
  const charaB64 = Buffer.from(v2Payload, 'utf8').toString('base64')
  const textData = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(charaB64, 'utf8')])
  const charaChunk = makeChunk('tEXt', textData)

  const out: Buffer[] = [PNG_SIG]
  let inserted = false
  for (const chunk of chunks) {
    if (chunk.type === 'IEND' && !inserted) {
      out.push(charaChunk)
      inserted = true
    }
    out.push(makeChunk(chunk.type, chunk.data))
    if (chunk.type === 'IHDR' && !inserted) {
      out.push(charaChunk)
      inserted = true
    }
  }
  if (!inserted) out.push(charaChunk)
  return Buffer.concat(out)
}
