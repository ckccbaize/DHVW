import React, { useCallback, useEffect, useState } from 'react'
import type { SceneJobView, SceneRequestView } from '../../shared/types'

const KINDS = [
  { value: 'home', label: '家（室内）' },
  { value: 'room', label: '房间（室内）' },
  { value: 'office', label: '办公（室内）' },
  { value: 'street', label: '街道（室外）' },
  { value: 'custom', label: '自定义' },
]

const STATE_TEXT: Record<SceneJobView['state'], string> = {
  queued: '排队',
  running: '生成中',
  done: '完成',
  failed: '失败',
}

/**
 * Agent 页：把「你自己设计的地图」交给场景任务（编排器拉起 agent + 地图 skill）。
 * 页面只负责收集参数、展示任务与产物；任何失败原因原样显示。
 */
export function AgentView(): React.ReactElement {
  const [kind, setKind] = useState('home')
  const [name, setName] = useState('')
  const [seed, setSeed] = useState('')
  const [distance, setDistance] = useState('')
  const [note, setNote] = useState('')
  const [jobs, setJobs] = useState<SceneJobView[]>([])
  const [requests, setRequests] = useState<SceneRequestView[]>([])
  const [retryError, setRetryError] = useState<string | null>(null)
  const [reachable, setReachable] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [openLog, setOpenLog] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const res = await window.dhvw.scenes()
    setReachable(res.reachable)
    setListError(res.error ?? null)
    setJobs(res.jobs)
    setRequests(res.requests ?? [])
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => clearInterval(timer)
  }, [refresh])

  const retry = async (id: string): Promise<void> => {
    setRetryError(null)
    const res = await window.dhvw.sceneRetry(id)
    if (!res.ok) setRetryError(`${id}：${res.error ?? '重试失败'}`)
    await refresh()
  }

  const submit = async (): Promise<void> => {
    setBusy(true)
    setSubmitError(null)
    try {
      const dist = distance.trim() === '' ? undefined : Number(distance)
      const res = await window.dhvw.sceneGenerate({
        kind,
        name: name.trim() || undefined,
        seed: seed.trim() || undefined,
        distance: Number.isFinite(dist) ? dist : undefined,
        note: note.trim() || undefined,
      })
      if (!res.ok) {
        setSubmitError(res.error ?? '提交失败')
      } else {
        setName('')
        setSeed('')
        setDistance('')
        setNote('')
        await refresh()
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="agent-grid">
      <section className="panel agent-form">
        <h2>设计一张地图</h2>
        <p className="hint">一个场景就是一张连续地图；生成走世界模式的同一套地图逻辑，PC 只出包、不渲染。</p>
        <div className="row2">
          <div className="field">
            <label>场景类型</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>名称（留空由 agent 命名）</label>
            <input value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} placeholder="如 小仓的家" />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>种子（可复现）</label>
            <input value={seed} onChange={(e) => setSeed(e.target.value)} spellCheck={false} placeholder="留空随机" />
          </div>
          <div className="field">
            <label>距家距离（米，室外用）</label>
            <input value={distance} onChange={(e) => setDistance(e.target.value)} inputMode="numeric" placeholder="如 200" />
          </div>
        </div>
        <div className="field">
          <label>额外要求</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="如：靠窗要有书架，门口留 2 格净空"
          />
        </div>
        {submitError && <p className="msg bad">{submitError}</p>}
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '提交中…' : '开始生成'}
          </button>
          <button onClick={() => void refresh()}>刷新任务</button>
        </div>
      </section>

      <section className="panel agent-requests">
        <h2>
          设备场景请求
          <span className="pill mono">{requests.length} 条</span>
        </h2>
        <p className="hint">设备摘要里的 sceneRequests：每条只受理一次，失败不自动重试。</p>
        {retryError && <p className="msg bad">{retryError}</p>}
        {requests.length === 0 && <div className="empty">设备还没有提出场景请求</div>}
        {requests.map((r) => (
          <div className={`job ${r.state}`} key={r.id}>
            <div className="job-head">
              <span className="job-name mono">{r.id}</span>
              <span className={`pill ${r.state === 'done' ? 'ok' : r.state === 'failed' ? 'bad' : ''}`}>
                {STATE_TEXT[r.state] ?? r.state}
              </span>
              {r.job && <span className="job-meta mono">作业 {r.job}</span>}
              <button disabled={r.state === 'running' || r.state === 'queued'} onClick={() => void retry(r.id)}>
                重试
              </button>
            </div>
            {r.reason && <div className="comp-err">{r.reason}</div>}
          </div>
        ))}
      </section>

      <section className="panel agent-jobs">
        <h2>
          场景任务
          <span className={`pill ${reachable ? 'ok' : 'bad'}`}>{reachable ? `${jobs.length} 条` : '编排器不可达'}</span>
        </h2>
        {listError && <div className="hint bad">{listError}</div>}
        {jobs.length === 0 && <div className="empty">还没有任务</div>}
        {jobs.map((j) => (
          <div className={`job ${j.state}`} key={j.id}>
            <div className="job-head">
              <span className="job-name">{j.name}</span>
              <span className={`pill ${j.state === 'done' ? 'ok' : j.state === 'failed' ? 'bad' : ''}`}>
                {STATE_TEXT[j.state]}
              </span>
              <span className="job-meta mono">
                {j.kind} · {j.seed}
              </span>
              <button onClick={() => setOpenLog(openLog === j.id ? null : j.id)}>
                {openLog === j.id ? '收起' : '日志'}
              </button>
            </div>
            <div className="job-meta mono">
              {j.stage ?? ''}
              {j.finishedAt ? ` · ${Math.max(0, Math.round((j.finishedAt - j.startedAt) / 1000))}s` : ''}
            </div>
            {j.error && <div className="comp-err">{j.error}</div>}
            {j.warnings?.map((w) => (
              <div className="job-warn" key={w}>
                {w}
              </div>
            ))}
            {openLog === j.id && <pre className="job-log">{j.logTail || '…'}</pre>}
          </div>
        ))}
      </section>
    </div>
  )
}
