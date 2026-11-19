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
// limit 给足：真实设备在线时事件流很密，200 条装不下本用例刚写的那三条
const stored = await (await fetch(`${BASE}/dhvw/events?limit=5000`)).json()
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

const memStats = await (await fetch(`${BASE}/dhvw/memory/stats`)).json()
check(
  '记忆向量统计暴露模型与依赖',
  memStats.model === 'bge-small-zh-v1.5' && memStats.dim === 512 && typeof memStats.deps === 'object',
  JSON.stringify({ model: memStats.model, dim: memStats.dim, deps: memStats.deps }),
)
check(
  '记忆统计暴露遗忘状态',
  typeof memStats.forgotten === 'number' &&
    typeof memStats.superseded === 'number' &&
    typeof memStats.active === 'number' &&
    (memStats.avg_retention === null || typeof memStats.avg_retention === 'number'),
  JSON.stringify({ forgotten: memStats.forgotten, superseded: memStats.superseded, active: memStats.active }),
)

const curve = await (await fetch(`${BASE}/dhvw/memory/curve?k=3`)).json()
check(
  '遗忘曲线接口给出参数与最弱记忆',
  typeof curve.floor === 'number' && curve.floor > 0 && Array.isArray(curve.items) && curve.items.length <= 3,
  JSON.stringify({ floor: curve.floor, items: curve.items?.length }),
)

const dryForget = await (await fetch(`${BASE}/dhvw/memory/forget?dry_run=true`, { method: 'POST' })).json()
check(
  '遗忘结算 dry-run 只报数不写库',
  dryForget.ok === true && dryForget.dryRun === true && typeof dryForget.marked === 'number' && typeof dryForget.purged === 'number',
  JSON.stringify(dryForget),
)

check(
  '全文索引与正文条数一致且向量不超过正文',
  memStats.fts === memStats.total && memStats.vec <= memStats.total,
  JSON.stringify({ total: memStats.total, fts: memStats.fts, vec: memStats.vec }),
)

