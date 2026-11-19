import React, { useEffect, useRef, useState } from 'react'

function base64ToBlobUrl(base64: string, mime = 'audio/wav'): string {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}
import type {
  Live2dModelView,
  LlmMode,
  LlmProtocol,
  ProactiveStateView,
  QqBotStatusView,
  SettingsView,
} from '../../shared/types'
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
  const [llmMode, setLlmMode] = useState<LlmMode>(value.llmMode ?? 'api')
  const [protocol, setProtocol] = useState<LlmProtocol>(value.llm.protocol)
  const [baseUrl, setBaseUrl] = useState(value.llm.baseUrl)
  const [model, setModel] = useState(value.llm.model)
  const [manualModel, setManualModel] = useState(!value.llm.model)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [temperature, setTemperature] = useState(String(value.llm.temperature))
  const [olvtPort, setOlvtPort] = useState(String(value.ports.olvt))
  const [ttsPort, setTtsPort] = useState(String(value.ports.tts))
  const [llamaPort, setLlamaPort] = useState(String(value.ports.llama ?? 8089))
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
  const [refLang, setRefLang] = useState(value.tts.refLang || 'zh')
  const [textLang, setTextLang] = useState(value.tts.textLang || 'zh')
  const [sampleText, setSampleText] = useState('你好呀，我是你的数字伙伴，现在测试一下新的音色效果。')
  const [audioDuration, setAudioDuration] = useState<number | null>(null)
  const [refAudioSrc, setRefAudioSrc] = useState<string | null>(null)
  const [synthAudioSrc, setSynthAudioSrc] = useState<string | null>(null)
  const refAudioEl = useRef<HTMLAudioElement | null>(null)
  const synthAudioEl = useRef<HTMLAudioElement | null>(null)

  const updateRefAudioSrc = (next: string | null, autoPlay = false): void => {
    setRefAudioSrc((prev) => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return next
    })
    if (next && autoPlay) {
      queueMicrotask(() => {
        if (refAudioEl.current) {
          refAudioEl.current.currentTime = 0
          void refAudioEl.current.play().catch(() => {})
        }
      })
    }
  }
  const updateSynthAudioSrc = (next: string | null, autoPlay = false): void => {
    setSynthAudioSrc((prev) => {
      if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
      return next
    })
    if (next && autoPlay) {
      queueMicrotask(() => {
        if (synthAudioEl.current) {
          synthAudioEl.current.currentTime = 0
          void synthAudioEl.current.play().catch(() => {})
        }
      })
    }
  }
  const [ttsMsg, setTtsMsg] = useState<{ ok: boolean; text: string; canClip?: boolean } | null>(null)
  const [testingTts, setTestingTts] = useState(false)
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

  useEffect(() => {
    setLlmMode(value.llmMode ?? 'api')
    setProtocol(value.llm.protocol)
    setBaseUrl(value.llm.baseUrl)
    setModel(value.llm.model)
    setTemperature(String(value.llm.temperature))
    setOlvtPort(String(value.ports.olvt))
    setTtsPort(String(value.ports.tts))
    setLlamaPort(String(value.ports.llama ?? 8089))
    setCharName(value.olvt.characterName)
    setHumanName(value.olvt.humanName)
    setPersona(value.olvt.personaPrompt)
    setTtsDir(value.tts.backendDir)
    setRefAudio(value.tts.refAudioPath)
    setRefText(value.tts.refText)
    setRefLang(value.tts.refLang || 'zh')
    setTextLang(value.tts.textLang || 'zh')
    setRefAudioSrc(null)
    setSynthAudioSrc(null)
  }, [
    value.llmMode,
    value.llm.protocol,
    value.llm.baseUrl,
    value.llm.model,
    value.llm.temperature,
    value.ports.olvt,
    value.ports.tts,
    value.ports.llama,
    value.olvt.characterName,
    value.olvt.humanName,
    value.olvt.personaPrompt,
    value.tts.backendDir,
    value.tts.refAudioPath,
    value.tts.refText,
    value.tts.refLang,
    value.tts.textLang,
  ])

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
        ports: { olvt: Number(olvtPort), tts: Number(ttsPort), llama: Number(llamaPort) },
        asr: { enabled: asr },
        live2d: { model: live2dModel },
        scene: { autoPush: autoPushScene },
        proactive,
        olvt: { characterName: charName, humanName, personaPrompt: persona },
        tts: { backendDir: ttsDir, refAudioPath: refAudio, refText, refLang, textLang },
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

  const switchMode = async (target: LlmMode): Promise<void> => {
    if (busy || target === llmMode) return
    setBusy(true)
    setMsg(null)
    try {
      if (llmMode === 'api' && target === 'local' && /^https?:\/\/[^\s]+$/.test(baseUrl.trim())) {
        const dirty =
          baseUrl.trim() !== value.llm.baseUrl ||
          model.trim() !== value.llm.model ||
          protocol !== value.llm.protocol ||
          Number(temperature) !== value.llm.temperature
        if (dirty) {
          const tempNum = Number(temperature)
          await window.dhvw.saveSettings({
            llm: {
              protocol,
              baseUrl: baseUrl.trim(),
              ...(model.trim() ? { model: model.trim() } : {}),
              ...(Number.isFinite(tempNum) && tempNum >= 0 && tempNum <= 2 ? { temperature: tempNum } : {}),
            },
          })
        }
      }
      const res = await window.dhvw.switchLlmMode(target)
      if (!res.ok || !res.settings) {
        setMsg({ ok: false, text: res.error ?? '切换失败' })
        return
      }
      setModels([])
      onSaved(res.settings)
      setMsg({
        ok: true,
        text:
          target === 'local'
            ? `已切换至本地 llama (${res.model ?? value.localLlmModel})，并同步 PC 与 ARM 端`
            : `已切换至云端 API (${res.baseUrl ?? res.settings.llm.baseUrl})，并同步 PC 与 ARM 端`,
      })
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
          <div className="mode-switch" role="group" aria-label="LLM 调用模式">
            <button
              type="button"
              className={llmMode === 'api' ? 'mode-btn active' : 'mode-btn'}
              disabled={busy}
              onClick={() => void switchMode('api')}
            >
              云端 API
            </button>
            <button
              type="button"
              className={llmMode === 'local' ? 'mode-btn active' : 'mode-btn'}
              disabled={busy}
              onClick={() => void switchMode('local')}
            >
              本地推理 (llama)
            </button>
          </div>
        </div>

        {llmMode === 'local' ? (
          <p className="hint" style={{ marginTop: 0 }}>
            当前使用本机 llama-server（{baseUrl} · 模型 {model || value.localLlmModel}），已通过网关/编排器同步提交 ARM 侧代理调用。原有云端 API（
            {value.llmApi.baseUrl || '未配置'}）已保留，点击上方「云端 API」可随时一键切回。
          </p>
        ) : !value.localLlmReady ? (
          <p className="hint" style={{ marginTop: 0 }}>
            如需一键切换本地推理，请先在「信息 → 组件」下载或放入 <code>llama-server.exe</code> 与 <code>{value.localLlmModel}</code> 模型文件。
          </p>
        ) : null}

        <div className="row2">
          <div className="field">
            <label>协议</label>
            <select
              value={protocol}
              disabled={llmMode === 'local'}
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
            <input
              value={baseUrl}
              readOnly={llmMode === 'local'}
              onChange={(e) => setBaseUrl(e.target.value)}
              spellCheck={false}
            />
            {llmMode === 'api' && (
              <button disabled={loadingModels || !baseUrl.trim()} onClick={() => void fetchModels()}>
                {loadingModels ? '拉取中…' : '拉取模型'}
              </button>
            )}
          </div>
        </div>

        <div className="field">
          <label>模型</label>
          {llmMode === 'local' ? (
            <input value={model} readOnly spellCheck={false} />
          ) : !manualModel && models.length > 0 ? (
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

        {llmMode === 'api' && (
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
        )}
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
          <p className="hint">
            需要导入/导出酒馆 PNG 角色卡、使用 Agent 联网编写人设或管理 L0 核心记忆，请前往顶部「Agent」→「角色人设与 L0 记忆」。
          </p>
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
          <label>参考音色（GPT-SoVITS 要求 3~10 秒，留空则用服务默认）</label>
          <div className="row2 tight">
            <input
              value={refAudio}
              onChange={(e) => {
                setRefAudio(e.target.value)
                setAudioDuration(null)
                setRefAudioSrc(null)
                setSynthAudioSrc(null)
              }}
              spellCheck={false}
            />
            <button
              onClick={() =>
                void pick(
                  'file',
                  '选择参考音色音频',
                  (picked) => {
                    setRefAudio(picked)
                    setTtsMsg(null)
                    setRefAudioSrc(null)
                    setSynthAudioSrc(null)
                    void window.dhvw.inspectAudio(picked, ttsDir).then(async (info) => {
                      const d = info.duration ?? null
                      setAudioDuration(d)
                      if (d !== null && (d < 3 || d > 10)) {
                        setTtsMsg({
                          ok: false,
                          canClip: d > 10,
                          text: `该参考音频时长 ${d.toFixed(2)}s，超出 GPT-SoVITS 允许的 3~10 秒范围，直接使用会报 400 失败`,
                        })
                        return
                      }
                      const raw = await window.dhvw.readRefAudio(picked, ttsDir)
                      if (raw.ok && raw.audioBase64) {
                        updateRefAudioSrc(base64ToBlobUrl(raw.audioBase64, raw.mime || 'audio/wav'))
                      }
                    })
                  },
                  {
                    defaultPath: refAudio,
                    filters: [{ name: '音频', extensions: ['wav', 'mp3', 'flac', 'ogg', 'm4a'] }],
                  },
                )
              }
            >
              选择文件
            </button>
          </div>
          <div className="actions" style={{ marginTop: 6 }}>
            <button
              type="button"
              disabled={!refAudio.trim()}
              onClick={() =>
                void (async () => {
                  setTtsMsg(null)
                  const raw = await window.dhvw.readRefAudio(refAudio, ttsDir)
                  if (typeof raw.duration === 'number') setAudioDuration(raw.duration)
                  if (!raw.ok || !raw.audioBase64) {
                    updateRefAudioSrc(null)
                    setTtsMsg({
                      ok: false,
                      canClip: raw.canClip,
                      text: raw.error ?? '无法读取参考音频',
                    })
                    return
                  }
                  const src = base64ToBlobUrl(raw.audioBase64, raw.mime || 'audio/wav')
                  updateRefAudioSrc(src, true)
                  setTtsMsg({
                    ok: true,
                    text: '正在播放参考原音，请对照核对下方「参考音色文本」',
                  })
                })()
              }
            >
              试听参考原音
            </button>
            <button
              type="button"
              disabled={testingTts || !refAudio.trim()}
              onClick={() =>
                void (async () => {
                  setTestingTts(true)
                  setTtsMsg(null)
                  try {
                    const res = await window.dhvw.testTts({
                      refAudioPath: refAudio,
                      refText,
                      refLang,
                      textLang,
                      sampleText: sampleText.trim() || undefined,
                    })
                    if (typeof res.duration === 'number') setAudioDuration(res.duration)
                    if (!res.ok) {
                      setTtsMsg({
                        ok: false,
                        canClip: res.canClip,
                        text: res.error ?? '音色测试失败',
                      })
                      return
                    }
                    setTtsMsg({
                      ok: true,
                      text: `试听合成成功（${Math.round((res.bytes ?? 0) / 1024)} KB），保存设置后显现模式立即生效`,
                    })
                    if (res.audioBase64) {
                      updateSynthAudioSrc(base64ToBlobUrl(res.audioBase64, 'audio/wav'), true)
                    }
                  } finally {
                    setTestingTts(false)
                  }
                })()
              }
            >
              {testingTts ? '合成中…' : '试听合成音色'}
            </button>
          </div>
          {audioDuration !== null && (
            <p className="hint">
              当前音频时长：{audioDuration.toFixed(2)} 秒（要求 3~10 秒）
            </p>
          )}
          {refAudioSrc && (
            <div style={{ marginTop: 6 }}>
              <span className="hint">参考原音试听（请核对与下方文本一致）：</span>
              <audio ref={refAudioEl} controls src={refAudioSrc} style={{ width: '100%', height: 32, marginTop: 4 }} />
            </div>
          )}
          {synthAudioSrc && (
            <div style={{ marginTop: 6 }}>
              <span className="hint">合成试听效果：</span>
              <audio ref={synthAudioEl} controls src={synthAudioSrc} style={{ width: '100%', height: 32, marginTop: 4 }} />
            </div>
          )}
        </div>
        <div className="field">
          <label>参考音色文本（需与剪切后或 3~10 秒参考音频的朗读内容一致）</label>
          <input value={refText} onChange={(e) => setRefText(e.target.value)} spellCheck={false} />
        </div>
        <div className="field">
          <label>试听合成台词（点“试听合成音色”时让角色念的文本）</label>
          <input value={sampleText} onChange={(e) => setSampleText(e.target.value)} spellCheck={false} />
        </div>
        <div className="row2">
          <div className="field">
            <label>参考音频语种 (prompt_lang)</label>
            <select value={refLang} onChange={(e) => setRefLang(e.target.value)}>
              <option value="zh">zh（中文）</option>
              <option value="all_zh">all_zh（纯中文）</option>
              <option value="ja">ja（日语）</option>
              <option value="all_ja">all_ja（纯日语）</option>
              <option value="en">en（英语）</option>
              <option value="yue">yue（粤语）</option>
              <option value="ko">ko（韩语）</option>
              <option value="auto">auto（自动）</option>
            </select>
          </div>
          <div className="field">
            <label>合成输出语种 (text_lang)</label>
            <select value={textLang} onChange={(e) => setTextLang(e.target.value)}>
              <option value="zh">zh（中文）</option>
              <option value="all_zh">all_zh（纯中文）</option>
              <option value="ja">ja（日语）</option>
              <option value="en">en（英语）</option>
              <option value="yue">yue（粤语）</option>
              <option value="ko">ko（韩语）</option>
              <option value="auto">auto（自动）</option>
            </select>
          </div>
        </div>
        {ttsMsg && (
          <div className="field">
            <p className={`msg ${ttsMsg.ok ? 'ok' : 'bad'}`}>{ttsMsg.text}</p>
            {ttsMsg.canClip && (
              <div className="actions">
                <button
                  type="button"
                  onClick={() =>
                    void window.dhvw.clipRefAudio(refAudio, 8.5, ttsDir).then((r) => {
                      if (!r.ok || !r.path) {
                        setTtsMsg({ ok: false, text: r.error ?? '裁剪失败' })
                        return
                      }
                      setRefAudio(r.path)
                      setAudioDuration(r.duration ?? 8.5)
                      updateSynthAudioSrc(null)
                      if (r.audioBase64) {
                        updateRefAudioSrc(base64ToBlobUrl(r.audioBase64, r.mime || 'audio/wav'), true)
                      }
                      setTtsMsg({
                        ok: true,
                        text: `已裁剪前 ${(r.duration ?? 8.5).toFixed(2)} 秒并切换为 ${r.path}，已自动播放，请对照修改下方参考音色文本后点保存`,
                      })
                    })
                  }
                >
                  一键截取前 8.5 秒存为 WAV 并选用
                </button>
              </div>
            )}
          </div>
        )}
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
          <div className="field">
            <label>本地 llama 端口（默认 8088）</label>
            <input value={llamaPort} onChange={(e) => setLlamaPort(e.target.value)} />
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
                : qqStatus?.configured
                  ? '待 QQ 首条激活消息'
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
                    text: '已解除旧 QQ 绑定！现在用新 QQ 给机器人私聊发任意一条激活消息即可完成重新绑定',
                  })
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
