const port = 9223
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
const ev = async (expression) =>
  (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value

console.log('viewport before:', await ev('innerWidth + "x" + innerHeight'))
for (const [w, h] of [
  [1020, 720],
  [900, 640],
  [700, 720],
  [640, 560],
  [520, 520],
  [420, 480],
]) {
  await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await new Promise((r) => setTimeout(r, 500))
  const info = await ev(`(() => {
    const m = document.querySelector('main')
    const panels = [...document.querySelectorAll('.panel')].map(p => {
      const r = p.getBoundingClientRect()
      return { cls: p.className, w: Math.round(r.width), h: Math.round(r.height), scrollH: p.scrollHeight, sw: p.scrollWidth }
    })
    return {
      vw: innerWidth, vh: innerHeight,
      docScrollW: document.documentElement.scrollWidth,
      mainClientW: m.clientWidth, mainScrollW: m.scrollWidth, mainClientH: m.clientHeight, mainScrollH: m.scrollHeight,
      panels,
    }
  })()`)
  console.log(`${w}x${h}`, JSON.stringify(info))
}
await call('Emulation.clearDeviceMetricsOverride')
ws.close()
