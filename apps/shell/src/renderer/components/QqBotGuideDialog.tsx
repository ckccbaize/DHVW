import React, { useEffect, useState } from 'react'
import type { QqBotStatusView, SettingsView } from '../../shared/types'

async function reliableCopy(text: string): Promise<boolean> {
  try {
    const ok = await window.dhvw.copyText(text)
    if (ok) return true
  } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * 首次启动 / 绑定 QQ 官方 Bot 自动化向导弹窗：
 * - 支持一键打开 QQ 开放平台 & 可靠系统剪贴板复制；
 * - 直接在网页表单填写 AppID 与 ClientSecret，一键加密保存并下发 ARM 设备；
 * - 自动生成 6 位配对口令（DHVW-XXXX）并实时轮询绑定结果，无需 SSH 或手动改设备文件。
 */
export function QqBotGuideDialog({
  settings,
  boost,
  onSettingsChange,
  onClose,
}: {
  settings: SettingsView | null
  boost: boolean
  onSettingsChange: (s: SettingsView) => void
  onClose: () => void
}): React.ReactElement {
  const [appId, setAppId] = useState(settings?.qqBot?.appId || '')
  const [clientSecret, setClientSecret] = useState('')
  const [sandbox, setSandbox] = useState(settings?.qqBot?.sandbox ?? true)
  const [status, setStatus] = useState<QqBotStatusView | null>(null)
  const [copiedKey, setCopiedKey] = useState<'url' | 'code' | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [dontAutoOpen, setDontAutoOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('dhvw.qqBotGuide.dismissed') === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    let alive = true
    const poll = (): void => {
      void window.dhvw.qqBotStatus().then((st) => {
        if (!alive) return
        setStatus(st)
        if (!appId && st.appId) setAppId(st.appId)
      })
    }
    poll()
    const t = window.setInterval(poll, 2000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copy = async (key: 'url' | 'code', text: string): Promise<void> => {
    const ok = await reliableCopy(text)
    if (ok) {
      setCopiedKey(key)
      setTimeout(() => setCopiedKey(null), 1800)
    } else {
      setMsg({ ok: false, text: '写入剪贴板失败，请手动选中复制' })
    }
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!appId.trim()) {
      setMsg({ ok: false, text: '请先填入 QQ Bot AppID' })
      return
    }
    if (!clientSecret.trim() && !settings?.qqBot?.hasSecret) {
      setMsg({ ok: false, text: '首次配置请填入 ClientSecret' })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      const res = await window.dhvw.qqBotSave({
        appId: appId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        sandbox,
        activateBoost: true,
      })
      if (!res.ok) {
        setMsg({ ok: false, text: res.error || '保存失败' })
        return
      }
      if (res.settings) onSettingsChange(res.settings)
      if (res.status) setStatus(res.status)
      setClientSecret('')
      setMsg({
        ok: true,
        text: '已加密保存并自动同步 ARM 设备与开启 BOOST，请用 QQ 私聊发送配对口令完成认主',
      })
    } finally {
      setSaving(false)
    }
  }

  const rebind = async (): Promise<void> => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await window.dhvw.qqBotRebind()
      if (res.settings) onSettingsChange(res.settings)
      if (res.status) setStatus(res.status)
      setMsg({ ok: true, text: '已解除原主人绑定，请在 QQ 私聊发送下方新口令完成重绑' })
    } finally {
      setSaving(false)
    }
  }

  const toggleDismiss = (checked: boolean): void => {
    setDontAutoOpen(checked)
    try {
      if (checked) localStorage.setItem('dhvw.qqBotGuide.dismissed', '1')
      else localStorage.removeItem('dhvw.qqBotGuide.dismissed')
    } catch {}
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog qq-guide-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>
          QQ 官方 Bot 注册与自动绑定向导
          <span className={`pill ${status?.paired ? 'ok' : boost ? 'ok' : ''}`}>
            {status?.paired ? '已绑定主人' : boost ? 'BOOST 已激活' : '待注册配置'}
          </span>
        </h2>

        <p className="hint">
          无需操作设备或 SSH，只需在此填入官方 Bot 凭据即可自动同步到 ARM 侧（合规 Bot APIv2 单聊 + 图片多模态 + 表情包，不扫个人号二维码）。
        </p>

        <ol className="qq-guide-steps">
          <li>
            <b>登录 QQ 开放平台注册机器人：</b>开通「单聊（C2C）消息」并把你的 QQ 加入「沙箱配置」测试成员，复制 <b>AppID</b> 与 <b>ClientSecret</b>。
            <div className="qq-cmd-row">
              <button type="button" onClick={() => void window.dhvw.openExternal('https://q.qq.com')}>
                打开 QQ 开放平台 (q.qq.com)
              </button>
              <button type="button" className="mini-btn" onClick={() => void copy('url', 'https://q.qq.com')}>
                {copiedKey === 'url' ? '已复制网址' : '复制网址'}
              </button>
            </div>
          </li>
        </ol>

        <form onSubmit={(e) => void submit(e)} className="qq-form">
          <div className="row2">
            <div className="field">
              <label>AppID</label>
              <input
                type="text"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="例如 1024****89"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label>ClientSecret</label>
              <input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={settings?.qqBot?.hasSecret ? '已加密保存（留空保留）' : '填写机器人 AppSecret'}
                spellCheck={false}
              />
            </div>
          </div>
          <div className="row2" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="qq-dismiss-check">
              <input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} />
              启用沙箱测试环境（推荐调试期勾选）
            </label>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? '同步中…' : '保存并一键同步 ARM'}
            </button>
          </div>
        </form>

        <div className={`qq-pair-box ${status?.paired ? 'ok' : ''}`}>
          {status?.paired ? (
            <div className="qq-pair-row">
              <div>
                <b>绑定成功</b>：已锁为主人 <code className="mono">{status.ownerOpenIdMasked || status.ownerOpenId}</code>
                <div className="hint">
                  网关：{status.connected ? '已连线就绪' : '待 ARM 设备上线接管'} · 表情包：{status.stickersCount ?? 0} 张
                </div>
              </div>
              <button type="button" disabled={saving} onClick={() => void rebind()}>
                重新绑定 QQ
              </button>
            </div>
          ) : status?.configured ? (
            <div>
              <div className="qq-pair-row">
                <div>
                  <b>第 2 步 · 发送口令自动认主：</b>请用你的 QQ 在沙箱里私聊机器人发送以下口令：
                </div>
                <button type="button" disabled={saving} onClick={() => void rebind()}>
                  刷新口令
                </button>
              </div>
              <div className="qq-code-banner">
                <code className="mono">{status.pairingCode || '等待 ARM 生成口令…'}</code>
                {status.pairingCode && (
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => void copy('code', status.pairingCode)}
                  >
                    {copiedKey === 'code' ? '已复制口令' : '复制口令'}
                  </button>
                )}
              </div>
              <div className="hint">
                网关状态：{status.connected ? '已连上 QQ 网关，等待你发来口令…' : status.gatewayError || '正在同步下发给 ARM 设备…'}
              </div>
            </div>
          ) : (
            <div className="hint">填好上方 AppID 与 ClientSecret 后，这里会自动生成 6 位认主配对口令，无需翻看设备日志。</div>
          )}
        </div>

        {msg && <p className={`msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}

        <div className="actions dialog-actions qq-guide-footer">
          <label className="qq-dismiss-check">
            <input
              type="checkbox"
              checked={dontAutoOpen}
              onChange={(e) => toggleDismiss(e.target.checked)}
            />
            启动或开启 BOOST 时不再自动弹出
          </label>
          <button type="button" onClick={onClose}>
            完成 / 关闭
          </button>
        </div>
      </div>
    </div>
  )
}
