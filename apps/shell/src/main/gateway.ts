import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import forge from 'node-forge'
import { WebSocket, WebSocketServer } from 'ws'
import { dataDir, ensureDir } from './paths'
import { log } from './logger'

/** 上游服务的本机地址：name 同时是外部路径前缀（/olvt/... 与 /ws/olvt） */
export interface GatewayTarget {
  name: string
  port: number
  /** 该服务的 WebSocket 路径（相对本机根路径），不填则不允许 WS 转发 */
  wsPath?: string
}

interface Device {
  token: string
  name: string
  addedAt: string
  lastSeen: string | null
}

/** 主机证书与 CA（网关对外身份） */
export interface GatewayCerts {
  key: string
  cert: string
  caPem: string
  /** CA 的 SHA-256 指纹，形如 AA:BB:...，用于设备端人工核对 */
  fingerprint: string
  ips: string[]
}

export interface GatewayStatus {
  running: boolean
  port: number
  urls: string[]
  caFingerprint: string
  devices: Array<{ name: string; addedAt: string; lastSeen: string | null }>
  pairing: { code: string; expiresAt: number } | null
  error?: string
}

const CA_DAYS = 3650
const LEAF_DAYS = 397

function lanAddresses(): string[] {
  const out = new Set<string>(['127.0.0.1'])
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.add(info.address)
    }
  }
  return [...out]
}

function serial(): string {
  return '01' + crypto.randomBytes(16).toString('hex')
}

function createCa(): { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = serial()
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + CA_DAYS * 86_400_000)
  const attrs = [
    { name: 'commonName', value: 'DHVW Local CA' },
    { name: 'organizationName', value: 'Digital Human Virtual Warehouse' },
  ]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { cert, key: keys.privateKey }
}

function createLeaf(
  ca: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey },
  ips: string[],
): { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey } {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = serial()
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + LEAF_DAYS * 86_400_000)
  cert.setSubject([{ name: 'commonName', value: 'dhvw-host' }])
  cert.setIssuer(ca.cert.subject.attributes)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [{ type: 2, value: 'localhost' }, ...ips.map((ip) => ({ type: 7, ip }))],
    },
    { name: 'subjectKeyIdentifier' },
  ])
  cert.sign(ca.key, forge.md.sha256.create())
  return { cert, key: keys.privateKey }
}

const pem = {
  cert: (c: forge.pki.Certificate): string => forge.pki.certificateToPem(c),
  key: (k: forge.pki.PrivateKey): string => forge.pki.privateKeyToPem(k),
}

/** 证书只生成一次；局域网 IP 变了或快过期时只重签叶子证书（CA 不变，设备无需重新信任） */
function ensureCerts(dir: string): GatewayCerts {
  ensureDir(dir)
  const caCertFile = path.join(dir, 'ca.crt.pem')
  const caKeyFile = path.join(dir, 'ca.key.pem')
  const leafCertFile = path.join(dir, 'server.crt.pem')
  const leafKeyFile = path.join(dir, 'server.key.pem')
  const sanFile = path.join(dir, 'server.san.json')

  let ca: { cert: forge.pki.Certificate; key: forge.pki.rsa.PrivateKey }
  if (fs.existsSync(caCertFile) && fs.existsSync(caKeyFile)) {
    ca = {
      cert: forge.pki.certificateFromPem(fs.readFileSync(caCertFile, 'utf8')),
      key: forge.pki.privateKeyFromPem(fs.readFileSync(caKeyFile, 'utf8')) as forge.pki.rsa.PrivateKey,
    }
  } else {
    ca = createCa()
    fs.writeFileSync(caCertFile, pem.cert(ca.cert))
    fs.writeFileSync(caKeyFile, pem.key(ca.key), { mode: 0o600 })
    log('info', 'gateway', '已生成局域网自签 CA')
  }

  const ips = lanAddresses()
  const sanWant = JSON.stringify([...ips].sort())
  const sanHave = fs.existsSync(sanFile) ? fs.readFileSync(sanFile, 'utf8') : ''
  const needsLeaf = !fs.existsSync(leafCertFile) || !fs.existsSync(leafKeyFile) || sanHave !== sanWant
  if (needsLeaf) {
    const leaf = createLeaf(ca, ips)
    fs.writeFileSync(leafCertFile, pem.cert(leaf.cert))
    fs.writeFileSync(leafKeyFile, pem.key(leaf.key), { mode: 0o600 })
    fs.writeFileSync(sanFile, sanWant)
    log('info', 'gateway', '已签发主机证书', { san: ips })
  }

  const caPem = fs.readFileSync(caCertFile, 'utf8')
  // 指纹取证书 DER 的 SHA-256（与 openssl x509 -fingerprint -sha256 一致）
  const fingerprint = crypto
    .createHash('sha256')
    .update(Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(caPem))).getBytes(), 'binary'))
    .digest('hex')
    .match(/.{2}/g)!
    .join(':')
  return {
    key: fs.readFileSync(leafKeyFile, 'utf8'),
    cert: fs.readFileSync(leafCertFile, 'utf8'),
    caPem,
    fingerprint,
    ips,
  }
}

