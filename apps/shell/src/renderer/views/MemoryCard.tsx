import React, { useCallback, useEffect, useState } from 'react'
import type { MemoryCurveView, MemoryStatsView } from '../../shared/types'

/** 记忆向量服务卡片：模型 / 依赖 / 索引计数 / DB 都来自编排器自报，缺什么就直说。 */
export function MemoryCard(): React.ReactElement {
  const [stats, setStats] = useState<MemoryStatsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [curve, setCurve] = useState<MemoryCurveView | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setStats(await window.dhvw.memoryStats())
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const rebuild = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.dhvw.memoryRebuild()
      setMsg(
        res.ok
          ? { ok: true, text: `索引已重建：正文 ${res.total ?? 0} · 全文 ${res.fts ?? 0} · 向量 ${res.vec ?? 0}` }
          : { ok: false, text: res.error ?? '重建失败' },
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const installDeps = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.dhvw.memoryDepsInstall()
      setMsg(
        res.ok
          ? { ok: true, text: '依赖已装进内置运行时，重启编排器后生效' }
          : { ok: false, text: res.error ?? '安装失败' },
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const forget = async (dryRun: boolean): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const res = (await window.dhvw.memoryForget(dryRun)) as {
        ok?: boolean
        checked?: number
        marked?: number
        purged?: number
        error?: string
      }
      setMsg(
        res.ok === false
          ? { ok: false, text: res.error ?? '遗忘结算失败' }
          : {
              ok: true,
              text: `${dryRun ? '预览' : '已结算'}：检查 ${res.checked ?? 0} 条，${dryRun ? '将' : '已'}判遗忘 ${
                res.marked ?? 0
              } 条，${dryRun ? '将' : '已'}物理删除 ${res.purged ?? 0} 条`,
            },
      )
      if (!dryRun) await refresh()
    } finally {
      setBusy(false)
    }
  }

  const toggleCurve = async (): Promise<void> => {
    if (curve) {
      setCurve(null)
      return
    }
    const res = await window.dhvw.memoryCurve(8)
    setCurve('items' in res ? res : null)
    if (!('items' in res)) setMsg({ ok: false, text: res.error })
  }

  const restartOrchestrator = async (): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      const res = await window.dhvw.action({ id: 'orchestrator', action: 'restart' })
      setMsg(res.ok ? { ok: true, text: '已请求重启编排器' } : { ok: false, text: res.error ?? '重启失败' })
      window.setTimeout(() => void refresh(), 3000)
    } finally {
      setBusy(false)
    }
  }

  const sem = stats?.semantic === true
  const missingDeps = Object.entries(stats?.deps ?? {}).filter(([, v]) => !v).map(([k]) => k)

  return (
    <section className="panel memory">
      <h2>
        记忆向量
        <span className={`pill ${stats?.reachable ? (sem ? 'ok' : 'bad') : 'bad'}`}>
          {!stats?.reachable ? '编排器未运行' : sem ? '语义检索' : '仅字面检索'}
        </span>
      </h2>
      {stats?.reachable === false && <div className="hint bad">{stats.error}</div>}

      <div className="world-line">
        <span className="world-item">
          模型 <b className="mono">{(stats?.model ?? '—') + (stats?.dim ? ` · ${stats.dim} 维` : '')}</b>
        </span>
        <span className="world-item">
          记忆 <b className="mono">{stats?.total ?? '—'}</b>
        </span>
        <span className="world-item">
          全文 <b className="mono">{stats?.fts ?? '—'}</b>
        </span>
        <span className="world-item">
          向量 <b className="mono">{stats?.vec ?? '—'}</b>
        </span>
        <span className="world-item">
          DB <b className="mono">{stats?.db_bytes ? fmtBytes(stats.db_bytes) : '—'}</b>
        </span>
      </div>

      <div className="world-line">
        <span className="world-item">
          活跃 <b className="mono">{stats?.active ?? '—'}</b>
        </span>
        <span className="world-item">
          已遗忘 <b className="mono">{stats?.forgotten ?? '—'}</b>
        </span>
        <span className="world-item">
          已取代 <b className="mono">{stats?.superseded ?? '—'}</b>
        </span>
        <span className="world-item">
          平均留存 <b className="mono">{fmtRetention(stats?.avg_retention)}</b>
        </span>
      </div>

      <div className="world-line">
        {Object.entries(stats?.deps ?? {}).map(([name, version]) => (
          <span className="world-item" key={name}>
            {name} <b className={`mono ${version ? '' : 'bad'}`}>{version ?? '缺失'}</b>
          </span>
        ))}
      </div>

      {stats?.model_dir && (
        <p className="hint mono">
          模型目录：{stats.model_dir}
          {stats.model_files === false ? ' · 文件不齐（开发期跑 node scripts/fetch-embed-model.mjs）' : ''}
        </p>
      )}
      {stats?.db_path && <p className="hint mono">向量库：{stats.db_path}</p>}
      {stats?.embed_error && <div className="hint bad">编码器加载失败：{stats.embed_error}</div>}

      <div className="row2 tight">
        <button disabled={busy || !stats?.reachable} onClick={() => void refresh()}>
          刷新
        </button>
        <button disabled={busy || !stats?.reachable} onClick={() => void rebuild()}>
          重建索引
        </button>
        <button disabled={busy || !stats?.model_dir} onClick={() => void window.dhvw.openDirectory(stats?.model_dir ?? '')}>
          打开模型目录
        </button>
      </div>
      <div className="row2 tight">
        <button disabled={busy || !stats?.reachable} onClick={() => void forget(true)}>
          预览遗忘
        </button>
        <button disabled={busy || !stats?.reachable} onClick={() => void forget(false)}>
          执行遗忘结算
        </button>
        <button disabled={busy || !stats?.reachable} onClick={() => void toggleCurve()}>
          {curve ? '收起曲线' : '最弱记忆'}
        </button>
      </div>
      {curve && (
        <div className="mono memory-curve">
          {curve.items.length === 0 && <div className="hint">没有活跃记忆</div>}
          {curve.items.map((it) => (
            <div key={it.id} className="memory-curve-row">
              <span className={it.protected || it.retention >= curve.floor ? '' : 'bad'}>
                {it.retention.toFixed(3)}
              </span>
              <span>
                {it.tier ?? 'L2'} · S={it.stabilityDays}d · {it.ageDays}d 未提 · 召回 {it.recalls}
                {it.protected ? ' · 核心不遗忘' : ''}
              </span>
              <span className="memory-curve-text">{it.text}</span>
            </div>
          ))}
        </div>
      )}
      {(missingDeps.length > 0 || stats?.model_files === false) && (
        <div className="row2 tight">
          {missingDeps.length > 0 && (
            <button disabled={busy} onClick={() => void installDeps()}>
              安装缺失依赖
            </button>
          )}
          <button disabled={busy} onClick={() => void restartOrchestrator()}>
            重启编排器
          </button>
        </div>
      )}
      {msg && <div className={`hint ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</div>}
      <p className="hint">
        融合权重 0.5×向量 + 0.3×全文 + 0.2×保持率；遗忘曲线 R=exp(-Δ天/S)，稳定性 L0{' '}
        {stats?.forgetting?.stabilityDays?.L0 ?? 120} 天 / L1 {stats?.forgetting?.stabilityDays?.L1 ?? 14} 天 / L2{' '}
        {stats?.forgetting?.stabilityDays?.L2 ?? 3} 天，召回一次 ×{1 + (stats?.forgetting?.reinforceFactor ?? 0.6)}
        ，低于 {Math.round((stats?.forgetting?.floor ?? 0.05) * 100)}% 判遗忘（L0 除外），遗忘后
        {' '}
        {stats?.forgetting?.keepForgottenDays ?? 30} 天物理删除。
      </p>
    </section>
  )
}

function fmtRetention(value: number | null | undefined): string {
  return typeof value === 'number' ? value.toFixed(2) : '—'
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
