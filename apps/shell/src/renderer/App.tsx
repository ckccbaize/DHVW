import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AppSnapshot,
  ComponentStatus,
  GatewayStatusView,
  HostEvent,
  SettingsView,
  StatsView,
  WorldView,
} from '../shared/types'
import type { DhvwApi } from '../preload'
import { HomeView } from './views/HomeView'
import { AgentView } from './views/AgentView'
import { ConfigView } from './views/ConfigView'
import { SettingsPage } from './views/SettingsPage'

// 窗口 API 直接复用预加载层的导出类型，避免两处手写签名漂移
declare global {
  interface Window {
    dhvw: DhvwApi
  }
}

function GatewayDialog({
  status,
  onChange,
  onClose,
}: {
  status: GatewayStatusView | null
  onChange: (s: GatewayStatusView | null) => void
  onClose: () => void
}): React.ReactElement {
  const [msg, setMsg] = useState<string | null>(null)
  const refresh = async (): Promise<void> => onChange(await window.dhvw.gateway())
  const left = status?.pairing ? Math.max(0, Math.round((status.pairing.expiresAt - Date.now()) / 1000)) : 0

  return (
    <div className="overlay" onClick={onClose}>
    <div className="dialog" onClick={(e) => e.stopPropagation()}>
      <h2>设备接入（局域网网关）</h2>
      <div className="comp">
        <div className="comp-info">
          <span className="comp-name">局域网网关</span>
          <span className={`pill ${status?.running ? 'ok' : 'bad'}`}>{status?.running ? '运行中' : '未运行'}</span>
          <span className="comp-ver mono">:{status?.port ?? '—'}</span>
        </div>
        <button onClick={() => void window.dhvw.gatewayRestart().then(refresh)}>重启网关</button>
      </div>
      {status?.error && <div className="comp-err">{status.error}</div>}
      {status?.urls.map((u) => (
        <code key={u} className="gw-url mono">
          {u}
        </code>
      ))}
      <div className="comp">
        <div className="comp-info">
          <span className="comp-name">配对码</span>
          {status?.pairing ? (
            <span className="pill mono">
              {status.pairing.code} · {left}s
            </span>
          ) : (
            <span className="pill">未开启</span>
          )}
        </div>
        {status?.pairing ? (
          <button onClick={() => void window.dhvw.gatewayClosePair().then(refresh)}>取消</button>
        ) : (
          <button
            onClick={() =>
              void window.dhvw.gatewayPair().then((p) => {
                setMsg(p ? '配对码 5 分钟内有效，一次性使用' : '网关未运行，先启动网关')
                return refresh()
              })
            }
          >
            生成配对码
          </button>
        )}
      </div>
      <div className="comp">
        <div className="comp-info">
          <span className="comp-name">已配对设备</span>
          <span className="pill mono">{status?.devices.length ?? 0}</span>
        </div>
        {!!status?.devices.length && (
          <button
            onClick={() =>
              void window.dhvw.gatewayForget().then(() => {
                setMsg('已解除全部设备，需重新配对')
                return refresh()
              })
            }
          >
            全部解除
          </button>
        )}
      </div>
      {status?.devices.map((d) => (
        <div key={d.addedAt} className="gw-dev mono">
          {d.name} · 配对 {d.addedAt.slice(0, 10)}
        </div>
      ))}
      <p className="hint">
        CA 指纹 <span className="mono">{status?.caFingerprint?.slice(0, 23) ?? '…'}</span>
        <br />
        设备先取 {status?.urls[0] ?? 'https://<主机IP>:8443'}/ca.crt 信任证书，再用配对码换 token
      </p>
      {msg && <p className="hint">{msg}</p>}
      <div className="actions dialog-actions">
        <button onClick={onClose}>关闭</button>
      </div>
    </div>
    </div>
  )
}

