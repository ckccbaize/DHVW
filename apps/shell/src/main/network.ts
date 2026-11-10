import { net } from 'electron'

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
