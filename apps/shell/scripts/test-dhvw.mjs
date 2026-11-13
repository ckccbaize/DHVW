// 假设备：按 ARM 的契约（docs/CONTRACTS.md §3）走一遍 PC 编排器。
// 用法：node scripts/test-dhvw.mjs [port]，需先启动编排器（npm run dev 或 python -m dhvw_orchestrator --port 8877）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

// 直连编排器：node scripts/test-dhvw.mjs [port]
// 走设备真实路径（网关 8443 + 已配对 token）：node scripts/test-dhvw.mjs --wss
const useWss = process.argv.includes('--wss')
const PORT = Number(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 8877)
const BASE = `http://127.0.0.1:${PORT}`
const gwDir = path.join(os.homedir(), 'AppData/Roaming/DigitalHuman/gateway')

function deviceUrl() {
  if (!useWss) return `ws://127.0.0.1:${PORT}/dhvw`
  const devices = JSON.parse(fs.readFileSync(path.join(gwDir, 'devices.json'), 'utf8'))
  const token = devices[0]?.token
  if (!token) throw new Error('没有已配对设备，先跑 gateway-smoke.mjs')
  return `wss://127.0.0.1:8443/ws/orchestrator?token=${token}`
}

const wsOptions = useWss
  ? { ca: fs.readFileSync(path.join(gwDir, 'ca.crt.pem')), servername: 'localhost' }
  : {}
const failures = []

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

const ws = new WebSocket(deviceUrl(), wsOptions)
const inbox = []
const waiters = []

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  inbox.push(msg)
  for (const w of [...waiters]) {
    if (w.match(msg)) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(msg)
    }
  }
})

function waitFor(match, timeout = 6000) {
  const hit = inbox.find(match)
  if (hit) return Promise.resolve(hit)
  return new Promise((resolve, reject) => {
    const w = { match, resolve }
    waiters.push(w)
    setTimeout(() => {
      const i = waiters.indexOf(w)
      if (i >= 0) {
        waiters.splice(i, 1)
        reject(new Error(`等消息超时：${match.toString()}`))
      }
    }, timeout)
  })
}

let seq = 0
function send(type, payload = {}) {
  const id = `d-${++seq}`
  ws.send(JSON.stringify({ v: 1, id, type, ts: Date.now(), payload }))
  return id
}

const t0 = Date.now()
await new Promise((r, j) => {
  ws.on('open', r)
  ws.on('error', j)
})

// 1) 握手与校时
const helloId = send('hello', { t: Date.now(), role: 'device', proto: 1, uuid: 'dev-test' })
const hello = await waitFor((m) => m.type === 'hello' && m.replyTo === helloId)
const skew = Math.abs(hello.payload.t_server - Date.now())
check('hello 回复且校时 <1s', skew < 1000, `skew=${skew}ms`)

// 2) 主动拉取摘要/心情
await waitFor((m) => m.type === 'digest:get')
await waitFor((m) => m.type === 'mood:get')
check('连接后主动 digest:get + mood:get', true)

// 3) 事件批次 + 幂等 ack
const events = [1, 2, 3].map((i) => ({
  seq: i,
  uuid: `ev-test-${i}`,
  t_local: Date.now(),
  kind: 'plot:generated',
  payload: { i },
  src: 'device',
}))
send('events:batch', { events, from_seq: 1, batch_id: 'b1' })
const ack1 = await waitFor((m) => m.type === 'events:ack')
check('events:ack seq 为本批最大', ack1.payload.seq === 3, `seq=${ack1.payload.seq}`)

send('events:batch', { events, from_seq: 1, batch_id: 'b1' })
await waitFor((m) => m.type === 'events:ack' && inbox.filter((x) => x.type === 'events:ack').length >= 2)
const stored = await (await fetch(`${BASE}/dhvw/events?limit=50`)).json()
check('重复批次不重复入库', stored.filter((e) => e.uuid.startsWith('ev-test-')).length === 3, `rows=${stored.length}`)

// 4) 摘要落地
const digest = {
  v: 1,
  ts: Date.now(),
  seq: 7,
  clock: { day: '2026-11-13', minute: 480, phase: 'morning' },
  world: { display: 'overview', conn: 'up', tier: 'idle' },
  agenda: [{ id: 'plot-1', kind: 'plot', at: 0, status: 'done', payload: {} }],
  sceneRequests: [],
  pcActions: [],
  recentEvents: [],
}
send('world:digest', { digest })
await new Promise((r) => setTimeout(r, 300))
const gotDigest = await (await fetch(`${BASE}/dhvw/digest`)).json()
check('world:digest 写盘并可回读', gotDigest.seq === 7 && gotDigest.clock.minute === 480)