export default function App(): React.ReactElement {
  const [tab, setTab] = useState<'home' | 'agent' | 'info' | 'settings'>('home')
  const [snap, setSnap] = useState<AppSnapshot | null>(null)
  const [events, setEvents] = useState<HostEvent[]>([])
  const [selected, setSelected] = useState<string>('host')
  const [logText, setLogText] = useState('')
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<{ ok: boolean; ms: number; note?: string } | null>(null)
  const [probing, setProbing] = useState(false)
  const [components, setComponents] = useState<ComponentStatus[]>([])
  const [gateway, setGateway] = useState<GatewayStatusView | null>(null)
  const [world, setWorld] = useState<WorldView | null>(null)
  const [stats, setStats] = useState<StatsView | null>(null)
  const [showGateway, setShowGateway] = useState(false)
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [boostBusy, setBoostBusy] = useState(false)
  const [live2d, setLive2d] = useState<{ url: string | null; model: string | null; error?: string } | null>(null)

  const refresh = useCallback(async () => setSnap(await window.dhvw.snapshot()), [])
  const refreshLog = useCallback(async () => setLogText(await window.dhvw.tailLog(selected, 120)), [selected])

  useEffect(() => {
    void refresh()
    void window.dhvw.probeLlm().then(setProbe)
    void window.dhvw.components().then(setComponents)
    void window.dhvw.gateway().then(setGateway)
    void window.dhvw.world().then(setWorld)
    void window.dhvw.stats().then(setStats)
    void window.dhvw.settings().then(setSettings)
    void window.dhvw.live2d().then(setLive2d)
    const offComp = window.dhvw.onComponentProgress(({ id, progress }) =>
      setComponents((prev) => prev.map((c) => (c.id === id ? { ...c, progress } : c))),
    )
    const offSnap = window.dhvw.onSnapshot((s) => setSnap(s))
    // 心跳每 5 s 一条，留在日志里即可，事件流只保留状态变化
    const offEvt = window.dhvw.onEvent((e) => {
      if (e.type === 'host.heartbeat') return
      setEvents((prev) => [e, ...prev].slice(0, 300))
    })
    const timer = setInterval(() => {
      void refreshLog()
      void window.dhvw.gateway().then(setGateway)
      void window.dhvw.world().then(setWorld)
      void window.dhvw.stats().then(setStats)
    }, 2000)
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

  const setBoost = async (next: boolean): Promise<void> => {
    setBoostBusy(true)
    try {
      const res = await window.dhvw.setBoost(next)
      if (res.settings) setSettings(res.settings)
    } finally {
      setBoostBusy(false)
    }
  }

  const installComponent = (id: string): void => {
    // 先切到「下载中」：进度事件只更新已有的行，没有这一步永远看不到进度条
    setComponents((prev) =>
      prev.map((x) => (x.id === id ? { ...x, state: 'installing', progress: undefined, error: undefined } : x)),
    )
    void window.dhvw.installComponent(id).then((st) =>
      setComponents((prev) => prev.map((x) => (x.id === st.id ? st : x))),
    )
  }

  const workers = snap?.workers ?? []
  const running = useMemo(() => workers.filter((w) => w.state === 'running').length, [workers])

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>DHVW</h1>
          <span className={`pill ${snap?.hostReady ? 'ok' : 'bad'}`}>
            宿主 {snap?.hostReady ? '就绪' : '未就绪'}
            {snap?.hostPid ? ` · pid ${snap.hostPid}` : ''}
          </span>
          <span className="pill">{running}/{workers.length} 服务</span>
          {probe && (
            <span className={`pill ${probe.ok ? 'ok' : 'bad'}`} title={probe.note}>
              端点 {probe.ok ? '可达' : '不可达'}
            </span>
          )}
        </div>
        <nav className="tabbar" aria-label="页面">
          {(
            [
              ['home', '首页'],
              ['agent', 'Agent'],
              ['info', '信息'],
              ['settings', '设置'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} aria-current={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="actions">
          <button onClick={() => void window.dhvw.openDataDir()}>数据目录</button>
        </div>
      </header>

      {showGateway && <GatewayDialog status={gateway} onChange={setGateway} onClose={() => setShowGateway(false)} />}

      <main className={`page ${tab}`}>
        {tab === 'home' && (
          <HomeView
            world={world}
            stats={stats}
            live2d={live2d}
            boost={settings?.boost?.enabled ?? false}
            onBoost={(next) => void setBoost(next)}
            busy={boostBusy}
          />
        )}
        {tab === 'agent' && <AgentView />}
        {tab === 'info' && (
          <ConfigView
            snap={snap}
            workers={workers}
            events={events}
            world={world}
            components={components}
            gateway={gateway}
            busy={busy}
            logText={logText}
            selected={selected}
            onSelect={setSelected}
            onAct={(id, action) => void act(id, action)}
            onOpenGateway={() => setShowGateway(true)}
            onInstall={installComponent}
            autoLaunch={snap?.autoLaunch ?? false}
            onAutoLaunch={(next) => void window.dhvw.setAutoLaunch(next).then(refresh)}
            onRestartHost={() => void window.dhvw.restartHost().then(() => setTimeout(() => void refresh(), 800))}
            onProbe={() => {
              setProbing(true)
              void window.dhvw
                .probeLlm()
                .then(setProbe)
                .finally(() => setProbing(false))
            }}
            probing={probing}
            probeOk={probe ? probe.ok : null}
          />
        )}
        {tab === 'settings' && settings && (
          <SettingsPage
            value={settings}
            onSaved={(next) => {
              setSettings(next)
              setSnap((prev) => (prev ? { ...prev, llm: { baseUrl: next.llm.baseUrl, model: next.llm.model } } : prev))
              // 模型换了：舞台地址带 ?model=，重新取一次让 iframe 重新加载
              void window.dhvw.live2d().then(setLive2d)
            }}
          />
        )}
      </main>
    </div>
  )
}
