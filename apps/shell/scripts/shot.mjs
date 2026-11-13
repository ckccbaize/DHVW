// 截取指定尺寸下的整页截图，用于人工确认布局
import fs from 'node:fs'

const port = 9223
const [w, h] = [Number(process.argv[2] ?? 1020), Number(process.argv[3] ?? 720)]
const out = process.argv[4] ?? `shot-${w}.png`

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let seq = 0
const call = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    const h = (e) => {
      const m = JSON.parse(e.data)
      if (m.id === id) {
        ws.removeEventListener('message', h)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      }
    }
    ws.addEventListener('message', h)
    ws.send(JSON.stringify({ id, method, params }))
  })
await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
await new Promise((r) => setTimeout(r, 600))
// EVAL：截图前先执行一段页面脚本（切页 / 点开关），用于人工确认各状态布局
if (process.env.EVAL) {
  await call('Runtime.evaluate', { expression: process.env.EVAL, awaitPromise: true, returnByValue: true })
  await new Promise((r) => setTimeout(r, 800))
}
if (process.env.SCROLL === '1') {
  await call('Runtime.evaluate', {
    expression: "(() => { const m = document.querySelector('main'); if (m) m.scrollTop = m.scrollHeight; const c = document.querySelector('.col'); if (c) c.scrollTop = c.scrollHeight; return 1 })()",
    returnByValue: true,
  })
  await new Promise((r) => setTimeout(r, 300))
}
const { data } = await call('Page.captureScreenshot', { format: 'png' })
fs.writeFileSync(out, Buffer.from(data, 'base64'))
await call('Emulation.clearDeviceMetricsOverride')
ws.close()
console.log('saved', out)
