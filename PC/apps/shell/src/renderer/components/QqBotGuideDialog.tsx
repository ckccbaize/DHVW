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
 * 唯一入口在 PC 侧的 QQ 官方 Bot 注册与首次激活引导弹窗：
 * - 填入 AppID 与 ClientSecret 并保存后，PC 自动同步下发 ARM 侧并唤醒 qq-openclaw；
 * - 主人只需在 QQ 给机器人发任意一条激活消息（如“你好”），即自动完成认主并开始对话。
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
  const [copiedUrl, setCopiedUrl] = useState(false)
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

  const copyUrl = async (): Promise<void> => {
    const ok = await reliableCopy('https://q.qq.com')
    if (ok) {
      setCopiedUrl(true)
      setTimeout(() => setCopiedUrl(false), 1800)
    } else {
      setMsg({ ok: false, text: '写入剪贴板失败，请直接点击左侧按钮在浏览器打开' })
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
        text: '凭据已加密保存并自动激活 ARM Bot！现在在 QQ 私聊机器人发任意一条消息即可绑定开聊',
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
      setMsg({ ok: true, text: '已解除原主人绑定！请用新的 QQ 给机器人发任意一条消息即可重新认主' })
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
          QQ 官方 Bot 配置与激活
          <span className={`pill ${status?.paired ? 'ok' : boost ? 'ok' : ''}`}>
            {status?.paired ? '已绑定主人' : status?.configured ? '待发消息激活' : boost ? 'BOOST 已激活' : '未配置'}
          </span>
        </h2>

        <p className="hint">
          只需在 PC 端填入官方 Bot 的 <b>AppID</b> 与 <b>ClientSecret</b>，保存后 ARM 侧会自动拉起并同步；然后在 QQ 里给你的机器人发<b>任意一条消息</b>即完成激活认主。
        </p>

        <ol className="qq-guide-steps">
          <li>
            登录 QQ 开放平台创建应用、开通「单聊（C2C）」并在沙箱添加你的 QQ 号为测试成员：
            <div className="qq-cmd-row">
              <button type="button" onClick={() => void window.dhvw.openExternal('https://q.qq.com')}>
                在浏览器打开 QQ 开放平台 (q.qq.com)
              </button>
              <button type="button" className="mini-btn" onClick={() => void copyUrl()}>
                {copiedUrl ? '已复制网址' : '复制网址'}
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
              启用沙箱测试环境（调试期勾选）
            </label>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? '同步中…' : '保存并一键激活'}
            </button>
          </div>
        </form>

        <div className={`qq-pair-box ${status?.paired ? 'ok' : ''}`}>
          {status?.paired ? (
            <div className="qq-pair-row">
              <div>
                <b>已绑定主人</b>：<code className="mono">{status.ownerOpenIdMasked || status.ownerOpenId}</code>
                <div className="hint">
                  QQ 网关：{status.connected ? '在线就绪（可直接聊天/发图/斗图）' : '待 ARM 设备上线'} · 表情包：{status.stickersCount ?? 0} 张
                </div>
              </div>
              <button type="button" disabled={saving} onClick={() => void rebind()}>
                重新绑定 QQ
              </button>
            </div>
          ) : status?.configured ? (
            <div className="qq-pair-row">
              <div>
                <b>下一步：发送激活消息</b>
                <div className="hint">
                  {status.connected
                    ? 'ARM 侧 QQ 网关已连线！现在用你的 QQ 给机器人私聊发一句「你好」或「激活」即可自动绑定并开聊。'
                    : status.gatewayError || '配置已下发，请在 QQ 给机器人发任意一条消息即可自动绑定（设备连线后自动接管）。'}
                </div>
              </div>
              <button type="button" disabled={saving} onClick={() => void rebind()}>
                重置绑定
              </button>
            </div>
          ) : (
            <div className="hint">填好上方 AppID 与 ClientSecret 并点「保存并一键激活」即可，无需填写其他繁琐信息。</div>
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
