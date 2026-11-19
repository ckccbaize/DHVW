// 布局审计：连接已运行的 dev 外壳（--remote-debugging-port=9223），
// 在多种窗口尺寸下检查「按钮/输入控件是否被挤出容器」「面板是否出现横向滚动」。
// 用法：先起 dev 外壳，再 `npm run audit:layout`。
const port = Number(process.env.DHVW_CDP_PORT ?? 9223)
const sizes = [
  [1020, 720],
  [900, 640],
  [760, 640],
  [640, 560],
  [520, 520],
  [420, 480],
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let page
for (let i = 0; i < 40 && !page; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
  } catch {}
  if (!page) await sleep(500)
}
if (!page) {
  console.error(`找不到调试页（端口 ${port}）：先启动 dev 外壳并带 --remote-debugging-port=${port}`)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res) => (ws.onopen = res))
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
const evalJs = async (expression) => {
  const out = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text)
  return out.result?.value
}

const audit = `(() => {
  const issues = []
  const vw = document.documentElement.clientWidth
  if (document.documentElement.scrollWidth - vw > 1) issues.push({ type: 'page-hscroll', over: document.documentElement.scrollWidth - vw })
  for (const el of document.querySelectorAll('button, input, select, textarea')) {
    const r = el.getBoundingClientRect()
    if (!r.width && !r.height) continue
    if (r.right > vw + 1 || r.left < -1) issues.push({ type: 'outside-viewport', tag: el.tagName, text: (el.textContent || el.value || '').slice(0, 12) })
  }
  // 控件必须留在自己所属面板内（之前的 bug：组件行的下载按钮溢出到面板外）
  // 中间隔了内层滚动容器（如 .saves-list 的 max-height + overflow:auto）时，
  // 控件被滚出可见区属于滚动内容，不算外溢——按轴各自判断。
  const clippedBy = (el, panel, axis) => {
    for (let p = el.parentElement; p && p !== panel; p = p.parentElement) {
      const cs = getComputedStyle(p)
      const ov = axis === 'x' ? cs.overflowX : cs.overflowY
      if (ov === 'visible') continue
      if (axis === 'x' ? p.scrollWidth > p.clientWidth + 1 : p.scrollHeight > p.clientHeight + 1) return true
    }
    return false
  }
  for (const el of document.querySelectorAll('button, input, select, textarea')) {
    const panel = el.closest('.panel, .dialog, section')
    if (!panel) continue
    const r = el.getBoundingClientRect()
    const pr = panel.getBoundingClientRect()
    if (!r.width && !r.height) continue
    // 面板自身可滚动时，纵向越界属于滚动内容，不算外溢
    const scrollY = panel.scrollHeight > panel.clientHeight + 1 || clippedBy(el, panel, 'y')
    const scrollX = panel.scrollWidth > panel.clientWidth + 1 || clippedBy(el, panel, 'x')
    const badX = !scrollX && (r.right > pr.right + 1 || r.left < pr.left - 1)
    const badY = !scrollY && r.bottom > pr.bottom + 1
    if (badX || badY) {
      issues.push({ type: 'escapes-panel', panel: panel.className, tag: el.tagName, text: (el.textContent || el.value || '').slice(0, 12) })
    }
  }
  for (const p of document.querySelectorAll('.panel, .dialog, section')) {
    if (p.scrollWidth - p.clientWidth > 1) issues.push({ type: 'container-hscroll', cls: p.className, over: p.scrollWidth - p.clientWidth })
    const pr = p.getBoundingClientRect()
    for (const btn of p.querySelectorAll('button')) {
      const r = btn.getBoundingClientRect()
      if (r.width && (r.right > pr.right + 1 || r.left < pr.left - 1))
        issues.push({ type: 'button-clipped', text: btn.textContent.trim().slice(0, 12), over: Math.round(r.right - pr.right) })
    }
  }
  return issues
})()`

let failures = 0
for (const [w, h] of sizes) {
  await call('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await sleep(400)
  const main = await evalJs(audit)
  await evalJs("(() => { [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '设置')?.click(); return 1 })()")
  await sleep(400)
  const dialog = await evalJs(audit)
  await evalJs("(() => { document.querySelector('.overlay')?.click(); return 1 })()")
  await sleep(200)
  const bad = [...main.map((i) => ({ where: 'main', ...i })), ...dialog.map((i) => ({ where: 'dialog', ...i }))]
  failures += bad.length
  console.log(`${bad.length ? 'FAIL' : 'ok  '} ${w}x${h}${bad.length ? ' ' + JSON.stringify(bad.slice(0, 5)) : ''}`)
}
await call('Emulation.clearDeviceMetricsOverride')
ws.close()
process.exit(failures ? 1 : 0)
