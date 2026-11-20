import http, { createServer, type Server } from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
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

/** 本机回环地址：渲染进程 iframe 只能用这个（CSP frame-src 限定 127.0.0.1） */
export function getArmPreviewLocalUrl(): string | null {
  const port = getArmPreviewPort()
  return port ? `http://127.0.0.1:${port}/` : null
}

export function getArmPreviewPort(): number {
  const addr = server?.address()
  return addr && typeof addr === 'object' ? addr.port : 0
}

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
  getCaPem?: () => string,
): Promise<string | null> {
  if (baseUrl) return baseUrl
  if (!fs.existsSync(path.join(root, 'preview.html'))) return null

  const resolvedRoot = path.resolve(root)
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/__llm/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size <= 8 << 20) chunks.push(c)
      })
      req.on('end', () => {
        try {
          const wrapper = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            baseUrl?: string
            apiKey?: string
            body?: unknown
          }
          const target = new URL(String(wrapper.baseUrl || '').replace(/\/+$/, '') + '/chat/completions')
          const mod = target.protocol === 'https:' ? https : http
          const ca = target.protocol === 'https:' ? getCaPem?.() || undefined : undefined
          const payload = JSON.stringify(wrapper.body ?? {})
          const up = mod.request(
            target,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                ...(wrapper.apiKey ? { Authorization: `Bearer ${wrapper.apiKey}` } : {}),
              },
              ...(ca ? { ca } : {}),
            },
            (upRes) => {
              res.writeHead(upRes.statusCode ?? 502, {
                'content-type': upRes.headers['content-type'] ?? 'application/json',
                'cache-control': 'no-store',
              })
              upRes.pipe(res)
            },
          )
          up.on('error', () => res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"upstream_unreachable"}'))
          up.end(payload)
        } catch {
          res.writeHead(400).end('bad request')
        }
      })
      return
    }
    // 根路径给完整 ARM 页面（浏览器一键配对测试），场景预览仍走 /preview.html
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const file = path.resolve(resolvedRoot, '.' + rel)
    if (!file.startsWith(resolvedRoot + path.sep) && file !== path.join(resolvedRoot, 'preview.html')) {
      res.writeHead(403).end('forbidden')
      return
    }
    const orchPort = getOrchestratorPort()
    // 若编排器已激活自定义角色图集，ARM 预览页直接优先加载激活角色（失败或未激活则回退本地文件）
    const activeCharMatch = /^\/assets\/char\/(ojj_sheet\.(?:json|png))$/.exec(rel)
    if (activeCharMatch && orchPort > 0) {
      const targetFile = activeCharMatch[1] === 'ojj_sheet.json' ? 'sheet.json' : 'sheet.png'
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: orchPort,
          method: 'GET',
          path: `/dhvw/characters/active/${targetFile}`,
        },
        (up) => {
          if ((up.statusCode ?? 500) === 200) {
            res.writeHead(200, {
              'content-type': MIME[path.extname(targetFile).toLowerCase()] ?? 'application/octet-stream',
              'cache-control': 'no-store',
            })
            up.pipe(res)
            return
          }
          up.resume()
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
          } else {
            res.writeHead(404).end('not found')
          }
        },
      )
      upstream.on('error', () => {
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
        } else {
          res.writeHead(404).end('not found')
        }
      })
      upstream.end()
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
    // 绑 0.0.0.0，手机/平板同一局域网可直接打开；URL 用局域网 IPv4，避免 127.0.0.1 只在本机可用。
    server!.listen(0, '0.0.0.0', () => {
      const addr = server!.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('ARM 预览服务端口异常'))
        return
      }
      const lan = Object.values(os.networkInterfaces())
        .flat()
        .filter((n) => Boolean(n) && n!.family === 'IPv4' && !n!.internal)
        .map((n) => n!.address)
        .sort((a, b) => {
          const rank = (ip: string): number => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3)
          return rank(a) - rank(b)
        })[0]
      baseUrl = `http://${lan || '127.0.0.1'}:${addr.port}/`
      resolve(baseUrl)
    })
  })
}

export function stopArmPreviewServer(): void {
  server?.close()
  server = null
  baseUrl = null
}