// 6.5) memory:facts 回流：PC 侧写入 → 增量下发 → 设备 ack 才推进游标
const postFact = async (id, text) => {
  const res = await fetch(`${BASE}/dhvw/facts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ facts: [{ id, text, t: Date.now(), tier: 'L2' }] }),
  })
  return res
}
const pcFact1 = `pc-${Date.now()}`
await postFact(pcFact1, `屋檐下的风铃响了 ${pcFact1}`)
const push1 = await waitFor((m) => m.type === 'memory:facts' && (m.payload.facts ?? []).some((f) => f.id === pcFact1))
check('memory:facts 下发 PC 新事实', typeof push1.payload.since === 'number', `since=${push1.payload.since}`)
check('memory:facts 带 summary', typeof push1.payload.summary === 'string' && push1.payload.summary.length > 0)
ws.send(
  JSON.stringify({ v: 1, id: 'ack-push-1', type: 'facts:ack', ts: Date.now(), replyTo: push1.id, payload: { accepted: [pcFact1], merged: [], rejected: [] } }),
)
await new Promise((r) => setTimeout(r, 300))
const health1 = await (await fetch(`${BASE}/health`)).json()
check('facts:ack 推进游标', health1.facts_since > 0, `since=${health1.facts_since}`)

const pcFact2 = `pc-${Date.now() + 1}`
await postFact(pcFact2, `窗台上落了一只麻雀 ${pcFact2}`)
const push2 = await waitFor((m) => m.type === 'memory:facts' && (m.payload.facts ?? []).some((f) => f.id === pcFact2))
check('增量只带新事实', push2.payload.facts.length === 1, `n=${push2.payload.facts.length}`)
check('增量 since 已是游标', push2.payload.since >= health1.facts_since, `since=${push2.payload.since}`)

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
// 设备在线时它自己的 world:digest 会（正确地）覆盖测试写的时钟，所以这里只校验结构与取值域
const okClock = overview.payload.clock
check(
  'state:overview 带 clock 与档位',
  typeof okClock.minute === 'number' &&
    okClock.minute >= 0 &&
    okClock.minute < 1440 &&
    typeof okClock.phase === 'string' &&
    okClock.phase.length > 0,
  JSON.stringify(okClock),
)
send('present:end', { session_id: 'sess-1' })
const tierIdle = await waitFor((m) => m.type === 'tier' && m.payload.value === 'idle')
check('退出显现后 tier=idle', Boolean(tierIdle))

const stats = await (await fetch(`${BASE}/dhvw/stats`)).json()
check('stats 反映设备在线', stats.device?.connected === true && typeof stats.device.last_seen_s === 'number')
check('stats 带档位迁移计数', stats.tier_transitions?.host >= 1, JSON.stringify(stats.tier_transitions))

// 10) 显示态下行：设备在线时必须真的投递到这条连接
const disp = await (await fetch(`${BASE}/dhvw/display`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ state: 'present' }),
})).json()
check('display:set 投递到在线设备', disp.ok === true && disp.delivered >= 1, JSON.stringify(disp))
const dispMsg = await waitFor((m) => m.type === 'display:set' && m.payload.state === 'present')
check('display:set 载荷带 state 与校时', dispMsg.payload.state === 'present' && typeof dispMsg.payload.t_server === 'number')

const badDisp = await fetch(`${BASE}/dhvw/display`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ state: 'overview2' }),
})
check('非法显示态被拒', badDisp.status === 400)

// 11) 设备 sceneRequests 消费：同一条 pending 只处理一次；缺 mapSpec 显式失败
const reqId = `scene-test-${Date.now()}`
const digestWith = (requests) =>
  send('world:digest', {
    digest: {
      ts: Date.now(),
      seq: Math.floor(Date.now() / 1000),
      clock: { day: '2026-11-13', minute: 540, phase: 'morning' },
      world: { display: 'overview', conn: 'up', tier: 'idle' },
      agenda: [],
      sceneRequests: requests,
      pcActions: [],
      recentEvents: [],
    },
  })
const badReq = [{ id: reqId, reason: 'test', status: 'pending' }]
digestWith(badReq)
await new Promise((r) => setTimeout(r, 600))
digestWith(badReq)
await new Promise((r) => setTimeout(r, 600))
const reqs = (await (await fetch(`${BASE}/dhvw/scenes`)).json()).requests ?? []
const mine = reqs.filter((r) => r.id === reqId)
check('pending sceneRequest 被受理一次', mine.length === 1 && mine[0].state === 'failed', JSON.stringify(mine[0] ?? null))
check('缺 mapSpec 显式失败', /mapSpec/.test(mine[0]?.reason ?? ''))

const retryMissing = await (await fetch(`${BASE}/dhvw/scene/retry`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: 'scene-does-not-exist' }),
})).json()
check('重试不存在的请求明确失败', retryMissing.ok === false && Boolean(retryMissing.error), JSON.stringify(retryMissing))

// 12) 地图推送：不存在的产出必须明确失败；场景表要暴露自动推送开关
const pushMissing = await fetch(`${BASE}/dhvw/scenes/nope-1/push`, { method: 'POST' })
const pushBody = await pushMissing.json()
check('推送不存在的产出明确失败', pushMissing.status === 400 && pushBody.ok === false && Boolean(pushBody.error), JSON.stringify(pushBody))

const scenes = await (await fetch(`${BASE}/dhvw/scenes`)).json()
check('场景表暴露自动推送开关', typeof scenes.autoPush === 'boolean', JSON.stringify({ autoPush: scenes.autoPush }))
check('场景任务表可读', scenes.ok === true && Array.isArray(scenes.jobs))

ws.close()
console.log(`\n${failures.length ? `失败 ${failures.length} 项：${failures.join(', ')}` : '全部通过'}（${Date.now() - t0}ms）`)
process.exitCode = failures.length ? 1 : 0