const PAIR_TTL_MS = 5 * 60_000
const MAX_PAIR_FAILS = 5

export class Gateway {
  private server: https.Server | null = null
  private wss: WebSocketServer | null = null
  private devices = new Map<string, Device>()
  private pairing: { code: string; expiresAt: number } | null = null
  private fails = new Map<string, number>()
  private certs: GatewayCerts | null = null
  private urls: string[] = []
  private lastError: string | undefined

  constructor(private readonly opts: { port: number; targets: GatewayTarget[] }) {
    this.loadDevices()
  }

  get status(): GatewayStatus {
    if (!this.certs) {
      const c = ensureCerts(path.join(dataDir, 'gateway'))
      this.certs = c
      this.urls = c.ips.map((ip) => `https://${ip}:${this.opts.port}`)
    }
    if (this.pairing && Date.now() > this.pairing.expiresAt) this.pairing = null
    return {
      running: Boolean(this.server),
      port: this.opts.port,
      urls: this.urls,
      caFingerprint: this.certs.fingerprint,
      devices: [...this.devices.values()].map((d) => ({ name: d.name, addedAt: d.addedAt, lastSeen: d.lastSeen })),
      pairing: this.pairing,
      error: this.lastError,
    }
  }

  /** 开一段配对窗口，返回 6 位配对码；再次调用会作废旧码 */
  openPairing(): { code: string; expiresAt: number } {
    this.pairing = {
      code: String(crypto.randomInt(100_000, 1_000_000)),
      expiresAt: Date.now() + PAIR_TTL_MS,
    }
    this.fails.clear()
    return this.pairing
  }

  closePairing(): void {
    this.pairing = null
  }

  forgetDevices(): void {
    this.devices.clear()
    this.saveDevices()
  }

