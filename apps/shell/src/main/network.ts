import { net } from 'electron'
import type { LlmProtocol } from '../shared/types'

// 上游端点做过 UA 过滤：非浏览器 UA 直接 403，这里固定带浏览器 UA。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'

export interface ProbeResult {
  ok: boolean
  ms: number
  status?: number
  note?: string
}

/** 只探可达性与延迟，不携带密钥；401/403 也算“网络可达”。 */
export async function probeLlm(baseUrl: string, timeoutMs = 8000): Promise<ProbeResult> {
  const started = Date.now()
  let url: string
  try {
    url = new URL('/v1/models', baseUrl).toString()
  } catch (err) {
    return { ok: false, ms: 0, note: `地址无效：${String(err)}` }
  }
  try {
    const res = await net.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const ms = Date.now() - started
    const reachable = res.status < 500
    return {
      ok: reachable,
      status: res.status,
      ms,
      note: reachable ? (res.status === 200 ? '可达' : `可达（HTTP ${res.status}，需密钥）`) : `服务端异常 HTTP ${res.status}`,
    }
  } catch (err) {
    return { ok: false, ms: Date.now() - started, note: String(err) }
  }
}

/** 非对话模型（图像/向量/TTS）混在列表里只会干扰选择 */
const NON_CHAT = /(image|embed|tts|whisper|dall-e|moderation|rerank)/i

export interface ModelListResult {
  ok: boolean
  models: string[]
  error?: string
  /** 实际命中的列表地址，方便用户判断自己填的是根地址还是要带 /v1 */
  url?: string
}

function modelUrls(baseUrl: string): string[] {
  const trimmed = baseUrl.replace(/\/+$/, '')
  const urls = [`${trimmed}/v1/models`, `${trimmed}/models`]
  return [...new Set(urls)]
}

/**
 * 拉取模型列表：OpenAI 兼容走 Bearer，Anthropic 走 x-api-key。
 * 端点普遍过滤非浏览器 UA，与 probeLlm 用同一个 UA。
 */
export async function listModels(
  opts: { baseUrl: string; protocol: LlmProtocol; apiKey: string | null },
  timeoutMs = 20000,
): Promise<ModelListResult> {
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' }
  if (opts.apiKey) {
    if (opts.protocol === 'anthropic') {
      headers['x-api-key'] = opts.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.Authorization = `Bearer ${opts.apiKey}`
    }
  }
  const errors: string[] = []
  for (const url of modelUrls(opts.baseUrl)) {
    try {
      const res = await net.fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) {
        errors.push(`${url} -> HTTP ${res.status}`)
        continue
      }
      const body = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
      const ids = (body.data ?? []).map((m) => m.id ?? '').filter(Boolean)
      const alt = (body.models ?? []).map((m) => m.name ?? '').filter(Boolean)
      const all = ids.length ? ids : alt
      if (!all.length) {
        errors.push(`${url} -> 列表为空`)
        continue
      }
      const chat = all.filter((id) => !NON_CHAT.test(id))
      return { ok: true, models: chat.length ? chat : all, url }
    } catch (err) {
      errors.push(`${url} -> ${String((err as Error).message ?? err)}`)
    }
  }
  return { ok: false, models: [], error: errors.join('；') }
}

const IMAGE_HINT_RE = /(image|flux|dall-e|gpt-image|banana|kontext|sd|imagen|seedream|kolors|cogview|wanx|recraft|ideogram)/i

/** 拉取生图模型列表：优先把图像相关模型排在前面。 */
export async function listImageModels(
  opts: { baseUrl: string; apiKey: string | null },
  timeoutMs = 20000,
): Promise<ModelListResult> {
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' }
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`
  const errors: string[] = []
  for (const url of modelUrls(opts.baseUrl)) {
    try {
      const res = await net.fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) {
        errors.push(`${url} -> HTTP ${res.status}`)
        continue
      }
      const body = (await res.json()) as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> }
      const ids = (body.data ?? []).map((m) => m.id ?? '').filter(Boolean)
      const alt = (body.models ?? []).map((m) => m.name ?? '').filter(Boolean)
      const all = ids.length ? ids : alt
      if (!all.length) {
        errors.push(`${url} -> 列表为空`)
        continue
      }
      const imgFirst = [...all.filter((id) => IMAGE_HINT_RE.test(id)), ...all.filter((id) => !IMAGE_HINT_RE.test(id))]
      return { ok: true, models: imgFirst, url }
    } catch (err) {
      errors.push(`${url} -> ${String((err as Error).message ?? err)}`)
    }
  }
  return { ok: false, models: [], error: errors.join('；') }
}
