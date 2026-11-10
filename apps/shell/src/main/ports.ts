import net from 'node:net'
import { log } from './logger'

function probe(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>()
  const srv = net.createServer()
  srv.unref()
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address()
    if (addr && typeof addr === 'object') {
      const port = addr.port
      srv.close(() => resolve(port))
    } else {
      srv.close(() => reject(new Error('端口分配失败')))
    }
  })
  return promise
}

/** 一次性分配 count 个互不相同的空闲端口。 */
export async function allocatePorts(count: number): Promise<number[]> {
  const ports = new Set<number>()
  let guard = 0
  while (ports.size < count) {
    if (++guard > count * 20) throw new Error('无法分配足够端口')
    try {
      ports.add(await probe())
    } catch (err) {
      log('warn', 'ports', '端口探测失败', { error: String(err) })
    }
  }
  return [...ports]
}
