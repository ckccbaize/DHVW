// 通过网关的 WSS 与 OLVT 对话：验证设备侧「只连 8443 就能跑完整回合」
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WebSocket } from 'ws'

const ca = fs.readFileSync(path.join(os.homedir(), 'AppData/Roaming/DigitalHuman/gateway/ca.crt.pem'))
const devices = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'AppData/Roaming/DigitalHuman/gateway/devices.json'), 'utf8'))
const token = devices[0]?.token
if (!token) {
  console.error('没有已配对设备，先跑 gateway-smoke.mjs')
  process.exit(1)
}

const started = Date.now()
const ws = new WebSocket(`wss://127.0.0.1:8443/ws/olvt?token=${token}`, { ca, servername: 'localhost' })
let firstText = null
let firstAudio = null
let samples = 0
let reply = []
let ended = false

const finish = () => {
  if (ended) return
  ended = true
  console.log('reply:', reply.join(''))
  console.log(`first_text_ms=${firstText} first_audio_ms=${firstAudio} audio_samples=${samples}`)
  ws.close()
  process.exit(0)
}

ws.on('open', () => setTimeout(() => ws.send(JSON.stringify({ type: 'text-input', text: '用一句话介绍你自己', images: null, history_uid: null })), 300))
ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString())
  const ms = Date.now() - started
  if (msg.type === 'full-text' && msg.text !== 'Connection established') {
    if (msg.text !== 'Thinking...') firstText ??= ms
  }
  if (msg.type === 'audio') {
    firstAudio ??= ms
    samples += msg.audio?.length ?? 0
    if (msg.display_text?.text) reply.push(msg.display_text.text.replace(/^\[[a-z]+\]\s*/, ''))
  }
  if (msg.type === 'control' && msg.text === 'conversation-end') finish()
})
ws.on('error', (e) => {
  console.error('ws error', e.message)
  process.exit(1)
})
setTimeout(finish, 45000)
