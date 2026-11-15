import http, { createServer, type Server } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
}

let server: Server | null = null
let baseUrl: string | null = null

export function resolveArmWwwDir(candidates: string[]): string | null {
  for (const cand of candidates) {
    if (cand && fs.existsSync(path.join(cand, 'preview.html')) && fs.existsSync(path.join(cand, 'js', 'view', 'overview.js'))) {
      return path.resolve(cand)
    }
  }
  return null
}

export async function startArmPreviewServer(
  root: string,
  getOrchestratorPort: () => number,
): Promise<string | null> {
  if (baseUrl) return baseUrl
  if (!fs.existsSync(path.join(root, 'preview.html'))) return null

  const resolvedRoot = path.resolve(root)
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const rel = decodeURIComponent(url.pathname === '/' ? '/preview.html' : url.pathname)
    const file = path.resolve(resolvedRoot, '.' + rel)
    if (!file.startsWith(resolvedRoot + path.sep) && file !== path.join(resolvedRoot, 'preview.html')) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(500).end('read error')
          return
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        })
        res.end(data)
      })
      return
    }

    const match = /^\/assets\/scenes\/([A-Za-z0-9_-]+)\/(.+)$/.exec(rel)
    const orchPort = getOrchestratorPort()
    if (match && orchPort > 0) {
      const jobId = match[1] ?? ''
      const assetPath = match[2] ?? ''
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: orchPort,
          method: 'GET',
          path: `/dhvw/scenes/${jobId}/dist/${assetPath}`,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, {
            'content-type': MIME[path.extname(assetPath).toLowerCase()] ?? up.headers['content-type'] ?? 'application/octet-stream',
            'cache-control': 'no-store',
          })
          up.pipe(res)
        },
      )
      upstream.on('error', () => {
        res.writeHead(502).end('orchestrator unreachable')
      })
      upstream.end()
      return
    }

    res.writeHead(404).end('not found')
  })

  return await new Promise<string>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('ARM 预览服务端口异常'))
        return
      }
      baseUrl = `http://127.0.0.1:${addr.port}/`
      resolve(baseUrl)
    })
  })
}

export function stopArmPreviewServer(): void {
  server?.close()
  server = null
  baseUrl = null
}
