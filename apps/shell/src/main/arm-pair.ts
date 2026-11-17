import os from 'node:os'

/** 设备端 dhvw-shell 的局域网配对端口（见 arm/deploy/systemd/dhvw-shell.service）。 */
export const ARM_PAIR_PORT = 8081

export interface ArmDevice {
  host: string
  name: string
  version: string
  paired: boolean
}

interface Identity {
  ok?: boolean
  app?: string
  name?: string
  version?: string
  paired?: boolean
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 0
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function intToIpv4(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/** 只扫本机所在的 /24 私网段；不扫 VPN/公网，避免误伤。 */
function scanTargets(): string[] {
  const out = new Set<string>()
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      const ip = ipv4ToInt(info.address)
      const mask = ipv4ToInt(info.netmask)
      if (!ip || !mask) continue
      const network = ip & mask
      const broadcast = network | (~mask >>> 0)
      // 仅 /24 或更小的私网段；/16 全扫太慢
      if (broadcast - network > 1024) continue
      for (let n = network + 1; n < broadcast; n += 1) {
        if (n === ip) continue
        out.add(intToIpv4(n))
      }
    }
  }
  return [...out]
}

async function probe(host: string, timeoutMs: number): Promise<ArmDevice | null> {
  try {
    const res = await fetch(`http://${host}:${ARM_PAIR_PORT}/__identity`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const data = (await res.json()) as Identity
    if (data.app !== 'dhvw-arm') return null
    return {
      host,
      name: String(data.name || host),
      version: String(data.version || ''),
      paired: Boolean(data.paired),
    }
  } catch {
    return null
  }
}

/** 并发扫描局域网里的 ARM 设备；默认 350ms 超时，最多同时 32 个。 */
export async function scanArmDevices(timeoutMs = 350): Promise<ArmDevice[]> {
  const targets = scanTargets()
  const found: ArmDevice[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(32, targets.length) }, async () => {
    while (cursor < targets.length) {
      const host = targets[cursor++]
      if (!host) continue
      const dev = await probe(host, timeoutMs)
      if (dev) found.push(dev)
    }
  })
  await Promise.all(workers)
  return found.sort((a, b) => a.host.localeCompare(b.host))
}

/** 把网关 WS 地址推给 ARM；设备端写入 data/host.json，页面 3s 内自动续连。 */
export async function pairArmDevice(
  host: string,
  wsUrl: string,
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`http://${host}:${ARM_PAIR_PORT}/__pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wsUrl, name }),
      signal: AbortSignal.timeout(4000),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!res.ok || !data.ok) return { ok: false, error: data.error || `HTTP ${res.status}` }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
