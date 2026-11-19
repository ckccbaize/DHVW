import React, { useCallback, useEffect, useState } from 'react'
import type { SaveView } from '../../shared/types'

/** 设置页里的存档备份：设备自动上报 + 手动备份 + 恢复。 */
export function SaveBackupPanel(): React.ReactElement {
  const [saves, setSaves] = useState<SaveView[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const res = await window.dhvw.saves()
    if (!res.ok) {
      setNote(res.error ?? '读取存档失败')
      return
    }
    setSaves(res.saves)
    setNote(null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const backup = async (): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const res = await window.dhvw.saveBackup()
      if (!res.ok) {
        setNote(res.error ?? '备份请求未送达')
        return
      }
      setNote(`已请求 ${res.requested ?? 0} 台设备上报存档，稍后刷新`)
      window.setTimeout(() => void refresh(), 1200)
    } finally {
      setBusy(false)
    }
  }

  const restore = async (id: string): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      const res = await window.dhvw.saveRestore(id)
      if (!res.ok) {
        setNote(res.error ?? '恢复请求未送达')
        return
      }
      setNote(`已下发恢复（${res.sent ?? 0} 台设备），设备会重载存档`)
      window.setTimeout(() => void refresh(), 2500)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel settings-section">
      <div className="section-head">
        <h2>存档备份</h2>
        <span className={`pill ${saves.length ? '' : 'bad'}`}>{saves.length} 份</span>
      </div>
      <p className="hint">
        设备上线自动备份，运行期间每 5 分钟自动上报一次；PC 只保留最近 20 份，超出后删除最旧版本。
      </p>
      <div className="saves-actions">
        <button disabled={busy} onClick={() => void backup()}>
          立即备份
        </button>
        <button disabled={busy} onClick={() => void refresh()}>
          刷新
        </button>
        <span className="hint">{note ?? '恢复会让设备重新加载所选存档。'}</span>
      </div>
      <div className="saves-list">
        {saves.length === 0 ? (
          <span className="hint">还没有备份。设备连接后会自动生成第一份。</span>
        ) : (
          saves.map((s) => (
            <div className="save-row" key={s.id}>
              <div className="save-main">
                <b>
                  第 {s.day ?? '—'} 天 {fmtMinute(s.minute)}
                </b>
                <span className="mono">{s.scene ?? '—'}</span>
                <span className="hint">
                  {s.reason} · {fmtTime(s.receivedAt)} · {Math.round(s.bytes / 1024)} KB
                </span>
              </div>
              <button disabled={busy} onClick={() => void restore(s.id)}>
                恢复
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  )
}

function fmtMinute(minute: number | null): string {
  if (minute == null) return '—'
  const h = Math.floor(minute / 60)
  const m = Math.floor(minute % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}
