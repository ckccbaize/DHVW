import React, { useCallback, useEffect, useState } from 'react'
import type { SceneJobView, SceneOutputView, SceneRequestView, SettingsView } from '../../shared/types'
import { PersonaStudio } from './PersonaStudio'

const KINDS = [
  { value: 'indoor', label: '室内场景' },
  { value: 'street', label: '街道场景（室外）' },
]

const STATE_TEXT: Record<SceneJobView['state'], string> = {
  queued: '排队',
  running: '生成中',
  done: '完成',
  failed: '失败',
}

/** 产出包的推送状态文案：没推过 = 未推送；推过但设备不在线 = 待重试 */
function pushStateOf(output: SceneOutputView): { text: string; cls: string } {
  const state = output.push?.state
  if (state === 'pushed') return { text: '已推送', cls: 'ok' }
  if (state === 'pending') return { text: '待重试', cls: 'bad' }
  if (state === 'failed') return { text: '核验失败', cls: 'bad' }
  return { text: '未推送', cls: '' }
}

type AgentSubTab = 'maps' | 'persona'

/**
 * Agent 页：含「地图绘制」与「角色人设与 L0 记忆」两个子导航页面。
 */
export function AgentView({
  settings,
  onSettingsChange,
}: {
  settings?: SettingsView | null
  onSettingsChange?: (next: SettingsView) => void
}): React.ReactElement {
  const [subTab, setSubTab] = useState<AgentSubTab>('maps')
  const [kind, setKind] = useState('indoor')
  const [name, setName] = useState('')
  const [seed, setSeed] = useState('')
  const [distance, setDistance] = useState('')
  const [note, setNote] = useState('')
  const [jobs, setJobs] = useState<SceneJobView[]>([])
  const [requests, setRequests] = useState<SceneRequestView[]>([])
  const [outputs, setOutputs] = useState<SceneOutputView[]>([])
  const [autoPush, setAutoPush] = useState(false)
  const [pushBusy, setPushBusy] = useState<string | null>(null)
  const [pushMsg, setPushMsg] = useState<{ ok: boolean; text: string; id: string } | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [reachable, setReachable] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null)
  const [openLog, setOpenLog] = useState<string | null>(null)
  const [armPreview, setArmPreview] = useState<{ url: string | null; error?: string } | null>(null)
  const [previewScene, setPreviewScene] = useState<{ id: string; label: string } | null>(null)
  const localLlm = settings?.llmMode === 'local'

  useEffect(() => {
    void window.dhvw.armPreview().then(setArmPreview)
  }, [])

  const refresh = useCallback(async () => {
    const res = await window.dhvw.scenes()
    setReachable(res.reachable)
    setListError(res.error ?? null)
    setJobs(res.jobs)
    setRequests(res.requests ?? [])
    setOutputs(res.outputs ?? [])
    setAutoPush(res.autoPush === true)
    // 失败提示可能被后来的自动重试追上：该产出已推出去了就不再留着旧的错误文案
    setPushMsg((prev) => {
      if (!prev || prev.ok) return prev
      const now = (res.outputs ?? []).find((o) => o.id === prev.id)
      return now?.push?.state === 'pushed' ? { ok: true, text: `${prev.id} 已推送到设备`, id: prev.id } : prev
    })
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

  const retryJob = async (id: string): Promise<void> => {
    setListError(null)
    const res = await window.dhvw.sceneJobRetry(id)
    if (!res.ok) setListError(`${id}：${res.error ?? '续画重试失败'}`)
    await refresh()
  }

  const pushScene = async (id: string): Promise<void> => {
    setPushBusy(id)
    setPushMsg(null)
    try {
      const res = await window.dhvw.scenePush(id)
      if (res.ok) setPushMsg({ ok: true, text: `${id} 已推送到设备`, id })
      else if (res.state === 'pending')
        setPushMsg({ ok: false, text: `${id}：${res.error ?? '设备未连接，已排队重试'}`, id })
      else setPushMsg({ ok: false, text: `${id}：${res.error ?? '推送失败'}`, id })
      await refresh()
    } finally {
      setPushBusy(null)
    }
  }

  const deleteOutput = async (id: string): Promise<void> => {
    setListError(null)
    const res = await window.dhvw.sceneDelete(id)
    if (!res.ok) {
      setListError(`${id}：${res.error ?? '删除失败'}`)
      return
    }
    if (previewScene?.id === id) setPreviewScene(null)
    await refresh()
  }

  const deleteJob = async (id: string): Promise<void> => {
    if (!window.confirm(`删除场景任务 ${id}？运行中的任务会先终止 agent。`)) return
    setDeleteBusy(id)
    setListError(null)
    try {
      const res = await window.dhvw.sceneDelete(id)
      if (!res.ok) {
        setListError(`${id}：${res.error ?? '删除失败'}`)
        return
      }
      if (previewScene?.id === id) setPreviewScene(null)
      await refresh()
    } finally {
      setDeleteBusy(null)
    }
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
    <div className="agent-wrap">
      <div className="subnav" role="tablist" aria-label="Agent 功能子导航">
        <button
          type="button"
          className={subTab === 'maps' ? 'active' : ''}
          onClick={() => setSubTab('maps')}
        >
          地图绘制
        </button>
        <button
          type="button"
          className={subTab === 'persona' ? 'active' : ''}
          onClick={() => setSubTab('persona')}
        >
          角色人设与 L0 记忆
        </button>
      </div>
      {subTab === 'persona' ? (
        <PersonaStudio settings={settings ?? null} onSettingsChange={onSettingsChange} />
      ) : (
        <div className="agent-grid">
      <section className="panel agent-form">
        <h2>设计一张地图</h2>
        <p className="hint">一个场景就是一张连续地图；生成走世界模式的同一套地图逻辑，PC 只出包、不渲染。</p>
        {localLlm && (
          <p className="msg bad">当前使用本地 LLM，地图生成不开放；切回云端 API 后可继续。</p>
        )}
        <div className="row2">
          <div className="field">
            <label>场景类型</label>
            <select value={kind} disabled={localLlm} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>名称（留空由 agent 命名）</label>
            <input value={name} disabled={localLlm} onChange={(e) => setName(e.target.value)} spellCheck={false} placeholder="如 小仓的家" />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>种子（可复现）</label>
            <input value={seed} disabled={localLlm} onChange={(e) => setSeed(e.target.value)} spellCheck={false} placeholder="留空随机" />
          </div>
          <div className="field">
            <label>距家距离（米，室外用）</label>
            <input value={distance} disabled={localLlm} onChange={(e) => setDistance(e.target.value)} inputMode="numeric" placeholder="如 200" />
          </div>
        </div>
        <div className="field">
          <label>额外要求</label>
          <textarea
            value={note}
            disabled={localLlm}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="如：靠窗要有书架，门口留 2 格净空"
          />
        </div>
        {submitError && <p className="msg bad">{submitError}</p>}
        <div className="actions">
          <button className="primary" disabled={busy || localLlm} onClick={() => void submit()}>
            {busy ? '提交中…' : '开始生成'}
          </button>
          <button onClick={() => void refresh()}>刷新任务</button>
        </div>
      </section>

      <div className="agent-right">
        <section className="panel agent-outputs">
          <h2>
            PC 产出地图验收
            <span className={`pill ${reachable ? 'ok' : 'bad'}`}>{reachable ? `${outputs.length} 张` : '编排器不可达'}</span>
          </h2>
          <p className="hint">
            列出 PC 侧已产出的全部地图包（data/scenes/*/dist），使用 ARM 渲染器（overview.js + scene-loader.js）实测加载与寻路。
            {autoPush
              ? '自动推送已开启：核验通过后直接提交给设备。'
              : '自动推送已关闭：核验通过后需在这里点「提交 ARM 侧」。'}
          </p>
          {listError && <p className="msg bad">{listError}</p>}
          {outputs.length === 0 && <div className="empty">暂无已产出的 PC 地图</div>}
          {outputs.map((o) => (
            <div className="job done" key={o.id}>
              <div className="job-head">
                <span className="job-name">{o.name}</span>
                <span className="pill ok mono">{o.id}</span>
                <span className="job-meta mono">
                  {[o.kind, o.grid, o.hotspots != null ? `热点 ${o.hotspots}` : null, o.acts != null ? `动作 ${o.acts}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className={`pill ${pushStateOf(o).cls}`}>{pushStateOf(o).text}</span>
                {o.push?.attempts ? <span className="job-meta mono">尝试 {o.push.attempts}</span> : null}
                <button className="primary" onClick={() => setPreviewScene({ id: o.id, label: o.name })}>
                  产出验收
                </button>
                <button disabled={pushBusy === o.id} onClick={() => void pushScene(o.id)}>
                  {pushBusy === o.id ? '提交中…' : o.push?.state === 'pushed' ? '重新提交 ARM 侧' : '提交 ARM 侧'}
                </button>
                <button onClick={() => void deleteOutput(o.id)}>删除</button>
              </div>
              {o.push?.lastError ? <div className="comp-err">{o.push.lastError}</div> : null}
            </div>
          ))}
          {pushMsg && <p className={`msg ${pushMsg.ok ? 'ok' : 'bad'}`}>{pushMsg.text}</p>}
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
                <button disabled={localLlm || r.state === 'running' || r.state === 'queued'} onClick={() => void retry(r.id)}>
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
                {(j.state === 'done' || outputs.some((o) => o.id === j.id)) && (
                  <button className="primary" onClick={() => setPreviewScene({ id: j.id, label: j.name })}>
                    产出验收
                  </button>
                )}
                {j.state === 'failed' && (
                  <button className="primary" disabled={localLlm} onClick={() => void retryJob(j.id)}>
                    继续重试
                  </button>
                )}
                <button onClick={() => setOpenLog(openLog === j.id ? null : j.id)}>
                  {openLog === j.id ? '收起' : '日志'}
                </button>
                <button disabled={deleteBusy === j.id} onClick={() => void deleteJob(j.id)}>
                  {deleteBusy === j.id ? '删除中…' : '删除'}
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

      {previewScene && (
        <div className="arm-preview-backdrop" role="dialog" aria-modal="true" aria-label="ARM 产出验收预览">
          <div className="panel arm-preview-modal">
            <div className="arm-preview-head">
              <h2>
                产出验收 · {previewScene.label}
                <span className="pill mono">{previewScene.id}</span>
              </h2>
              <div className="actions">
                {outputs.length > 0 && (
                  <select
                    aria-label="切换验收地图"
                    value={previewScene.id}
                    onChange={(e) => {
                      const next = outputs.find((o) => o.id === e.target.value)
                      if (next) setPreviewScene({ id: next.id, label: next.name })
                    }}
                  >
                    {outputs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} ({o.id})
                      </option>
                    ))}
                  </select>
                )}
                <button className="primary" onClick={() => setPreviewScene(null)}>
                  关闭
                </button>
              </div>
            </div>
            {armPreview?.url ? (
              <iframe
                className="arm-preview-frame"
                src={`${armPreview.url}preview.html?scene=${encodeURIComponent(previewScene.id)}`}
                title={`ARM 场景预览 ${previewScene.id}`}
              />
            ) : (
              <div className="empty">{armPreview?.error ?? 'ARM 预览服务未就绪'}</div>
            )}
          </div>
        </div>
      )}
        </div>
      )}
    </div>
  )
}
