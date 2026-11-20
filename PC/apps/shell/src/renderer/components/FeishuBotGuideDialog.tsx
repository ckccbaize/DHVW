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

const REQUIRED_SCOPES = 'im:message,im:message.p2p_msg:readonly,im:message:send_as_bot,im:resource'
const REQUIRED_EVENT = 'im.message.receive_v1'

/**
 * 飞书官方自建应用（WebSocket 长连接 · 无每日主动发送限制）注册与激活向导弹窗。
 */
export function FeishuBotGuideDialog({
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
  const [appId, setAppId] = useState(settings?.feishuBot?.appId || '')
  const [appSecret, setAppSecret] = useState('')
  const [proactive, setProactive] = useState(settings?.feishuBot?.proactive ?? true)
  const [status, setStatus] = useState<QqBotStatusView | null>(null)
  const [copiedKey, setCopiedKey] = useState<'url' | 'scopes' | 'event' | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [dontAutoOpen, setDontAutoOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('dhvw.feishuBotGuide.dismissed') === '1'
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
        if (!appId && st.feishu?.appId) setAppId(st.feishu.appId)
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

  const copyText = async (kind: 'url' | 'scopes' | 'event', value: string): Promise<void> => {
    const ok = await reliableCopy(value)
    if (ok) {
      setCopiedKey(kind)
      setTimeout(() => setCopiedKey((prev) => (prev === kind ? null : prev)), 1800)
    } else {
      setMsg({ ok: false, text: '写入剪贴板失败，请手动复制页面中显示的名称' })
    }
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    if (!appId.trim()) {
      setMsg({ ok: false, text: '请先填入飞书自建应用的 App ID（通常以 cli_ 开头）' })
      return
    }
    if (!appSecret.trim() && !settings?.feishuBot?.hasSecret) {
      setMsg({ ok: false, text: '首次配置请填入 App Secret' })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      const res = await window.dhvw.feishuBotSave({
        appId: appId.trim(),
        appSecret: appSecret.trim() || undefined,
        proactive,
        activateBoost: true,
      })
      if (!res.ok) {
        setMsg({ ok: false, text: res.error || '保存失败' })
        return
      }
      if (res.settings) onSettingsChange(res.settings)
      if (res.status) setStatus(res.status)
      setAppSecret('')
      setMsg({
        ok: true,
        text: '凭据已加密保存并自动启用飞书长连接！请确认飞书后台已保存长连接、加好 im:message.p2p_msg:readonly 并发布了新版本，随后私聊机器人发一句“你好”即可绑定',
      })
    } finally {
      setSaving(false)
    }
  }

  const rebind = async (): Promise<void> => {
    setSaving(true)
    setMsg(null)
    try {
      const res = await window.dhvw.feishuBotRebind()
      if (res.settings) onSettingsChange(res.settings)
      if (res.status) setStatus(res.status)
      setMsg({ ok: true, text: '已解除原飞书账号绑定！请用新的飞书账号私聊机器人发任意消息完成认主' })
    } finally {
      setSaving(false)
    }
  }

  const toggleDismiss = (checked: boolean): void => {
    setDontAutoOpen(checked)
    try {
      if (checked) localStorage.setItem('dhvw.feishuBotGuide.dismissed', '1')
      else localStorage.removeItem('dhvw.feishuBotGuide.dismissed')
    } catch {}
  }

  const fs = status?.feishu

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog qq-guide-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>
          飞书官方 Bot 注册与激活向导
          <span className={`pill ${fs?.paired ? 'ok' : fs?.connected ? 'ok' : boost ? 'ok' : ''}`}>
            {fs?.paired
              ? '已绑定主人'
              : fs?.connected
                ? '长连接在线 · 待激活'
                : fs?.configured
                  ? '待连接激活'
                  : '未配置'}
          </span>
        </h2>

        <p className="hint">
          飞书官方自建应用支持<b>长连接（无需公网域名）</b>与<b>无每日主动发话限制</b>（免费版 10,000 次/月），只需按以下 4 步配置即可与数字人全天候私聊互动。
        </p>

        <ol className="qq-guide-steps">
          <li>
            登录飞书开放平台创建<b>「企业自建应用」</b>，在左侧「添加应用能力」中开启<b>「机器人」</b>：
            <div className="qq-cmd-row">
              <button type="button" onClick={() => void window.dhvw.openExternal('https://open.feishu.cn/app')}>
                在浏览器打开飞书开放平台 (open.feishu.cn)
              </button>
              <button type="button" className="mini-btn" onClick={() => void copyText('url', 'https://open.feishu.cn/app')}>
                {copiedKey === 'url' ? '已复制网址' : '复制网址'}
              </button>
            </div>
          </li>
          <li>
            进入「<b>权限管理</b>」，开通以下 <b>4 个权限</b>（<b>缺一不可，尤其是读取单聊消息权限</b>）：
            <div className="hint" style={{ marginTop: 4 }}>
              <code>im:message</code>（获取与发送单聊/群聊消息） ·{' '}
              <code>im:message.p2p_msg:readonly</code>（<b>读取用户发给机器人的单聊消息，必开！</b>） ·{' '}
              <code>im:message:send_as_bot</code>（以应用身份发消息） ·{' '}
              <code>im:resource</code>（获取与上传图片/文件）
            </div>
            <div className="qq-cmd-row" style={{ marginTop: 4 }}>
              <button type="button" className="mini-btn" onClick={() => void copyText('scopes', REQUIRED_SCOPES)}>
                {copiedKey === 'scopes' ? '已复制 4 项权限名' : '复制全部 4 项权限标识'}
              </button>
            </div>
          </li>
          <li>
            在下方填入应用的 <b>App ID</b> 与 <b>App Secret</b>，点「保存并启用飞书长连接」，待下方显示<b>长连接在线</b>。
          </li>
          <li>
            回到飞书后台「<b>事件与回调 → 事件配置</b>」：订阅方式选「<b>使用长连接接收事件</b>」并保存，添加事件 <code>{REQUIRED_EVENT}</code>；最后务必去「<b>版本管理与发布</b>」<b>创建版本并提交发布</b>！
            <div className="qq-cmd-row" style={{ marginTop: 4 }}>
              <button type="button" className="mini-btn" onClick={() => void copyText('event', REQUIRED_EVENT)}>
                {copiedKey === 'event' ? '已复制事件名' : `复制事件名 (${REQUIRED_EVENT})`}
              </button>
            </div>
          </li>
        </ol>

        <form onSubmit={(e) => void submit(e)} className="qq-form">
          <div className="row2">
            <div className="field">
              <label>App ID</label>
              <input
                type="text"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder="例如 cli_a6xxxxxxxx"
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label>App Secret</label>
              <input
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={settings?.feishuBot?.hasSecret ? '已加密保存（留空保留）' : '填写飞书 App Secret'}
                spellCheck={false}
              />
            </div>
          </div>
          <div className="row2" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="qq-dismiss-check">
              <input type="checkbox" checked={proactive} onChange={(e) => setProactive(e.target.checked)} />
              允许心情 / 世界事件主动发飞书消息（全天无日限额）
            </label>
            <button type="submit" className="primary" disabled={saving}>
              {saving ? '同步中…' : '保存并启用飞书长连接'}
            </button>
          </div>
        </form>

        <div className={`qq-pair-box ${fs?.paired ? 'ok' : ''}`}>
          {fs?.paired ? (
            <div className="qq-pair-row">
              <div>
                <b>已绑定主人</b>：<code className="mono">{fs.ownerOpenIdMasked || fs.ownerOpenId}</code>
                <div className="hint">
                  飞书长连接：{fs.connected ? '在线就绪（无每日主动发话限制，可直接文字/传图/融图）' : '待 ARM 设备连线'}
                </div>
              </div>
              <button type="button" disabled={saving} onClick={() => void rebind()}>
                重新绑定飞书
              </button>
            </div>
          ) : fs?.configured ? (
            <div className="qq-pair-row">
              <div>
                <b>下一步：确认已发布版本并发送激活消息</b>
                <div className="hint">
                  {fs.connected
                    ? '飞书长连接已在线！若后台已完成发布与长连接保存，现在在飞书给机器人发一句「你好」即自动绑定开聊。'
                    : fs.gatewayError || '凭据已下发，正在建立飞书长连接；请确认未阻断 open.feishu.cn / msg-frontier.feishu.cn。'}
                </div>
              </div>
              <button type="button" disabled={saving} onClick={() => void rebind()}>
                重置绑定
              </button>
            </div>
          ) : (
            <div className="hint">填好上方 App ID 与 App Secret 并点「保存并启用飞书长连接」即可开始。</div>
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
            仅勾选飞书开启 BOOST 时不再自动弹出
          </label>
          <button type="button" onClick={onClose}>
            完成 / 关闭
          </button>
        </div>
      </div>
    </div>
  )
}
