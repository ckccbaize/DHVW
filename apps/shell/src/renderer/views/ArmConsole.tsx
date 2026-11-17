import React, { useCallback, useEffect, useState } from 'react'
import type { ArmConsoleSnapshot } from '../../shared/types'

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function hhmm(m: unknown): string {
  const n = num(m)
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`
}

function lifeText(s: ArmConsoleSnapshot | null): string {
  const life = s?.life
  if (!life) return '等待设备上报'
  return `第 ${str(life.day)} 天 ${hhmm(life.minute)} · ${str(life.phase)} · ${str(life.room)} · ${str(life.activity)}`
}

function useSnapshot(): {
  snap: ArmConsoleSnapshot | null
  error: string
  refresh: () => Promise<void>
} {
  const [snap, setSnap] = useState<ArmConsoleSnapshot | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async (): Promise<void> => {
    const res = await window.dhvw.armConsoleSnapshot()
    if (res.ok && res.data) {
      setSnap(res.data)
      setError('')
    } else {
      setError(res.error || '读取失败')
    }
  }, [])
  return { snap, error, refresh }
}

/** 信息页的入口卡片：只显示摘要，完整面板在弹层里。 */
export function ArmConsoleCard({ onOpen }: { onOpen: () => void }): React.ReactElement {
  const { snap, error, refresh } = useSnapshot()
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [refresh])
  return (
    <section className="panel arm-console-card">
      <h2>
        ARM 世界生活控制台
        <span className={`pill ${snap ? 'ok' : error ? 'bad' : ''}`}>{snap ? '已连接' : '未连接'}</span>
      </h2>
      <div className="world-line">
        <span className="world-item">生活 {lifeText(snap)}</span>
        <span className="world-item">
          LLM <b className="mono">{snap?.llm.model || '—'}</b>
        </span>
        <span className="world-item">
          倍速 <b className="mono">{snap?.speed ?? '—'}×</b>
        </span>
        <span className="world-item">
          QQ <b className="mono">{snap?.qq ? (snap.qq.connected ? '在线' : '重连中') : '—'}</b>
        </span>
      </div>
      {error && <div className="hint bad">{error}</div>}
      <div className="actions">
        <button onClick={onOpen}>打开控制面板</button>
        <button onClick={() => void refresh()}>刷新</button>
      </div>
    </section>
  )
}

const TRIGGERS: Array<{ kind: string; act?: string; label: string }> = [
  { kind: 'thought', label: '立即独白' },
  { kind: 'memory', label: '立即归纳记忆' },
  { kind: 'write', label: '立即写作' },
  { kind: 'weekly', label: '立即周记' },
  { kind: 'plot', label: '立即剧情' },
  { kind: 'night', label: '设为黑夜' },
  { kind: 'browse', label: '浏览网页' },
  { kind: 'sleep', label: '强制睡觉' },
  { kind: 'wake', label: '强制醒来' },
  { kind: 'act', act: 'read', label: '去阅读' },
  { kind: 'act', act: 'cook', label: '去做饭' },
  { kind: 'act', act: 'write', label: '去写作' },
  { kind: 'act', act: 'bath', label: '去洗澡' },
]

const SPEEDS = [0.5, 1, 2, 5, 10, 30]

type Tab = 'overview' | 'llm' | 'memory' | 'works' | 'plots' | 'events'

/** 完整面板：数据经编排器从设备 IndexedDB 取回，命令经同一通道下发。 */
export function ArmConsoleDialog({ onClose }: { onClose: () => void }): React.ReactElement {
  const { snap, error, refresh } = useSnapshot()
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 4000)
    return () => clearInterval(timer)
  }, [refresh])

  const send = async (command: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      const res = await window.dhvw.armConsoleCommand(command)
      setMsg(res.ok ? '已下发' : res.error || '下发失败')
      if (res.ok) await refresh()
    } finally {
      setBusy(false)
    }
  }

  const llmLog = snap?.llmLog ?? []
  const memory = snap?.memory ?? []
  const writings = snap?.writings ?? []
  const plots = snap?.plots ?? []
  const events = snap?.events ?? []
  const daily = snap?.dailyPlots ?? {}
  const mood = snap?.mood

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog arm-console-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="arm-console-head">
          <h2>ARM 世界生活控制台</h2>
          <button onClick={onClose}>关闭</button>
        </div>
        <div className="world-line">
          <span className="world-item">生活 {lifeText(snap)}</span>
          <span className="world-item">
            LLM <b className="mono">{snap?.llm.model || '—'}</b>
          </span>
          <span className="world-item">
            倍速 <b className="mono">{snap?.speed ?? '—'}×</b>
          </span>
          <span className="world-item">
            QQ <b className="mono">{snap?.qq ? (snap.qq.connected ? '在线' : '重连中') : '—'}</b>
          </span>
          <span className="world-item">
            刷新 <b className="mono">{snap ? new Date(snap.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '—'}</b>
          </span>
        </div>
        {error && <div className="hint bad">{error}</div>}
        {msg && <div className="hint">{msg}</div>}

        <div className="arm-console-tabs">
          {(
            [
              ['overview', '概览'],
              ['llm', `LLM 调用 ${llmLog.length}`],
              ['memory', `本地记忆 ${memory.length}`],
              ['works', `创作 ${writings.length}`],
              ['plots', `剧情 ${plots.length}`],
              ['events', `事件 ${events.length}`],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className="arm-console-grid">
            <section className="arm-console-block">
              <h3>主动触发</h3>
              <div className="arm-console-btns">
                {TRIGGERS.map((t) => (
                  <button
                    key={`${t.kind}-${t.act || ''}`}
                    disabled={busy}
                    onClick={() => void send({ kind: 'trigger', trigger: t.kind, act: t.act })}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </section>
            <section className="arm-console-block">
              <h3>时间倍速</h3>
              <div className="arm-console-btns">
                {SPEEDS.map((v) => (
                  <button key={v} disabled={busy} onClick={() => void send({ kind: 'speed', value: v })}>
                    {v}×
                  </button>
                ))}
              </div>
              <button disabled={busy} onClick={() => void send({ kind: 'open' })}>
                在设备上打开控制台
              </button>
            </section>
            <section className="arm-console-block">
              <h3>今日剧情 / 心情</h3>
              <div className="arm-console-pre">
                {mood
                  ? `energy ${num(mood.energy).toFixed(2)} · valence ${num(mood.valence).toFixed(2)} · social ${num(mood.social).toFixed(2)} · focus ${num(mood.focus).toFixed(2)}`
                  : '心情：暂无'}
              </div>
              <div className="arm-console-pre">{snap?.summary ? `记忆摘要：${snap.summary}` : '记忆摘要：暂无'}</div>
              <div className="arm-console-pre">
                {snap?.highlight ? `最高印象：${str(snap.highlight.text)}（${str(snap.highlight.reason)}）` : '最高印象：暂无'}
              </div>
            </section>
            <section className="arm-console-block">
              <h3>愿望 / 突发</h3>
              <div className="arm-console-pre">
                {snap?.desires?.length
                  ? `愿望：${(snap.desires[snap.desires.length - 1]?.desires as string[] | undefined)?.join(' / ') || '—'}`
                  : '愿望：暂无'}
              </div>
              <div className="arm-console-pre">
                {snap?.sudden?.length
                  ? `突发事件：${snap.sudden
                      .slice(-3)
                      .map((s) => `第${str(s.day)}天 ${str(s.text)}`)
                      .join(' / ')}`
                  : '突发事件：暂无'}
              </div>
            </section>
          </div>
        )}

        {tab === 'llm' && (
          <div className="arm-console-list">
            {llmLog.length === 0 && <div className="empty">还没有 LLM 调用</div>}
            {llmLog
              .slice()
              .reverse()
              .map((r, i) => (
                <details className="llm-item" key={`${str(r.t)}-${i}`} open>
                  <summary>
                    <span className="muted">{str(r.t) ? new Date(num(r.t)).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</span>
                    <span className="pill">{str(r.agent || r.kind || '?')}</span>
                    <span className={r.ok ? 'ok' : 'bad'}>{r.ok ? 'ok' : 'fail'}</span>
                    <span className="muted">{str(r.ms ?? r.latencyMs)}ms</span>
                  </summary>
                  <div className="llm-body">
                    <div className="llm-label">输入</div>
                    <pre className="arm-console-pre">{str(r.prompt)}</pre>
                    <div className="llm-label">输出</div>
                    <pre className="arm-console-pre">{str(r.response)}</pre>
                  </div>
                </details>
              ))}
          </div>
        )}

        {tab === 'memory' && (
          <table className="arm-console-table">
            <thead>
              <tr>
                <th>层级</th>
                <th>事实</th>
              </tr>
            </thead>
            <tbody>
              {memory.map((r, i) => (
                <tr key={i}>
                  <td>{str(r.tier)}</td>
                  <td>{str(r.text)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab === 'works' && (
          <div className="arm-console-list">
            {writings.length === 0 && <div className="empty">还没有创作产出</div>}
            {writings
              .slice()
              .reverse()
              .map((w, i) => (
                <div className="arm-console-item" key={i}>
                  <div>
                    <span className="pill">{str(w.kind)}</span>
                    <span className="muted">
                      第{str(w.day)}天 {hhmm(w.minute)} · {str(w.room)}
                    </span>
                  </div>
                  <pre className="arm-console-pre">{str(w.text)}</pre>
                </div>
              ))}
          </div>
        )}

        {tab === 'plots' && (
          <div className="arm-console-list">
            {Object.keys(daily).length === 0 && plots.length === 0 && <div className="empty">还没有剧情产出</div>}
            {Object.entries(daily)
              .sort((a, b) => num(b[1].forDay) - num(a[1].forDay))
              .map(([day, p]) => (
                <div className="arm-console-item" key={day}>
                  <div>
                    <span className="pill">第 {str(p.forDay || day)} 天</span>
                    <span className="muted">
                      {str(p.event || '剧情')} · {str(p.place)}
                    </span>
                  </div>
                  <pre className="arm-console-pre">{str(p.text)}</pre>
                  <div className="muted">
                    作息 {hhmm(p.sleepAt || 1320)} 睡 / {hhmm(p.wakeAt || 480)} 起
                  </div>
                </div>
              ))}
          </div>
        )}

        {tab === 'events' && (
          <table className="arm-console-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>事件</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {events
                .slice()
                .reverse()
                .map((e, i) => (
                  <tr key={i}>
                    <td>{str(e.t_local)}</td>
                    <td>
                      <span className="pill">{str(e.kind)}</span>
                    </td>
                    <td>
                      <pre className="arm-console-pre">{JSON.stringify(e.payload || {}, null, 2)}</pre>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
