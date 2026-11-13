import React, { useState } from 'react'
import type { StatsView, WorkerSnapshot, WorldView } from '../../shared/types'

export type StageMode = 'overview' | 'show'

/**
 * 首页：左边是「总观 / 显现」二切舞台（显现态嵌 OLVT 页面里的 Live2D），
 * 右边是世界模式增强开关 + ARM 状态机统计表。所有数字都来自真实通道，缺失就显示 —。
 */
export function HomeView({
  world,
  stats,
  olvt,
  boost,
  onBoost,
  busy,
}: {
  world: WorldView | null
  stats: StatsView | null
  olvt: WorkerSnapshot | undefined
  boost: boolean
  onBoost: (next: boolean) => void
  busy: boolean
}): React.ReactElement {
  const [mode, setMode] = useState<StageMode>('overview')
  const olvtReady = olvt?.state === 'running' && olvt.healthy !== false && Boolean(olvt.port)
  const digest = world?.digest ?? null
  const mood = world?.mood ?? null

  const hh = digest ? String(Math.floor(digest.minute / 60)).padStart(2, '0') : '--'
  const mm = digest ? String(digest.minute % 60).padStart(2, '0') : '--'

  return (
    <div className="home-grid">
      <section className="panel stage">
        <div className="stage-head">
          <h2>舞台</h2>
          <div className="seg" role="group" aria-label="舞台显示模式">
            <button
              className={mode === 'overview' ? 'active' : ''}
              aria-pressed={mode === 'overview'}
              onClick={() => setMode('overview')}
            >
              总观
            </button>
            <button
              className={mode === 'show' ? 'active' : ''}
              aria-pressed={mode === 'show'}
              onClick={() => setMode('show')}
            >
              显现
            </button>
          </div>
        </div>

        <div className={`stage-body ${mode}`}>
          {mode === 'show' ? (
            olvtReady ? (
              <iframe className="stage-frame" src={`http://127.0.0.1:${olvt.port}/`} title="虚拟形象" />
            ) : (
              <div className="stage-empty">
                <span className="stage-empty-title">虚拟形象未就绪</span>
                <span className="stage-empty-body">
                  {olvt?.state === 'running' ? 'OLVT 正在启动，健康检查未通过' : 'OLVT 后端未运行，去「配置」页启动'}
                </span>
              </div>
            )
          ) : (
            <div className="overview-board">
              <div className="ov-clock">
                <span className="ov-clock-time mono">
                  {hh}:{mm}
                </span>
                <span className="ov-clock-meta mono">
                  {digest?.day || '—'} · {digest?.phase || '—'}
                </span>
              </div>
              <div className="ov-row">
                <span className="ov-cell">
                  <span className="k">档位</span>
                  <b className="mono">{world?.device.tier ?? '—'}</b>
                </span>
                <span className="ov-cell">
                  <span className="k">显示</span>
                  <b className="mono">{digest?.display || '—'}</b>
                </span>
                <span className="ov-cell">
                  <span className="k">日程</span>
                  <b className="mono">
                    {digest ? `${digest.agendaDone}/${digest.agendaTotal}` : '—'}
                  </b>
                </span>
                <span className="ov-cell">
                  <span className="k">心情</span>
                  <b className="mono">{mood?.band || '—'}</b>
                </span>
              </div>
              {mood && mood.dims.length > 0 && (
                <div className="ov-dims">
                  {mood.dims.map((d) => (
                    <span className="ov-dim" key={d.key}>
                      <span className="k">{d.key}</span>
                      <span className="bar">
                        <span style={{ width: `${Math.max(0, Math.min(1, d.value)) * 100}%` }} />
                      </span>
                      <span className="mono">{d.value.toFixed(2)}</span>
                    </span>
                  ))}
                </div>
              )}
              <p className="hint">
                {world?.reachable
                  ? world.device.connected
                    ? `设备在线 · ${world.device.id ?? '?'} · 摘要 seq ${digest?.seq ?? 0}`
                    : '设备离线，显示上一份摘要'
                  : '编排器未运行'}
              </p>
            </div>
          )}
        </div>
      </section>

      <div className="col home-col">
        <section className={`panel boost ${boost ? 'on' : ''}`}>
          <div className="boost-lines" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
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
            ARM 状态机
            <span className={`pill ${stats?.reachable ? (stats.device.connected ? 'ok' : '') : 'bad'}`}>
              {stats?.reachable ? (stats.device.connected ? '在线' : '无设备') : '不可达'}
            </span>
          </h2>
          {stats?.error && <div className="hint bad">{stats.error}</div>}
          <div className="table-wrap">
            <table className="stats-table">
              <tbody>
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
                  <td className="mono">{stats?.digest?.ageS != null ? `${stats.digest.ageS.toFixed(0)}s` : '—'}</td>
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
              </tbody>
            </table>
          </div>
          <p className="hint">数字来自 digest / events / 迁移计数，不推算。</p>
        </section>
      </div>
    </div>
  )
}

function fmtCounts(counts: Record<string, number> | undefined): string {
  if (!counts) return '—'
  const entries = Object.entries(counts)
  if (entries.length === 0) return '0'
  return entries.map(([k, v]) => `${k} ${v}`).join(' · ')
}
