// 网关端到端验证：证书、配对、鉴权、反代、WebSocket
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import os from 'node:os'
import { WebSocket } from 'ws'

const caPath = path.join(os.homedir(), 'AppData/Roaming/DigitalHuman/gateway/ca.crt.pem')
const ca = fs.readFileSync(caPath)
const base = 'https://127.0.0.1:8443'

function req(method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined
    const r = https.request(
      base + p,
      {
        method,
        ca,
        servername: 'localhost',
        headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(token ? { 'x-dhvw-token': token } : {}) },
      },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode, text }))
      },
    )
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}

// 1. 免鉴权端点
console.log('healthz', (await req('GET', '/healthz')).text.slice(0, 80))
console.log('ca.crt', (await req('GET', '/ca.crt')).text.split('\n')[0])
// 2. 未配对访问被拒
const noauth = await req('GET', '/olvt/health')
console.log('noauth', noauth.status, noauth.text.slice(0, 60))
// 3. 错误配对码
const bad = await req('POST', '/pair', { body: { code: '000000', name: 'test' } })
console.log('wrong-code', bad.status, bad.text.slice(0, 60))
// 4. 正确配对码
const code = (await ask('window.dhvw.gatewayPair().then(p => p.code)')) ?? ''
const ok = await req('POST', '/pair', { body: { code, name: 'DHVW 设备' } })
console.log('pair', ok.status, ok.text.slice(0, 80))
const token = JSON.parse(ok.text).token
// 5. 带 token 反代到本机服务
const proxied = await req('GET', '/olvt/health', { token })
console.log('proxy', proxied.status, proxied.text.slice(0, 60))
// 6. 配对码一次性
const reuse = await req('POST', '/pair', { body: { code, name: 'replay' } })
console.log('reuse', reuse.status, reuse.text.slice(0, 60))
// 7. WebSocket 反代（占位 worker 没有 WS，预期握手被上游拒绝，验证的是鉴权与转发路径）
await new Promise((resolve) => {
  const ws = new WebSocket('wss://127.0.0.1:8443/ws/olvt?token=' + token, { ca, servername: 'localhost' })
  const done = (msg) => {
    console.log('ws', msg)
    ws.close()
    resolve()
  }
  ws.on('open', () => done('open（上游接受连接）'))
  ws.on('unexpected-response', (_r, res) => done('upstream-status ' + res.statusCode))
  ws.on('error', (e) => done('error ' + e.message.slice(0, 60)))
  setTimeout(() => done('timeout'), 5000)
})

async function ask(expression) {
  const list = await (await fetch('http://127.0.0.1:9223/json/list')).json()
  const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  const value = await new Promise((res) => {
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id === 1) res(m.result?.result?.value)
    }
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  })
  ws.close()
  return value
}
