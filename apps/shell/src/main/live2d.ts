import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 角色舞台的静态服务：只需要把 resources/live2d 下的页面、库、模型从 http 源发给渲染进程。
 * file:// 下模型 JSON 会被 Chromium 的跨源检查挡住，所以必须走回环 http。
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm',
}

let server: Server | null = null
let baseUrl: string | null = null

export async function startLive2dServer(root: string): Promise<string | null> {
  if (baseUrl) return baseUrl
  if (!fs.existsSync(path.join(root, 'index.html'))) return null

  const resolvedRoot = path.resolve(root)
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const file = path.resolve(resolvedRoot, '.' + rel)
    // 只允许读 root 内的文件
    if (!file.startsWith(resolvedRoot + path.sep) && file !== path.join(resolvedRoot, 'index.html')) {
      res.writeHead(403).end('forbidden')
      return
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      })
      res.end(data)
    })
  })

  return await new Promise<string>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('角色舞台服务端口异常'))
        return
      }
      baseUrl = `http://127.0.0.1:${addr.port}/`
      resolve(baseUrl)
    })
  })
}

export function stopLive2dServer(): void {
  server?.close()
  server = null
  baseUrl = null
}
