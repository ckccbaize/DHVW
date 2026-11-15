import React, { useEffect, useRef, useState } from 'react'
import type { StatsView, WorldView } from '../../shared/types'

type DeviceDisplay = 'overview' | 'present'

const DISPLAY_TEXT: Record<DeviceDisplay, string> = { overview: '总观', present: '显现' }

/**
 * 首页：舞台**常驻角色 Live2D**（PC 不做显示态切换），总观 / 显现是设备屏幕上的二切，
 * 由这里下发 `display:set` 指令；是否生效只看设备回传的 digest.world.display。
 */
export function HomeView({
  world,
  stats,
  live2d,
  boost,
  onBoost,
  busy,
}: {
  world: WorldView | null
  stats: StatsView | null
  live2d: { url: string | null; model: string | null; error?: string } | null
  boost: boolean
  onBoost: (next: boolean) => void
  busy: boolean
}): React.ReactElement {
  const live2dReady = Boolean(live2d?.url)
  const digest = world?.digest ?? null
  const mood = world?.mood ?? null
  const deviceDisplay = (digest?.display as DeviceDisplay | undefined) ?? null

  const [pending, setPending] = useState<DeviceDisplay | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const timer = useRef<number | null>(null)
  // 设备回传的显示态与请求一致 → 确认生效
  useEffect(() => {
    if (pending && deviceDisplay === pending) {
      setPending(null)
      setNote(`设备已切到${DISPLAY_TEXT[pending]}`)
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [deviceDisplay, pending])

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])

  const switchDisplay = async (state: DeviceDisplay): Promise<void> => {
    setSending(true)
    setNote(null)
    try {
      const res = await window.dhvw.setDisplay(state)
      if (!res.ok) {
        setNote(res.error ?? '指令未送达')
        setPending(null)
        return
      }
      setPending(state)
      setNote(
        state === 'present'
          ? `已下发「${DISPLAY_TEXT[state]}」，等待服务就绪与设备换场确认…`
          : `已下发「${DISPLAY_TEXT[state]}」，等待设备确认…`,
      )
      if (timer.current) window.clearTimeout(timer.current)
      // 显现切换需等待 OLVT 就绪 + 设备数码方块换场与 iframe 加载，超时放宽到 45s
      timer.current = window.setTimeout(() => {
        setPending((p) => {
          if (p) setNote('设备未确认：服务启动超时或固件尚未实现 display:set')
          return null
        })
      }, state === 'present' ? 45000 : 8000)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="home-stack">
      <section className="panel display-bar">
        <div className="display-current">
          <span className="k">设备显示</span>
          <b className={`display-value ${deviceDisplay ?? 'unknown'}`}>
            {deviceDisplay ? DISPLAY_TEXT[deviceDisplay] : '未知'}
          </b>
          <span className={`pill ${world?.device.connected ? 'ok' : 'bad'}`}>
            {world?.device.connected ? '设备在线' : '设备离线'}
          </span>
        </div>
        <div className="display-actions" role="group" aria-label="切换设备显示态">
          {(['overview', 'present'] as DeviceDisplay[]).map((state) => (
            <button
              key={state}
              className={`display-btn ${deviceDisplay === state ? 'active' : ''}`}
              aria-pressed={deviceDisplay === state}
              disabled={sending}
              onClick={() => void switchDisplay(state)}
            >
              {DISPLAY_TEXT[state]}
            </button>
          ))}
        </div>
        <p className="display-note">{note ?? '切换的是设备屏幕；本机舞台常驻角色形象。'}</p>
      </section>

      <div className="home-grid">
        <section className="panel stage">
          <div className="stage-head">
            <h2>角色形象</h2>
            <span className={`pill mono ${live2dReady ? '' : 'bad'}`}>
              Live2D · {live2d?.model ?? '本机'}
            </span>
          </div>
          <div className="stage-body">
            {live2dReady ? (
              <iframe className="stage-frame" src={live2d!.url!} title="角色形象" allow="autoplay" />
            ) : (
              <div className="stage-empty">
                <span className="stage-empty-title">角色形象未就绪</span>
                <span className="stage-empty-body">{live2d?.error ?? '正在启动角色舞台服务…'}</span>
              </div>
            )}
          </div>
        </section>

        <div className="col home-col">
          <section className={`panel boost ${boost ? 'on' : ''}`}>
            <div className="boost-lines" aria-hidden="true" />
            <h2>世界模式增强</h2>
            <p className="boost-desc">
              让她连续生产（剧情 / 场景 / 背景），显存与预算按主机档放宽。当前只是界面开关，生产链路尚未接线。
            </p>
            <button
              className={`boost-btn ${boost ? 'on' : ''}`}
              disabled={busy}
              aria-pressed={boost}
              onClick={() => onBoost(!boost)}
            >
              <span className="boost-dot" aria-hidden="true" />
              {boost ? 'BOOST ON' : 'BOOST OFF'}
            </button>
          </section>

          <section className="panel stats">
            <h2>
              设备状态机
              <span className={`pill ${stats?.reachable ? (stats.device.connected ? 'ok' : '') : 'bad'}`}>
                {stats?.reachable ? (stats.device.connected ? '在线' : '无设备') : '不可达'}
              </span>
            </h2>
            {stats?.error && <div className="hint bad">{stats.error}</div>}
            <div className="table-wrap">
              <table className="stats-table">
                <tbody>
                  <tr>
                    <th>世界时刻</th>
                    <td className="mono">
                      {digest ? fmtWorldClock(digest.day, digest.minute, digest.weekdayName) : '—'}
                    </td>
                    <th>时段 / 显示</th>
                    <td className="mono">
                      {digest ? `${digest.phase || '—'} · ${DISPLAY_TEXT[digest.display as DeviceDisplay] ?? (digest.display || '—')}` : '—'}
                    </td>
                  </tr>
                  <tr>
                    <th>档位</th>
                    <td className="mono">{stats?.device.tier ?? '—'}</td>
                    <th>心跳</th>
                    <td className="mono">
                      {stats?.device.lastSeenS != null ? `${stats.device.lastSeenS.toFixed(0)}s 前` : '—'}
                    </td>
                  </tr>
                  <tr>
                    <th>摘要 seq</th>
                    <td className="mono">{stats?.digest?.seq ?? '—'}</td>
                    <th>摘要年龄</th>
                    <td className="mono">
                      {stats?.digest?.ageS != null ? `${stats.digest.ageS.toFixed(0)}s` : '—'}
                    </td>
                  </tr>
                  <tr>
                    <th>日程</th>
                    <td className="mono">{fmtCounts(stats?.digest?.agenda)}</td>
                    <th>场景请求</th>
                    <td className="mono">{fmtCounts(stats?.digest?.sceneRequests)}</td>
                  </tr>
                  <tr>
                    <th>PC 动作</th>
                    <td className="mono">{fmtCounts(stats?.digest?.pcActions)}</td>
                    <th>行为 / 事件池</th>
                    <td className="mono">
                      {stats?.digest ? `${stats.digest.behaviors} / ${stats.digest.eventPool}` : '—'}
                    </td>
                  </tr>
                  <tr>
                    <th>档位迁移</th>
                    <td className="mono" colSpan={3}>
                      {fmtCounts(stats?.tierTransitions)}
                    </td>
                  </tr>
                  <tr>
                    <th>近 24h 事件</th>
                    <td className="mono" colSpan={3}>
                      {fmtCounts(stats?.events24h)}
                    </td>
                  </tr>
                  <tr>
                    <th>记忆</th>
                    <td className="mono">{stats?.reachable ? `${stats.memory} 条` : '—'}</td>
                    <th>编排器</th>
                    <td className="mono">{stats?.reachable ? `${stats.uptime.toFixed(0)}s` : '—'}</td>
                  </tr>
                  <tr>
                    <th>心情</th>
                    <td colSpan={3}>
                      {mood ? (
                        <div className="mood-cell">
                          <span className={`pill mood-band-${mood.band}`}>{MOOD_BAND_LABEL[mood.band] ?? mood.band}</span>
                          <div className="world-dims">
                            {mood.dims.map((d) => (
                              <span key={d.key} className="world-dim">
                                <span className="k">{MOOD_DIM_LABEL[d.key] ?? d.key}</span>
                                <span className="bar">
                                  <span style={{ width: `${Math.round(Math.max(0, Math.min(1, d.value)) * 100)}%` }} />
                                </span>
                                <span className="v mono">{Math.round(d.value * 100)}%</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="hint">数字来自 digest / events / 迁移计数，不推算。</p>
          </section>
        </div>
      </div>
    </div>
  )
}

const MOOD_BAND_LABEL: Record<string, string> = {
  calm: '平静',
  happy: '开心',
  excited: '雀跃',
  tired: '疲惫',
  low: '低落',
}

const MOOD_DIM_LABEL: Record<string, string> = {
  energy: '精力',
  valence: '愉悦',
  social: '社交',
  focus: '专注',
}

function fmtMinute(minute: number | null | undefined): string {
  if (minute == null || !Number.isFinite(minute)) return '—'
  const h = Math.floor(minute / 60)
  const m = Math.floor(minute % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function fmtWorldClock(day: string, minute: number, weekdayName?: string): string {
  const parts: string[] = []
  if (day) {
    if (/^\d+$/.test(day)) {
      const dayNum = Math.max(1, Number(day))
      const week = Math.floor((dayNum - 1) / 7) + 1
      parts.push(`第 ${dayNum} 天 · 第 ${week} 周`)
    } else {
      parts.push(day)
    }
  }
  if (weekdayName) parts.push(weekdayName)
  parts.push(fmtMinute(minute))
  return parts.join(' · ')
}

function fmtCounts(counts: Record<string, number> | undefined): string {
  if (!counts) return '—'
  const entries = Object.entries(counts)
  if (entries.length === 0) return '0'
  return entries.map(([k, v]) => `${k} ${v}`).join(' · ')
}
