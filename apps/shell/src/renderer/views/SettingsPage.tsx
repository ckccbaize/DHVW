import React, { useEffect, useState } from 'react'
import type { Live2dModelView, LlmProtocol, ProactiveStateView, QqBotStatusView, SettingsView } from '../../shared/types'
import { SaveBackupPanel } from './SaveBackupPanel'

/** 独立设置页：按模型 / 角色语音 / QQ Bot / 运行 / 存档分类。 */
export function SettingsPage({
  value,
  onSaved,
  onOpenQqGuide,
}: {
  value: SettingsView
  onSaved: (next: SettingsView) => void
  onOpenQqGuide?: () => void
}): React.ReactElement {
  const [protocol, setProtocol] = useState<LlmProtocol>(value.llm.protocol)
  const [baseUrl, setBaseUrl] = useState(value.llm.baseUrl)
  const [model, setModel] = useState(value.llm.model)
  const [manualModel, setManualModel] = useState(!value.llm.model)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [temperature, setTemperature] = useState(String(value.llm.temperature))
  const [olvtPort, setOlvtPort] = useState(String(value.ports.olvt))
  const [ttsPort, setTtsPort] = useState(String(value.ports.tts))
  const [asr, setAsr] = useState(value.asr.enabled)
  const [live2dModel, setLive2dModel] = useState(value.live2d.model)
  const [autoPushScene, setAutoPushScene] = useState(value.scene.autoPush)
  const [proactive, setProactive] = useState(value.proactive)
  const [proactiveState, setProactiveState] = useState<ProactiveStateView | null>(null)
  const [live2dList, setLive2dList] = useState<Live2dModelView[]>([])
  const [charName, setCharName] = useState(value.olvt.characterName)
  const [humanName, setHumanName] = useState(value.olvt.humanName)
  const [persona, setPersona] = useState(value.olvt.personaPrompt)
  const [ttsDir, setTtsDir] = useState(value.tts.backendDir)
  const [refAudio, setRefAudio] = useState(value.tts.refAudioPath)
  const [refText, setRefText] = useState(value.tts.refText)
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(value.llm.hasKey)
  const [qqAppId, setQqAppId] = useState(value.qqBot?.appId || '')
  const [qqSecret, setQqSecret] = useState('')
  const [qqSandbox, setQqSandbox] = useState(value.qqBot?.sandbox ?? true)
  const [qqProactive, setQqProactive] = useState(value.qqBot?.proactive ?? true)
  const [qqEagerness, setQqEagerness] = useState(String(value.qqBot?.stickerEagerness ?? 2))
  const [qqStatus, setQqStatus] = useState<QqBotStatusView | null>(null)
  const [qqMsg, setQqMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshLive2d = async (): Promise<void> => {
    const res = await window.dhvw.live2dModels()
    setLive2dList(res.models)
    if (res.models.length > 0 && !res.models.some((m) => m.id === live2dModel)) {
      setLive2dModel(res.current ?? res.models[0]?.id ?? live2dModel)
    }
  }

  /** 弹系统选择框；取消就什么都不改，也不报错 */
  const pick = async (
    kind: 'dir' | 'file',
    title: string,
    apply: (p: string) => void,
    extra?: { defaultPath?: string; filters?: Array<{ name: string; extensions: string[] }> },
  ): Promise<void> => {
    const res = await window.dhvw.pickPath({
      kind,
      title,
      defaultPath: extra?.defaultPath?.trim() || undefined,
      filters: extra?.filters,
    })
    if (res.ok && res.path) apply(res.path)
  }

  useEffect(() => {
    let alive = true
    const load = (): void => {
      void window.dhvw.proactiveState().then((res) => {
        if (alive) setProactiveState(res)
      })
      void window.dhvw.qqBotStatus().then((st) => {
        if (alive) setQqStatus(st)
      })
    }
    load()
    const timer = window.setInterval(load, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    void refreshLive2d()
    // 只在进入设置页时取一次；换模型后由「刷新模型列表」重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fetchModels = async (): Promise<void> => {
    setLoadingModels(true)
    setMsg(null)
    try {
      const res = await window.dhvw.listModels({
        baseUrl,
        protocol,
        // 界面上刚输入还没保存的密钥也允许直接试用
        apiKey: key.trim() || undefined,
      })
      if (!res.ok) {
        setMsg({ ok: false, text: `拉取失败：${res.error ?? '未知原因'}` })
        return
      }
      setModels(res.models)
      if (!res.models.includes(model)) setModel(res.models[0] ?? model)
      setManualModel(false)
      setMsg({ ok: true, text: `拉到 ${res.models.length} 个模型（${res.url ?? ''}）` })
    } finally {
      setLoadingModels(false)
    }
  }

  const saveKey = async (): Promise<void> => {
    const res = await window.dhvw.saveApiKey(key)
    if (res.ok) {
      setHasKey(true)
      setKey('')
      setMsg({ ok: true, text: 'API Key 已加密保存' })
    } else {
      setMsg({ ok: false, text: res.error ?? '保存失败' })
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      if (key.trim() && !hasKey) await window.dhvw.saveApiKey(key).then((r) => r.ok && setHasKey(true))
      const res = await window.dhvw.saveSettings({
        llm: { protocol, baseUrl, model, temperature: Number(temperature) },
        ports: { olvt: Number(olvtPort), tts: Number(ttsPort) },
        asr: { enabled: asr },
        live2d: { model: live2dModel },
        scene: { autoPush: autoPushScene },
        proactive,
        olvt: { characterName: charName, humanName, personaPrompt: persona },
        tts: { backendDir: ttsDir, refAudioPath: refAudio, refText },
      })
      if (!res.ok || !res.settings) {
        setMsg({ ok: false, text: res.error ?? '保存失败' })
        return
      }
      onSaved(res.settings)
      setMsg({ ok: true, text: '已保存（端口类改动需重启宿主生效）' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-page">
      <div className="settings-head">
        <div>
          <h2>设置</h2>
          <p className="hint">按类别修改；保存后立即写入本机配置。</p>
        </div>
        <div className="actions">
          <button className="primary" disabled={busy} onClick={() => void save()}>
            保存设置
          </button>
        </div>
      </div>

      <section className="panel settings-section">
        <div className="section-head">
          <h2>模型与密钥</h2>
        </div>
        <div className="row2">
          <div className="field">
            <label>协议</label>
            <select
              value={protocol}
              onChange={(e) => {
                setProtocol(e.target.value as LlmProtocol)
                setModels([])
                setManualModel(true)
              }}
            >
              <option value="openai-compatible">OpenAI 兼容</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <div className="field">
            <label>temperature</label>
            <input value={temperature} onChange={(e) => setTemperature(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>调用端点（全局）</label>
          <div className="row2 tight">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} spellCheck={false} />
            <button disabled={loadingModels || !baseUrl.trim()} onClick={() => void fetchModels()}>
              {loadingModels ? '拉取中…' : '拉取模型'}
            </button>
          </div>
        </div>

        <div className="field">
          <label>模型</label>
          {!manualModel && models.length > 0 ? (
            <div className="row2 tight">
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button onClick={() => setManualModel(true)}>手动输入</button>
            </div>
          ) : (
            <div className="row2 tight">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="先拉取列表，或直接填写模型名"
                spellCheck={false}
              />
              {models.length > 0 && <button onClick={() => setManualModel(false)}>从列表选</button>}
            </div>
          )}
        </div>

        <div className="field">
          <label>
            API Key
            <span className={`pill ${hasKey ? 'ok' : ''}`}>{hasKey ? '已配置' : '未配置'}</span>
          </label>
          <div className="row2 tight">
            <input
              type="password"
              placeholder={hasKey ? '输入新密钥可覆盖' : 'sk-...'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              spellCheck={false}
            />
            <button disabled={!key.trim()} onClick={() => void saveKey()}>
              保存密钥
            </button>
            <button
              disabled={!hasKey}
              onClick={() =>
                void window.dhvw.clearApiKey().then(() => {
                  setHasKey(false)
                  setMsg({ ok: true, text: '密钥已清除' })
                })
              }
            >
              清除
            </button>
          </div>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="section-head">
          <h2>角色与语音</h2>
        </div>
        <div className="row2">
          <div className="field">
            <label>角色名</label>
            <input value={charName} onChange={(e) => setCharName(e.target.value)} />
          </div>
          <div className="field">
            <label>称呼用户</label>
            <input value={humanName} onChange={(e) => setHumanName(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>Live2D 模型（PC 舞台与 OLVT 共用）</label>
          <div className="row2 tight">
            <select value={live2dModel} onChange={(e) => setLive2dModel(e.target.value)}>
              {!live2dList.some((m) => m.id === live2dModel) && <option value={live2dModel}>{live2dModel}</option>}
              {live2dList.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id} · {m.source === 'bundled' ? '随包' : '组件'}
                </option>
              ))}
            </select>
            <button onClick={() => void refreshLive2d()}>刷新模型列表</button>
          </div>
          <div className="actions">
            <button
              onClick={() =>
                void window.dhvw.openLive2dDir().then((res) => {
                  setMsg(
                    res.ok
                      ? { ok: true, text: `已打开模型目录：${res.path}` }
                      : { ok: false, text: res.error || '打开模型目录失败' },
                  )
                })
              }
            >
              打开模型文件夹
            </button>
          </div>
          <p className="hint">
            直接把模型文件夹放进打开的模型目录（包含 <code>runtime/*.model3.json</code> 或根目录
            <code>*.model3.json</code>），然后点「刷新模型列表」选用。
          </p>
        </div>
        <div className="field">
          <label>人设</label>
          <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={4} spellCheck={false} />
        </div>
        <div className="field">
          <label>语音合成后端目录（GPT-SoVITS，留空则用内置占位）</label>
          <div className="row2 tight">
            <input value={ttsDir} onChange={(e) => setTtsDir(e.target.value)} spellCheck={false} placeholder="如 D:\tts\GPT-SoVITS" />
            <button
              onClick={() => void pick('dir', '选择 GPT-SoVITS 目录', setTtsDir, { defaultPath: ttsDir })}
            >
              选择文件夹
            </button>
          </div>
        </div>
        <div className="field">
          <label>参考音色（GPT-SoVITS，留空则用服务默认）</label>
          <div className="row2 tight">
            <input value={refAudio} onChange={(e) => setRefAudio(e.target.value)} spellCheck={false} />
            <button
              onClick={() =>
                void pick('file', '选择参考音色音频', setRefAudio, {
                  defaultPath: refAudio,
                  filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }],
                })
              }
            >
              选择文件
            </button>
          </div>
        </div>
        <div className="field">
          <label>参考音色文本</label>
          <input value={refText} onChange={(e) => setRefText(e.target.value)} spellCheck={false} />
        </div>
        <label className="switch">
          <input type="checkbox" checked={asr} onChange={(e) => setAsr(e.target.checked)} />
          启用语音识别（ASR）{!value.asr.ready && asr ? '（模型未下载，需在信息页组件面板安装）' : ''}
        </label>
      </section>

      <section className="panel settings-section">
        <div className="section-head">
          <h2>显现时主动说话（仅 OLVT）</h2>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={proactive.enabled}
            onChange={(e) => setProactive({ ...proactive, enabled: e.target.checked })}
          />
          允许角色在没有对话时自己开口
        </label>
        <p className="hint">
          只有设备处于「显现」且 OLVT / TTS 就绪时才会真的说话；总观模式、静默时段、触达上限都会自动闭麦。
          说话节奏跟着空闲时间走，连续没人接话会逐步拉长间隔。
        </p>
        <div className="row2">
          <div className="field">
            <label>空闲多久后开口（秒）</label>
            <input
              value={String(proactive.idleSeconds)}
              onChange={(e) => setProactive({ ...proactive, idleSeconds: Number(e.target.value) })}
              inputMode="numeric"
            />
          </div>
          <div className="field">
            <label>两次主动说话的最短间隔（秒）</label>
            <input
              value={String(proactive.gapSeconds)}
              onChange={(e) => setProactive({ ...proactive, gapSeconds: Number(e.target.value) })}
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>最多退避到（秒）</label>
            <input
              value={String(proactive.maxGapSeconds)}
              onChange={(e) => setProactive({ ...proactive, maxGapSeconds: Number(e.target.value) })}
              inputMode="numeric"
            />
          </div>
          <div className="field">
            <label>每天上限（次）</label>
            <input
              value={String(proactive.dailyMax)}
              onChange={(e) => setProactive({ ...proactive, dailyMax: Number(e.target.value) })}
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="row2">
          <div className="field">
            <label>静默开始</label>
            <input
              value={proactive.quietStart}
              onChange={(e) => setProactive({ ...proactive, quietStart: e.target.value })}
              placeholder="23:30"
            />
          </div>
          <div className="field">
            <label>静默结束</label>
            <input
              value={proactive.quietEnd}
              onChange={(e) => setProactive({ ...proactive, quietEnd: e.target.value })}
              placeholder="07:30"
            />
          </div>
        </div>
        <p className="hint">{describeProactive(proactiveState)}</p>
      </section>

      <section className="panel settings-section">
        <div className="section-head">
          <h2>运行与地图</h2>
        </div>
        <div className="row2">
          <div className="field">
            <label>OLVT 端口（0 = 自动）</label>
            <input value={olvtPort} onChange={(e) => setOlvtPort(e.target.value)} />
          </div>
          <div className="field">
            <label>TTS 端口（0 = 自动）</label>
            <input value={ttsPort} onChange={(e) => setTtsPort(e.target.value)} />
          </div>
        </div>
        <label className="switch">
          <input type="checkbox" checked={autoPushScene} onChange={(e) => setAutoPushScene(e.target.checked)} />
          自动推送生成的地图到设备
        </label>
        <p className="hint">
          {autoPushScene
            ? '开：核验通过即推送；设备离线时排队，上线后自动重试直到成功。'
            : '关：生成后必须在 Agent 页「产出验收」里手动点「提交 ARM 侧」。'}
        </p>
      </section>

      <section className="panel settings-section">
        <div className="section-head">
          <h2>
            QQ 官方 Bot（Boost 单聊互动）
            <span className={`pill ${qqStatus?.paired ? 'ok' : ''}`}>
              {qqStatus?.paired
                ? `已绑定 · ${qqStatus.ownerOpenIdMasked || '主人'}`
                : qqStatus?.pairingCode
                  ? `待绑定口令 ${qqStatus.pairingCode}`
                  : qqStatus?.configured
                    ? '待 ARM 上线'
                    : '未配置'}
            </span>
          </h2>
          {onOpenQqGuide && (
            <button type="button" onClick={onOpenQqGuide}>
              打开注册与绑定向导
            </button>
          )}
        </div>
        <div className="row2">
          <div className="field">
            <label>AppID</label>
            <input value={qqAppId} onChange={(e) => setQqAppId(e.target.value)} placeholder="QQ 开放平台机器人 AppID" />
          </div>
          <div className="field">
            <label>ClientSecret</label>
            <input
              type="password"
              value={qqSecret}
              onChange={(e) => setQqSecret(e.target.value)}
              placeholder={value.qqBot?.hasSecret ? '已加密保存（留空保留）' : '填写机器人 AppSecret'}
            />
          </div>
        </div>
        <div className="row2">
          <label className="switch">
            <input type="checkbox" checked={qqSandbox} onChange={(e) => setQqSandbox(e.target.checked)} />
            沙箱模式
          </label>
          <label className="switch">
            <input type="checkbox" checked={qqProactive} onChange={(e) => setQqProactive(e.target.checked)} />
            允许心情 / 世界事件主动发 QQ 消息
          </label>
          <div className="field" style={{ maxWidth: 160 }}>
            <label>表情包积极度 (0~3)</label>
            <input value={qqEagerness} onChange={(e) => setQqEagerness(e.target.value)} inputMode="numeric" />
          </div>
        </div>
        {qqMsg && <p className={`msg ${qqMsg.ok ? 'ok' : 'bad'}`}>{qqMsg.text}</p>}
        <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true)
                setQqMsg(null)
                try {
                  const res = await window.dhvw.qqBotSave({
                    appId: qqAppId.trim(),
                    clientSecret: qqSecret.trim() || undefined,
                    sandbox: qqSandbox,
                    proactive: qqProactive,
                    stickerEagerness: Number(qqEagerness),
                  })
                  if (!res.ok) {
                    setQqMsg({ ok: false, text: res.error || '保存失败' })
                    return
                  }
                  if (res.settings) onSaved(res.settings)
                  if (res.status) setQqStatus(res.status)
                  setQqSecret('')
                  setQqMsg({ ok: true, text: 'QQ Bot 配置已加密保存并同步给 ARM 设备' })
                } finally {
                  setBusy(false)
                }
              })()
            }
          >
            保存 QQ Bot 配置
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true)
                setQqMsg(null)
                try {
                  const res = await window.dhvw.qqBotRebind()
                  if (res.settings) onSaved(res.settings)
                  if (res.status) setQqStatus(res.status)
                  setQqMsg({
                    ok: true,
                    text: res.status?.pairingCode
                      ? `已清空旧绑定，请在 QQ 私聊发送新口令：${res.status.pairingCode}`
                      : '已下发重新绑定指令，请在向导弹窗中查看新配对口令',
                  })
                  onOpenQqGuide?.()
                } finally {
                  setBusy(false)
                }
              })()
            }
          >
            重新绑定 QQ（解除旧绑定）
          </button>
        </div>
      </section>

      <SaveBackupPanel />

      {msg && <p className={`msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
      <div className="actions settings-actions">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          保存设置
        </button>
      </div>
    </div>
  )
}

/** 把编排器 + OLVT 的自报状态翻成人话；没有数据就直说没有 */
function describeProactive(state: ProactiveStateView | null): string {
  if (!state) return '正在读取主动说话状态…'
  if (state.error) return `主动说话状态不可用：${state.error}`
  const olvt = state.olvt
  const head =
    state.display === 'present'
      ? '当前：显现模式'
      : '当前：总观模式（主动说话自动关闭，切到显现后恢复）'
  if (!olvt?.reachable) return `${head}；OLVT 未连接（${olvt?.error || '服务未启动'}）`
  const bits = [head, olvt.enabled ? 'OLVT 已开启主动说话' : 'OLVT 侧当前关闭主动说话']
  if (typeof olvt.clients === 'number') bits.push(`在线客户端 ${olvt.clients}`)
  if (typeof olvt.dailyCount === 'number') bits.push(`今日开口 ${olvt.dailyCount} 次`)
  if (typeof olvt.lastSpokeSecondsAgo === 'number') bits.push(`${Math.round(olvt.lastSpokeSecondsAgo)} 秒前说过话`)
  if (olvt.reason) bits.push(`待发理由：${olvt.reason}`)
  return bits.join('；')
}