// 5) 心情
send('mood:state', {
  v: 1,
  ts: Date.now(),
  minute: 480,
  band: 'calm',
  dims: { energy: 0.55, valence: 0.55, social: 0.4, focus: 0.5 },
  series: [],
  sources: { tick: 2 },
})
await new Promise((r) => setTimeout(r, 300))
const gotMood = await (await fetch(`${BASE}/dhvw/mood`)).json()
check('mood:state 可回读', gotMood.band === 'calm')

// 6) 事实与记忆检索
const factId = `df-${Date.now()}`
const factsId = send('facts:candidates', {
  facts: [{ id: factId, text: `京都的枫叶很红 ${factId}`, t: Date.now(), tier: 'L2' }],
  events: [],
})
const factsAck = await waitFor((m) => m.type === 'facts:ack' && m.replyTo === factsId)
check('facts:ack 收下候选', factsAck.payload.accepted.includes(factId))

const qid = send('memory:query', { req_id: 'req-1', text: '枫叶', k: 5 })
const qres = await waitFor((m) => m.type === 'memory:result' && m.replyTo === qid)
check('memory:result 原样带回 req_id', qres.payload.req_id === 'req-1')
check('二字中文能命中二元组索引', qres.payload.hits.length > 0, `hits=${qres.payload.hits.length}`)

// 7) 错误处理
const badTypeId = send('nope:whatever', {})
const badType = await waitFor((m) => m.type === 'error' && m.replyTo === badTypeId)
check('未知 type 回 bad_type', badType.payload.code === 'bad_type')
ws.send(JSON.stringify({ v: 2, id: 'd-x', type: 'hello', ts: Date.now(), payload: {} }))
const badVer = await waitFor((m) => m.type === 'error' && m.payload.code === 'bad_version')
check('版本不匹配回 bad_version', Boolean(badVer))

// 8) 动作白名单：未接线动作必须显式失败
const actId = send('pc:action', { id: 'a1', action: 'notify', args: { text: 'hi' } })
const act = await waitFor((m) => m.type === 'pc:action:ack' && m.replyTo === actId)
check('未接线的 notify 明确失败', act.payload.ok === false, act.payload.result?.reason ?? '')

// 9) 显现闸门：显式把 tts 关掉验 deny，再打开验 grant（外壳里 TTS 可能已就绪）
await fetch(`${BASE}/dhvw/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tts: false }),
})
send('present:request', { t: Date.now() })
const denied = await waitFor((m) => m.type === 'present:deny')
check('TTS 未就绪时拒绝显现', Boolean(denied.payload.reason), denied.payload.reason)

await fetch(`${BASE}/dhvw/config`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tts: true, llm: { baseUrl: 'https://codex.mintcat.work', model: 'deepseek-v4.1-flash' } }),
})
const llmCfg = await waitFor((m) => m.type === 'llm:config')
check('配置更新后下发 llm:config', llmCfg.payload.baseUrl === 'https://codex.mintcat.work')

send('present:request', { t: Date.now() })
const granted = await waitFor((m) => m.type === 'present:grant')
check('就绪后允许显现', Boolean(granted))
send('present:begin', { session_id: 'sess-1' })
const tierHost = await waitFor((m) => m.type === 'tier' && m.payload.value === 'host')
check('显现期间 tier=host', Boolean(tierHost))
const overview = await waitFor((m) => m.type === 'state:overview' && m.payload.work_tier === 'host', 8000)
check('state:overview 带 clock 与档位', overview.payload.clock.day === '2026-11-13', JSON.stringify(overview.payload.clock))
send('present:end', { session_id: 'sess-1' })
const tierIdle = await waitFor((m) => m.type === 'tier' && m.payload.value === 'idle')
check('退出显现后 tier=idle', Boolean(tierIdle))

ws.close()
console.log(`\n${failures.length ? `失败 ${failures.length} 项：${failures.join(', ')}` : '全部通过'}（${Date.now() - t0}ms）`)
process.exitCode = failures.length ? 1 : 0
