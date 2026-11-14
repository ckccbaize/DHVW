import { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { isSafeModelId, type Live2dModelRef } from './live2d-models'

/**
 * 角色舞台的静态服务：页面与库来自 resources/live2d，模型来自模型库（可能不在同一个根）。
 * file:// 下模型 JSON 会被 Chromium 的跨源检查挡住，所以必须走回环 http。
 *
 * 路由：
 *   /                      → <root>/index.html
 *   /lib/<file>            → <root>/lib/<file>
 *   /model/<id>/<rest>     → <模型目录>/<rest>（模型 id 由调用方解析，绝不暴露绝对路径）
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

function inside(root: string, file: string): boolean {
  const rel = path.relative(root, file)
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function send(res: import('node:http').ServerResponse, file: string): void {
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
}

export async function startLive2dServer(
  root: string,
  resolveModel: (id: string) => Live2dModelRef | null,
): Promise<string | null> {
  if (baseUrl) return baseUrl
  if (!fs.existsSync(path.join(root, 'index.html'))) return null

  const resolvedRoot = path.resolve(root)
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = decodeURIComponent(url.pathname)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end('method not allowed')
      return
    }

    const modelMatch = /^\/model\/([^/]+)\/(.+)$/.exec(pathname)
    if (modelMatch) {
      const id = modelMatch[1] ?? ''
      const rest = modelMatch[2] ?? ''
      const model = isSafeModelId(id) ? resolveModel(id) : null
      if (!model) {
        res.writeHead(404).end('model not found')
        return
      }
      const file = path.resolve(model.dir, rest)
      if (!inside(model.dir, file)) {
        res.writeHead(403).end('forbidden')
        return
      }
      send(res, file)
      return
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const file = path.resolve(resolvedRoot, rel)
    if (!inside(resolvedRoot, file)) {
      res.writeHead(403).end('forbidden')
      return
    }
    send(res, file)
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
