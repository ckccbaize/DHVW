import React, { useState } from 'react'

const QQ_BOT_CONFIG_SAMPLE = `{
  "enabled": false,
  "followBoost": true,
  "appId": "你的AppID",
  "clientSecret": "你的ClientSecret",
  "sandbox": true,
  "ownerOpenId": "你的单聊user_openid",
  "listenAddr": "127.0.0.1:8088",
  "shellUrl": "http://127.0.0.1:8080",
  "stateDir": "/var/lib/dhvw/qq-openclaw",
  "sticker": { "enabled": true, "autoCollect": true, "eagerness": 2 }
}`

/**
 * QQ 官方 Bot 登录 / 链接操作提示说明弹窗（遵循 QQ 开放平台官方 APIv2，不扫码登录个人号）。
 */
export function QqBotGuideDialog({
  boost,
  onClose,
}: {
  boost: boolean
  onClose: () => void
}): React.ReactElement {
  const [copied, setCopied] = useState<'url' | 'cfg' | 'cmd' | null>(null)
  const [dontAutoOpen, setDontAutoOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem('dhvw.qqBotGuide.dismissed') === '1'
    } catch {
      return false
    }
  })

  const copyText = (key: 'url' | 'cfg' | 'cmd', text: string): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key)
      setTimeout(() => setCopied(null), 1800)
    })
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
          QQ 官方 Bot 登录与链接指引
          <span className={`pill ${boost ? 'ok' : ''}`}>{boost ? 'BOOST 已联动开启' : 'BOOST 当前关闭'}</span>
        </h2>
        <p className="hint">
          为符合平台规范并保护账号安全，ARM 侧不扫码登录个人 QQ，而是接入 <b>QQ 开放平台官方 Bot APIv2</b>（一期支持单聊 + 图片多模态 + 表情包）。开启桌面端 <b>BOOST ON</b> 即联动激活设备侧 QQ Bot。
        </p>

        <ol className="qq-guide-steps">
          <li>
            <b>登录 QQ 开放平台创建应用：</b>
            浏览器访问 <code className="mono">https://q.qq.com</code> 使用 QQ 登录并创建机器人应用，在「开发管理」复制 <b>AppID</b> 与 <b>ClientSecret</b>。
            <button type="button" className="mini-btn" onClick={() => copyText('url', 'https://q.qq.com')}>
              {copied === 'url' ? '已复制网址' : '复制网址'}
            </button>
          </li>
          <li>
            <b>开通单聊与配置沙箱测试成员：</b>
            在「能力配置」勾选<b>私信 / 单聊（C2C）</b>权限；测试阶段可在「沙箱配置」添加你的 QQ 号作为调试成员，配置保留 <code className="mono">"sandbox": true</code>。
          </li>
          <li>
            <b>绑定主人单聊 OpenID（防陌生人触发）：</b>
            用测试 QQ 给机器人私聊发送一条任意消息，在平台沙箱日志或设备日志（<code className="mono">journalctl -u dhvw-qqbot -n 30</code>）查看忽略提示中的 <code className="mono">openId</code>，填入下方 <code className="mono">ownerOpenId</code>。
          </li>
          <li>
            <b>写入设备配置并启动可选守护进程：</b>
            在 ARM 设备编辑 <code className="mono">/etc/dhvw/qqbot.json</code>（表情图包可放在 <code className="mono">/var/lib/dhvw/qq-openclaw/stickers/</code>），执行命令启用服务：
            <div className="qq-cmd-row">
              <code className="gw-url mono">sudo systemctl enable --now dhvw-qqbot.service</code>
              <button
                type="button"
                className="mini-btn"
                onClick={() => copyText('cmd', 'sudo systemctl enable --now dhvw-qqbot.service')}
              >
                {copied === 'cmd' ? '已复制命令' : '复制命令'}
              </button>
            </div>
          </li>
        </ol>

        <div className="field">
          <label>
            ARM 设备端配置模板（<span className="mono">/etc/dhvw/qqbot.json</span>）
            <button type="button" className="mini-btn" onClick={() => copyText('cfg', QQ_BOT_CONFIG_SAMPLE)}>
              {copied === 'cfg' ? '已复制模板' : '复制 JSON'}
            </button>
          </label>
          <pre className="qq-code-pre mono">{QQ_BOT_CONFIG_SAMPLE}</pre>
        </div>

        <p className="hint">
          健康检查：<code className="mono">curl -s http://127.0.0.1:8088/__qq/health</code>；若设置了 <code className="mono">"followBoost": true</code>，仅当本页 <b>BOOST ON</b> 时才会连线 QQ 网关，关闭 <b>BOOST OFF</b> 自动休眠。
        </p>

        <div className="actions dialog-actions qq-guide-footer">
          <label className="qq-dismiss-check">
            <input
              type="checkbox"
              checked={dontAutoOpen}
              onChange={(e) => toggleDismiss(e.target.checked)}
            />
            开启 BOOST 时不再自动弹出本指引
          </label>
          <button type="button" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
