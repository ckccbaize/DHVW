import React, { useCallback, useEffect, useState } from 'react'
import type { MemoryStatsView } from '../../shared/types'

/** 记忆向量服务卡片：模型 / 依赖 / 索引计数 / DB 都来自编排器自报，缺什么就直说。 */
export function MemoryCard(): React.ReactElement {
  const [stats, setStats] = useState<MemoryStatsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

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
      <p className="hint">融合权重 0.5×向量 + 0.3×全文 + 0.2×时间衰减；索引可随时由正文重建。</p>
    </section>
  )
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