  start(): void {
    if (this.server) return
    const dir = path.join(dataDir, 'gateway')
    this.certs = ensureCerts(dir)
    this.urls = this.certs.ips.map((ip) => `https://${ip}:${this.opts.port}`)
    const server = https.createServer({ key: this.certs.key, cert: this.certs.cert }, (req, res) => {
      void this.handleRequest(req, res)
    })
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as net.Socket, head, wss))
    server.on('error', (err: NodeJS.ErrnoException) => {
      this.lastError = err.code === 'EADDRINUSE' ? '端口被占用' : err.message
      log('error', 'gateway', '网关启动失败', { error: this.lastError })
      this.server = null
    })
    server.listen(this.opts.port, '0.0.0.0', () => {
      this.lastError = undefined
      log('info', 'gateway', '网关已启动', { port: this.opts.port, urls: this.urls })
    })
    this.server = server
    this.wss = wss
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.wss = null
    return new Promise((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
      setTimeout(resolve, 1500)
    })
  }

  // ---------- 内部 ----------

  private devicesFile = path.join(dataDir, 'gateway', 'devices.json')

  private loadDevices(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.devicesFile, 'utf8')) as Device[]
      for (const d of raw) this.devices.set(d.token, d)
    } catch {
      /* 首次运行没有设备表 */
    }
  }

  private saveDevices(): void {
    ensureDir(path.dirname(this.devicesFile))
    const list = [...this.devices.values()]
    fs.writeFileSync(this.devicesFile, JSON.stringify(list, null, 2), { mode: 0o600 })
  }

  private tokenOf(req: http.IncomingMessage): string | null {
    const url = new URL(req.url ?? '/', 'https://localhost')
    const header = req.headers['x-dhvw-token']
    if (typeof header === 'string' && header) return header
    const query = url.searchParams.get('token')
    return query || null
  }

  private authorized(req: http.IncomingMessage): Device | null {
    const token = this.tokenOf(req)
    if (!token) return null
    const device = this.devices.get(token)
    if (!device) return null
    device.lastSeen = new Date().toISOString()
    return device
  }

  private readBody(req: http.IncomingMessage, limit = 8192): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  private json(res: http.ServerResponse, code: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'https://localhost')
    const route = url.pathname

    if (route === '/ca.crt' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/x-pem-file', 'cache-control': 'no-store' })
      res.end(this.certs?.caPem ?? '')
      return
    }

    if (route === '/healthz' && req.method === 'GET') {
      this.json(res, 200, { ok: true, name: 'DHVW 主机端', version: 1, time: new Date().toISOString() })
      return
    }

    if (route === '/pair' && req.method === 'POST') {
      await this.handlePair(req, res)
      return
    }

    const device = this.authorized(req)
    if (!device) {
      this.json(res, 401, { ok: false, error: '未配对：请先用配对码换取 token' })
      return
    }

    const [, targetName, ...rest] = route.split('/')
    const target = this.opts.targets.find((t) => t.name === targetName)
    if (!target) {
      this.json(res, 404, { ok: false, error: `未知服务 ${targetName}` })
      return
    }
    this.forward(req, res, target, '/' + rest.join('/') + url.search.replace(/[?&]token=[^&]*/g, ''))
  }

  private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? 'unknown'
    if ((this.fails.get(ip) ?? 0) >= MAX_PAIR_FAILS) {
      this.json(res, 429, { ok: false, error: '尝试次数过多，请在主机端重新生成配对码' })
      return
    }
    if (!this.pairing || Date.now() > this.pairing.expiresAt) {
      this.json(res, 403, { ok: false, error: '配对码已失效，请在主机端生成新的配对码' })
      return
    }
    let body: { code?: string; name?: string }
    try {
      body = JSON.parse(await this.readBody(req)) as { code?: string; name?: string }
    } catch {
      this.json(res, 400, { ok: false, error: '请求体必须是 JSON' })
      return
    }
    if (String(body.code ?? '').trim() !== this.pairing.code) {
      this.fails.set(ip, (this.fails.get(ip) ?? 0) + 1)
      this.json(res, 403, { ok: false, error: '配对码不正确' })
      return
    }
    const token = crypto.randomBytes(32).toString('hex')
    const device: Device = {
      token,
      name: (body.name ?? '未命名设备').slice(0, 40),
      addedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    }
    this.devices.set(token, device)
    this.saveDevices()
    this.fails.delete(ip)
    // 一次性码：成功即作废，防止被重复使用
    this.pairing = null
    log('info', 'gateway', '新设备已配对', { name: device.name, ip })
    this.json(res, 200, { ok: true, token, name: device.name })
  }

  private forward(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: GatewayTarget,
    suffix: string,
  ): void {
    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: target.port,
        method: req.method,
        path: suffix || '/',
        headers: { ...req.headers, host: `127.0.0.1:${target.port}`, 'x-forwarded-proto': 'https' },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', (err) => {
      this.json(res, 502, { ok: false, error: `上游 ${target.name} 不可达：${err.message}` })
    })
    req.pipe(upstream)
  }

  private handleUpgrade(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
    wss: WebSocketServer,
  ): void {
    const url = new URL(req.url ?? '/', 'https://localhost')
    const [, wsSeg, targetName] = url.pathname.split('/')
    const target = this.opts.targets.find((t) => t.name === targetName && t.wsPath)
    if (wsSeg !== 'ws' || !target || !this.tokenOf(req)) {
      socket.destroy()
      return
    }
    if (!this.authorized(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`ws://127.0.0.1:${target.port}${target.wsPath}`)
      // 设备连上就发 hello，上游还没 open 时不能丢帧：先排队，连上再冲
      const pending: Array<[Buffer, boolean]> = []
      let open = false
      client.on('message', (data, isBinary) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        if (open && upstream.readyState === WebSocket.OPEN) upstream.send(buf, { binary: isBinary })
        else pending.push([buf, isBinary])
      })
      upstream.on('open', () => {
        open = true
        for (const [buf, isBinary] of pending.splice(0)) upstream.send(buf, { binary: isBinary })
        upstream.on('message', (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }))
        client.on('close', () => upstream.close())
        upstream.on('close', () => client.close())
      })
      upstream.on('error', () => client.close())
      client.on('error', () => upstream.close())
    })
  }
}
