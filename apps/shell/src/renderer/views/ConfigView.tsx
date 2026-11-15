import React from 'react'
import type {
  AppSnapshot,
  ComponentStatus,
  GatewayStatusView,
  HostEvent,
  WorkerSnapshot,
  WorldView,
} from '../../shared/types'

const stateLabel: Record<WorkerSnapshot['state'], string> = {
  'starting': '启动中',
  'running': '运行中',
  'stopped': '已停止',
  'failed': '失败',
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

/** 配置页：沿用改造前的服务表 / 事件 / 世界 / 组件 / 网关，外加日志面板 */
export function ConfigView({
  snap,
  workers,
  events,
  world,
  components,
  gateway,
  busy,
  logText,
  selected,
  onSelect,
  onAct,
  onOpenGateway,
  onInstall,
  autoLaunch,
  onAutoLaunch,
  onRestartHost,
  onProbe,
  probing,
  probeOk,
}: {
  snap: AppSnapshot | null
  workers: WorkerSnapshot[]
  events: HostEvent[]
  world: WorldView | null
  components: ComponentStatus[]
  gateway: GatewayStatusView | null
  busy: boolean
  logText: string
  selected: string
  onSelect: (id: string) => void
  onAct: (id: string, action: 'start' | 'stop' | 'restart') => void
  onOpenGateway: () => void
  onInstall: (id: string) => void
  autoLaunch: boolean
  onAutoLaunch: (next: boolean) => void
  onRestartHost: () => void
  onProbe: () => void
  probing: boolean
  probeOk: boolean | null
}): React.ReactElement {
  return (
    <>
      <div className="config-grid">
        <section className="panel services">
          <h2>服务</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>服务</th>
                  <th>状态</th>
                  <th>端口</th>
                  <th className="col-optional">PID</th>
                  <th className="col-optional">重启</th>
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
                    <td className="mono col-optional">{w.pid ?? '—'}</td>
                    <td className="mono col-optional">{w.restarts}</td>
                    <td className="row-actions">
                      <button disabled={busy} onClick={() => onAct(w.id, 'restart')}>
                        重启
                      </button>
                      {w.state === 'running' ? (
                        <button disabled={busy} onClick={() => onAct(w.id, 'stop')}>
                          停止
                        </button>
                      ) : (
                        <button disabled={busy} onClick={() => onAct(w.id, 'start')}>
                          启动
                        </button>
                      )}
                      <button onClick={() => onSelect(w.id)}>日志</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="gw-strip">
            <label className="switch">
              <input type="checkbox" checked={autoLaunch} onChange={(e) => onAutoLaunch(e.target.checked)} />
              开机自启
            </label>
            <button onClick={onRestartHost}>重启宿主</button>
            <button disabled={probing} onClick={onProbe}>
              {probeOk === null ? '检测端点' : probeOk ? '端点可达' : '端点不可达'}
            </button>
            <span className="pill mono">
              <span className={`dot ${gateway?.running ? 'running' : 'failed'}`} />
              设备接入 :{gateway?.port ?? '—'}
            </span>
            <code className="mono gw-strip-url">{gateway?.urls[0] ?? '未启动'}</code>
            <button onClick={onOpenGateway}>配对 / 设备</button>
          </div>
          <p className="hint">
            数据目录：{snap?.dataDir ?? '…'} · Python：{snap?.pythonPath ?? '…'}
          </p>
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

          <section className="panel world">
            <h2>
              世界
              <span className={`pill ${world?.reachable ? (world.device.connected ? 'ok' : '') : 'bad'}`}>
                {world?.reachable
                  ? world.device.connected
                    ? `设备在线 · ${world.device.id ?? '?'}`
                    : '编排器在线 · 无设备'
                  : '编排器未运行'}
              </span>
            </h2>
            {world?.error && <div className="hint bad">{world.error}</div>}
            <div className="world-line">
              <span className="world-item">
                档位 <b className="mono">{world?.device.tier ?? '—'}</b>
              </span>
              <span className="world-item">
                世界时刻{' '}
                <b className="mono">
                  {world?.digest
                    ? `${/^\d+$/.test(world.digest.day) ? `第 ${world.digest.day} 天` : world.digest.day}${world.digest.date ? ` ${world.digest.date.slice(5)}` : ''}${world.digest.weekdayName ? ` ${world.digest.weekdayName}` : ''} ${String(Math.floor(world.digest.minute / 60)).padStart(2, '0')}:${String(world.digest.minute % 60).padStart(2, '0')}`
                    : '—'}
                </b>
              </span>
              <span className="world-item">
                时段 <b className="mono">{world?.digest?.phase || '—'}</b>
              </span>
              <span className="world-item">
                显示 <b className="mono">{world?.digest?.display || '—'}</b>
              </span>
              <span className="world-item">
                日程{' '}
                <b className="mono">{world?.digest ? `${world.digest.agendaDone}/${world.digest.agendaTotal}` : '—'}</b>
              </span>
              <span className="world-item">
                待生成场景 <b className="mono">{world?.digest ? world.digest.scenesPending : '—'}</b>
              </span>
              <span className="world-item">
                心情 <b className="mono">{world?.mood?.band || '—'}</b>
              </span>
              <span className="world-item">
                记忆 <b className="mono">{world?.reachable ? world.memory : '—'}</b>
              </span>
            </div>
            {world?.mood && world.mood.dims.length > 0 && (
              <div className="world-dims">
                {world.mood.dims.map((d) => (
                  <span className="world-dim" key={d.key}>
                    <span className="k">{d.key}</span>
                    <span className="bar">
                      <span style={{ width: `${Math.max(0, Math.min(1, d.value)) * 100}%` }} />
                    </span>
                    <span className="v mono">{d.value.toFixed(2)}</span>
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="panel components">
            <h2>组件</h2>
            {components.length === 0 && <div className="empty">读取中…</div>}
            {components.map((c) => (
              <div className="comp" key={c.id}>
                <div className="comp-info">
                  <span className="comp-name">{c.name}</span>
                  <span className={`pill ${c.state === 'ready' ? 'ok' : c.state === 'failed' ? 'bad' : ''}`}>
                    {c.state === 'ready'
                      ? '就绪'
                      : c.state === 'failed'
                        ? '失败'
                        : c.state === 'installing'
                          ? '下载中'
                          : '未安装'}
                  </span>
                  <span className="comp-ver mono">v{c.version}</span>
                </div>
                {c.state === 'installing' && (
                  <div className={`bar ${(c.progress ?? 0) === 0 ? 'indeterminate' : ''}`}>
                    <div style={{ width: `${(c.progress ?? 0) === 0 ? 100 : c.progress}%` }} />
                  </div>
                )}
                {c.error && <div className="comp-err">{c.error}</div>}
                {c.state !== 'ready' && c.state !== 'installing' && (
                  <button onClick={() => onInstall(c.id)}>下载并安装</button>
                )}
              </div>
            ))}
          </section>
        </div>
      </div>

      <footer className="panel logs">
        <div className="logs-head">
          <h2>日志 · {selected}</h2>
          <div className="tabs">
            {['host', ...workers.map((w) => w.id)].map((id) => (
              <button key={id} className={id === selected ? 'active' : ''} onClick={() => onSelect(id)}>
                {id}
              </button>
            ))}
          </div>
        </div>
        <pre>{logText || '…'}</pre>
      </footer>
    </>
  )
}
