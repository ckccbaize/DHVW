import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSnapshot, ComponentStatus, HostEvent, WorkerSnapshot } from '../shared/types'

declare global {
  interface Window {
    dhvw: {
      snapshot: () => Promise<AppSnapshot>
      action: (req: { id: string; action: 'start' | 'stop' | 'restart' }) => Promise<{ ok: boolean }>
      tailLog: (id: string, lines?: number) => Promise<string>
      setAutoLaunch: (enabled: boolean) => Promise<{ ok: boolean }>
      openDataDir: () => Promise<string>
      restartHost: () => Promise<{ ok: boolean }>
      probeLlm: () => Promise<{ ok: boolean; ms: number; status?: number; note?: string }>
      onSnapshot: (cb: (s: AppSnapshot) => void) => () => void
      onEvent: (cb: (e: HostEvent) => void) => () => void
    }
  }
}

const stateLabel: Record<WorkerSnapshot['state'], string> = {
  running: '运行中',
  starting: '启动中',
  stopped: '已停止',
  failed: '失败',
}

function EventLine({ e }: { e: HostEvent }): React.ReactElement {
  return (
    <div className={`ev ${e.type}`}>
      <span className="ts">{new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
      <span className="type">{e.type}</span>
      {e.service && <span className="svc">{e.service}</span>}
      {typeof e.pid === 'number' && <span className="kv">pid={e.pid}</span>}
      {typeof e.code === 'number' && <span className="kv">code={e.code}</span>}
      {e.message && <span className="msg">{e.message}</span>}
    </div>
  )
}

export default function App(): React.ReactElement {
  const [snap, setSnap] = useState<AppSnapshot | null>(null)
  const [events, setEvents] = useState<HostEvent[]>([])
  const [selected, setSelected] = useState<string>('host')
  const [logText, setLogText] = useState('')
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<{ ok: boolean; ms: number; note?: string } | null>(null)
  const [probing, setProbing] = useState(false)
  const [components, setComponents] = useState<ComponentStatus[]>([])

  const refresh = useCallback(async () => setSnap(await window.dhvw.snapshot()), [])
  const refreshLog = useCallback(async () => setLogText(await window.dhvw.tailLog(selected, 120)), [selected])

  useEffect(() => {
    void refresh()
    void window.dhvw.probeLlm().then(setProbe)
    void window.dhvw.components().then(setComponents)
    const offComp = window.dhvw.onComponentProgress(({ id, progress }) =>
      setComponents((prev) => prev.map((c) => (c.id === id ? { ...c, progress } : c))),
    )
    const offSnap = window.dhvw.onSnapshot((s) => setSnap(s))
    // 心跳每 5 s 一条，留在日志里即可，事件流只保留状态变化
    const offEvt = window.dhvw.onEvent((e) => {
      if (e.type === 'host.heartbeat') return
      setEvents((prev) => [e, ...prev].slice(0, 300))
    })
    const timer = setInterval(() => void refreshLog(), 2000)
    return () => {
      offSnap()
      offEvt()
      offComp()
      clearInterval(timer)
    }
  }, [refresh, refreshLog])

  useEffect(() => {
    void refreshLog()
  }, [refreshLog])

  const act = async (id: string, action: 'start' | 'stop' | 'restart'): Promise<void> => {
    setBusy(true)
    try {
      await window.dhvw.action({ id, action })
      setTimeout(() => void refresh(), 150)
    } finally {
      setBusy(false)
    }
  }

  const workers = snap?.workers ?? []
  const running = useMemo(() => workers.filter((w) => w.state === 'running').length, [workers])

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>DHVW 主机端</h1>
          <span className={`pill ${snap?.hostReady ? 'ok' : 'bad'}`}>
            宿主 {snap?.hostReady ? '就绪' : '未就绪'}
            {snap?.hostPid ? ` · pid ${snap.hostPid}` : ''}
          </span>
          <span className="pill">{running}/{workers.length} 服务运行</span>
          {snap && <span className="pill mono">{snap.llm.model}</span>}
          {probe && (
            <span className={`pill ${probe.ok ? 'ok' : 'bad'}`} title={probe.note}>
              端点 {probe.ok ? '可达' : '不可达'} · {probe.ms} ms
            </span>
          )}
        </div>
        <div className="actions">
          <label className="switch">
            <input
              type="checkbox"
              checked={snap?.autoLaunch ?? false}
              onChange={(e) => void window.dhvw.setAutoLaunch(e.target.checked).then(refresh)}
            />
            开机自启
          </label>
          <button
            disabled={probing}
            onClick={() => {
              setProbing(true)
              void window.dhvw
                .probeLlm()
                .then(setProbe)
                .finally(() => setProbing(false))
            }}
          >
            检测端点
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void window.dhvw.restartHost().then(() => setTimeout(() => void refresh(), 800))}
          >
            重启宿主
          </button>
          <button onClick={() => void window.dhvw.openDataDir()}>打开数据目录</button>
        </div>
      </header>

      <main>
        <section className="panel services">
          <h2>服务</h2>
          <div className="table-wrap">
            <table>
            <thead>
              <tr>
                <th>服务</th>
                <th>状态</th>
                <th>端口</th>
                <th>PID</th>
                <th>重启</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => (
                <tr key={w.id} className={w.state}>
                  <td className="name">{w.name}</td>
                  <td>
                    <span className={`dot ${w.state === 'running' && w.healthy === false ? 'failed' : w.state}`} />
                    {w.state === 'running' && w.healthy === false ? '无响应' : stateLabel[w.state]}
                  </td>
                  <td className="mono">{w.port || '—'}</td>
                  <td className="mono">{w.pid ?? '—'}</td>
                  <td className="mono">{w.restarts}</td>
                  <td className="row-actions">
                    <button disabled={busy} onClick={() => void act(w.id, 'restart')}>重启</button>
                    {w.state === 'running' ? (
                      <button disabled={busy} onClick={() => void act(w.id, 'stop')}>停止</button>
                    ) : (
                      <button disabled={busy} onClick={() => void act(w.id, 'start')}>启动</button>
                    )}
                    <button onClick={() => setSelected(w.id)}>日志</button>
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
          <p className="hint">数据目录：{snap?.dataDir ?? '…'} · Python：{snap?.pythonPath ?? '…'}</p>
        </section>

        <div className="col">
        <section className="panel events">
          <h2>事件</h2>
          <div className="scroll">
            {events.length === 0 && <div className="empty">等待宿主事件…</div>}
            {events.map((e, i) => (
              <EventLine key={`${e.ts}-${i}`} e={e} />
            ))}
          </div>
        </section>

        <section className="panel components">
          <h2>组件</h2>
          {components.length === 0 && <div className="empty">读取中…</div>}
          {components.map((c) => (
            <div className="comp" key={c.id}>
              <div className="comp-info">
                <span className="comp-name">{c.name}</span>
                <span className={`pill ${c.state === 'ready' ? 'ok' : c.state === 'failed' ? 'bad' : ''}`}>
                  {c.state === 'ready' ? '就绪' : c.state === 'failed' ? '失败' : c.state === 'installing' ? '下载中' : '未安装'}
                </span>
                <span className="comp-ver mono">v{c.version}</span>
              </div>
              {c.state === 'installing' && (
                <div className="bar">
                  <div style={{ width: `${c.progress ?? 0}%` }} />
                </div>
              )}
              {c.error && <div className="comp-err">{c.error}</div>}
              {c.state !== 'ready' && c.state !== 'installing' && (
                <button
                  disabled={c.state === 'installing'}
                  onClick={() =>
                    void window.dhvw.installComponent(c.id).then((st) =>
                      setComponents((prev) => prev.map((x) => (x.id === st.id ? st : x))),
                    )
                  }
                >
                  下载并安装
                </button>
              )}
            </div>
          ))}
        </section>
        </div>
      </main>

      <footer className="panel logs">
        <div className="logs-head">
          <h2>日志 · {selected}</h2>
          <div className="tabs">
            {['host', ...workers.map((w) => w.id)].map((id) => (
              <button key={id} className={id === selected ? 'active' : ''} onClick={() => setSelected(id)}>
                {id}
              </button>
            ))}
          </div>
        </div>
        <pre>{logText || '…'}</pre>
      </footer>
    </div>
  )
}
