import React, { useEffect, useRef, useState } from 'react'

function base64ToBlobUrl(base64: string, mime = 'audio/wav'): string {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}
import type {
  CharacterSheetView,
  ImageGenProtocol,
  Live2dModelView,
  LlmMode,
  LlmProtocol,
  ProactiveStateView,
  QqBotStatusView,
  SettingsView,
} from '../../shared/types'
import { DEFAULT_FUSION_STYLE_PROMPT } from '../../shared/types'
import { SaveBackupPanel } from './SaveBackupPanel'

/** 独立设置页：按模型 / 角色语音 / QQ Bot / 运行 / 存档分类。 */
export function SettingsPage({
  value,
  onSaved,
  onOpenQqGuide,
  onOpenFeishuGuide,
}: {
  value: SettingsView
  onSaved: (next: SettingsView) => void
  onOpenQqGuide?: () => void
  onOpenFeishuGuide?: () => void
}): React.ReactElement {
  const [llmMode, setLlmMode] = useState<LlmMode>(value.llmMode ?? 'api')
  const [protocol, setProtocol] = useState<LlmProtocol>(value.llm.protocol)
  const [baseUrl, setBaseUrl] = useState(value.llm.baseUrl)
  const [model, setModel] = useState(value.llm.model)
  const [manualModel, setManualModel] = useState(!value.llm.model)
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [temperature, setTemperature] = useState(String(value.llm.temperature))
  const [supportsVision, setSupportsVision] = useState(Boolean(value.llm.supportsVision))
  const [igEnabled, setIgEnabled] = useState(Boolean(value.imageGen?.enabled))
  const [igProtocol, setIgProtocol] = useState<ImageGenProtocol>(value.imageGen?.protocol ?? 'openai-images')
  const [igBaseUrl, setIgBaseUrl] = useState(value.imageGen?.baseUrl ?? '')
  const [igModel, setIgModel] = useState(value.imageGen?.model ?? '')
  const [igFusionStyle, setIgFusionStyle] = useState(value.imageGen?.fusionStylePrompt ?? DEFAULT_FUSION_STYLE_PROMPT)
  const [igModels, setIgModels] = useState<string[]>([])
  const [igManualModel, setIgManualModel] = useState(!(value.imageGen?.model ?? ''))
  const [igLoadingModels, setIgLoadingModels] = useState(false)
  const [igKey, setIgKey] = useState('')
  const [igHasKey, setIgHasKey] = useState(Boolean(value.imageGen?.hasKey))
  const [ref3dDataUrl, setRef3dDataUrl] = useState<string | null>(null)
  const [ref3dBusy, setRef3dBusy] = useState(false)
  const [olvtPort, setOlvtPort] = useState(String(value.ports.olvt))
  const [ttsPort, setTtsPort] = useState(String(value.ports.tts))
  const [llamaPort, setLlamaPort] = useState(String(value.ports.llama ?? 8089))
  const [asr, setAsr] = useState(value.asr.enabled)
  const [live2dModel, setLive2dModel] = useState(value.live2d.model)
  const [pixelCharacterId, setPixelCharacterId] = useState(value.pixelCharacterId ?? '')
  const [pixelCharList, setPixelCharList] = useState<CharacterSheetView[]>([])
  const [pixelApplyBusy, setPixelApplyBusy] = useState(false)
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
  const [boostQq, setBoostQq] = useState(value.boost?.gateways?.qq ?? true)
  const [boostFeishu, setBoostFeishu] = useState(value.boost?.gateways?.feishu ?? false)
  const [fsAppId, setFsAppId] = useState(value.feishuBot?.appId || '')
  const [fsSecret, setFsSecret] = useState('')
  const [fsProactive, setFsProactive] = useState(value.feishuBot?.proactive ?? true)
  const [fsMsg, setFsMsg] = useState<{ ok: boolean; text: string } | null>(null)
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

  const refreshPixelChars = async (): Promise<void> => {
    const res = await window.dhvw.characters()
    if (res.ok) {
      setPixelCharList(res.characters)
      if (!pixelCharacterId && res.activeId) {
        setPixelCharacterId(res.activeId)
      }
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
    void refreshPixelChars()
    void window.dhvw.characterRef3dGet().then((r) => {
      if (r.ok && r.hasRef3d && r.dataUrl) setRef3dDataUrl(r.dataUrl)
    })
    // 只在进入设置页时取一次；换模型后由「刷新模型列表」重取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    setLlmMode(value.llmMode ?? 'api')
    setProtocol(value.llm.protocol)
    setBaseUrl(value.llm.baseUrl)
    setModel(value.llm.model)
    setTemperature(String(value.llm.temperature))
    setSupportsVision(Boolean(value.llm.supportsVision))
    setIgEnabled(Boolean(value.imageGen?.enabled))
    setIgProtocol(value.imageGen?.protocol ?? 'openai-images')
    setIgBaseUrl(value.imageGen?.baseUrl ?? '')
    setIgModel(value.imageGen?.model ?? '')
    setIgFusionStyle(value.imageGen?.fusionStylePrompt ?? DEFAULT_FUSION_STYLE_PROMPT)
    setIgHasKey(Boolean(value.imageGen?.hasKey))
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
    setPixelCharacterId(value.pixelCharacterId ?? '')
    setRefAudioSrc(null)
    setSynthAudioSrc(null)
  }, [
    value.llmMode,
    value.llm.protocol,
    value.llm.baseUrl,
    value.llm.model,
    value.llm.temperature,
    value.llm.supportsVision,
    value.imageGen?.enabled,
    value.imageGen?.protocol,
    value.imageGen?.baseUrl,
    value.imageGen?.model,
    value.imageGen?.fusionStylePrompt,
    value.imageGen?.hasKey,
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
    value.pixelCharacterId,
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

  const fetchImageModels = async (): Promise<void> => {
    setIgLoadingModels(true)
    setMsg(null)
    try {
      const targetBase = igBaseUrl.trim() || baseUrl.trim()
      const res = await window.dhvw.listImageModels({
        baseUrl: targetBase,
        apiKey: igKey.trim() || undefined,
      })
      if (!res.ok) {
        setMsg({ ok: false, text: `拉取生图模型失败：${res.error ?? '未知原因'}` })
        return
      }
      setIgModels(res.models)
      if (!res.models.includes(igModel)) setIgModel(res.models[0] ?? igModel)
      setIgManualModel(false)
      setMsg({ ok: true, text: `拉到 ${res.models.length} 个模型（已优先置顶生图模型）` })
    } finally {
      setIgLoadingModels(false)
    }
  }

  const saveIgKey = async (): Promise<void> => {
    const res = await window.dhvw.saveImageGenKey(igKey)
    if (res.ok) {
      setIgHasKey(true)
      setIgKey('')
      setMsg({ ok: true, text: '生图模型 API Key 已加密保存' })
    } else {
      setMsg({ ok: false, text: res.error ?? '保存失败' })
    }
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      if (key.trim() && !hasKey) await window.dhvw.saveApiKey(key).then((r) => r.ok && setHasKey(true))
      if (igKey.trim() && !igHasKey) await window.dhvw.saveImageGenKey(igKey).then((r) => r.ok && setIgHasKey(true))
      const res = await window.dhvw.saveSettings({
        llm: { protocol, baseUrl, model, temperature: Number(temperature), supportsVision },
        imageGen: {
          enabled: igEnabled,
          protocol: igProtocol,
          baseUrl: igBaseUrl.trim(),
          model: igModel.trim(),
          fusionStylePrompt: igFusionStyle.replace(/\r\n/g, '\n').trim(),
        },
        ports: { olvt: Number(olvtPort), tts: Number(ttsPort), llama: Number(llamaPort) },
        asr: { enabled: asr },
        live2d: { model: live2dModel },
        pixelCharacterId,
        scene: { autoPush: autoPushScene },
        proactive,
        boost: { gateways: { qq: boostQq, feishu: boostFeishu } },
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
        <label className="switch">
          <input
            type="checkbox"
            checked={supportsVision}
            onChange={(e) => setSupportsVision(e.target.checked)}
          />
          当前 LLM 模型支持识图（Multimodal Vision）
        </label>
        <p className="hint">
          勾选后，QQ Bot 接收到图片时会把图像发给 LLM 进行视觉理解、气氛判断及场景融图坐标规划；未勾选时仅按纯文本上下文处理，避免纯文本模型报错。
        </p>
      </section>

      <section className="panel settings-section">
        <div className="section-head">
          <h2>生图模型（API）</h2>
        </div>
        <label className="switch">
          <input type="checkbox" checked={igEnabled} onChange={(e) => setIgEnabled(e.target.checked)} />
          启用 API 生图模型（用于像素形象生成 &amp; ARM QQ 场景角色融图）
        </label>
        <div className="field">
          <label>生图 API 协议（4×4 像素图默认请求 1024×1024，其余场景图由模型自行判断尺寸）</label>
          <select value={igProtocol} onChange={(e) => setIgProtocol(e.target.value as ImageGenProtocol)}>
            <option value="openai-images">OpenAI Images (/images/generations &amp; edits)</option>
            <option value="openai-chat-image">OpenAI Chat 生图兼容 (/chat/completions)</option>
            <option value="gemini-native">Gemini 原生生图 (:generateContent)</option>
          </select>
        </div>
        <div className="field">
          <label>生图调用端点（留空则自动复用上方 LLM 端点）</label>
          <div className="row2 tight">
            <input
              value={igBaseUrl}
              onChange={(e) => setIgBaseUrl(e.target.value)}
              placeholder={baseUrl || 'https://api.openai.com'}
              spellCheck={false}
            />
            <button
              type="button"
              disabled={igLoadingModels || (!igBaseUrl.trim() && !baseUrl.trim())}
              onClick={() => void fetchImageModels()}
            >
              {igLoadingModels ? '拉取中…' : '拉取模型'}
            </button>
          </div>
        </div>
        <div className="field">
          <label>生图模型名称</label>
          {!igManualModel && igModels.length > 0 ? (
            <div className="row2 tight">
              <select value={igModel} onChange={(e) => setIgModel(e.target.value)}>
                {igModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setIgManualModel(true)}>
                手动输入
              </button>
            </div>
          ) : (
            <div className="row2 tight">
              <input
                value={igModel}
                onChange={(e) => setIgModel(e.target.value)}
                placeholder="如 gpt-image-1 / gemini-2.5-flash-image / flux-kontext"
                spellCheck={false}
              />
              {igModels.length > 0 && (
                <button type="button" onClick={() => setIgManualModel(false)}>
                  从列表选
                </button>
              )}
            </div>
          )}
        </div>
        <div className="field">
          <label>
            生图 API Key（留空自动复用 LLM 密钥）
            <span className={`pill ${igHasKey ? 'ok' : ''}`}>{igHasKey ? '已独立配置' : '复用 LLM 密钥'}</span>
          </label>
          <div className="row2 tight">
            <input
              type="password"
              placeholder={igHasKey ? '输入新密钥可覆盖' : '留空复用上方 API Key，或填写专用生图密钥'}
              value={igKey}
              onChange={(e) => setIgKey(e.target.value)}
              spellCheck={false}
            />
            <button type="button" disabled={!igKey.trim()} onClick={() => void saveIgKey()}>
              保存密钥
            </button>
            <button
              type="button"
              disabled={!igHasKey}
              onClick={() =>
                void window.dhvw.clearImageGenKey().then(() => {
                  setIgHasKey(false)
                  setMsg({ ok: true, text: '生图专用密钥已清除，将复用 LLM 密钥' })
                })
              }
            >
              清除
            </button>
          </div>
        </div>
        <div className="field">
          <div className="label-row">
            <label>场景融图画面风格提示词（纯提示词融合，完全交由生图模型重绘融入）</label>
            <button
              type="button"
              onClick={() => {
                setIgFusionStyle(DEFAULT_FUSION_STYLE_PROMPT)
                setMsg({ ok: true, text: '已恢复预设融图风格提示词，点击「保存」后生效' })
              }}
            >
              恢复预设风格
            </button>
          </div>
          <textarea
            rows={5}
            value={igFusionStyle}
            onChange={(e) => setIgFusionStyle(e.target.value)}
            placeholder="可自由编辑或留空；默认采用日系厚涂水彩 + 电影逆光体积光 + 清冷低饱和电影调色"
          />
          <p className="hint">
            QQ 收到生活/场景照并经 LLM 识图决定合影时，会将此风格与场景坐标、动作姿势、光影信息拼接后交由生图模型直接重绘融合。
          </p>
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
          <label>像素角色模型（总观地图 &amp; ARM 设备端共用）</label>
          <div className="row2 tight">
            <select value={pixelCharacterId} onChange={(e) => setPixelCharacterId(e.target.value)}>
              <option value="">内置默认（鲸鱼娘 · 32×48 22动作）</option>
              {pixelCharacterId && !pixelCharList.some((c) => c.id === pixelCharacterId) && (
                <option value={pixelCharacterId}>{pixelCharacterId}</option>
              )}
              {pixelCharList.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.frame.w}×{c.frame.h} · {c.animations.length}动作
                </option>
              ))}
            </select>
            <button type="button" onClick={() => void refreshPixelChars()}>
              刷新像素角色
            </button>
          </div>
          <div className="actions" style={{ marginTop: 6 }}>
            <button
              type="button"
              disabled={pixelApplyBusy}
              onClick={() =>
                void (async () => {
                  setPixelApplyBusy(true)
                  setMsg(null)
                  try {
                    const res = await window.dhvw.characterApply(pixelCharacterId || 'default', {
                      applyToScenes: true,
                      syncToolchain: true,
                    })
                    if (!res.ok) {
                      setMsg({ ok: false, text: res.error ?? '同步 ARM 角色失败' })
                      return
                    }
                    if (res.settings) onSaved(res.settings)
                    const delivered = res.delivered ?? 0
                    const scenes = res.updatedScenes?.length ?? 0
                    const label = pixelCharacterId ? '已切换像素角色' : '已重置为默认像素角色（鲸鱼娘）'
                    setMsg({
                      ok: true,
                      text:
                        delivered > 0
                          ? `${label}并实时推送到 ${delivered} 台已连接 ARM 设备${scenes ? `（同步 ${scenes} 张产出地图）` : ''}`
                          : `${label}${scenes ? `（已同步 ${scenes} 张产出地图）` : ''}；已写入 ARM 端资源目录，待 ARM 端打开或重连后自动生效`,
                    })
                  } finally {
                    setPixelApplyBusy(false)
                  }
                })()
              }
            >
              {pixelApplyBusy ? '推送中…' : '立即应用到 ARM 端'}
            </button>
          </div>
          <p className="hint">
            可选用「Agent → 像素形象」页生成的任意角色；保存设置或点「立即应用到 ARM 端」后，将自动同步到产出地图及已连接的 ARM 端实时刷新显示。
          </p>
        </div>
        <div className="field">
          <label>
            角色三维参考图（用于 QQ 场景拍照融合 &amp; 像素形象参考生成）
            <span className={`pill ${ref3dDataUrl || value.hasRef3d ? 'ok' : ''}`}>
              {ref3dDataUrl || value.hasRef3d ? '已配置' : '未配置'}
            </span>
          </label>
          <div className="ref3d-row">
            {ref3dDataUrl ? (
              <img src={ref3dDataUrl} alt="角色三维参考图" className="ref3d-thumb" />
            ) : (
              <div className="ref3d-thumb empty">未上传</div>
            )}
            <div className="actions">
              <button
                type="button"
                disabled={ref3dBusy}
                onClick={() =>
                  void (async () => {
                    setRef3dBusy(true)
                    setMsg(null)
                    try {
                      const res = await window.dhvw.characterRef3dPick()
                      if (res.canceled) return
                      if (!res.ok || !res.dataUrl) {
                        setMsg({ ok: false, text: res.error ?? '上传三维参考图失败' })
                        return
                      }
                      setRef3dDataUrl(res.dataUrl)
                      if (res.settings) onSaved(res.settings)
                      setMsg({ ok: true, text: '角色三维参考图已保存并同步给 ARM 端 QQ Bot' })
                    } finally {
                      setRef3dBusy(false)
                    }
                  })()
                }
              >
                {ref3dBusy ? '上传中…' : '上传角色三维参考图'}
              </button>
              <button
                type="button"
                disabled={ref3dBusy || !ref3dDataUrl}
                onClick={() =>
                  void (async () => {
                    setRef3dBusy(true)
                    setMsg(null)
                    try {
                      const res = await window.dhvw.characterRef3dClear()
                      setRef3dDataUrl(null)
                      if (res.settings) onSaved(res.settings)
                      setMsg({ ok: true, text: '已清除角色三维参考图' })
                    } finally {
                      setRef3dBusy(false)
                    }
                  })()
                }
              >
                清除
              </button>
            </div>
          </div>
          <p className="hint">
            建议上传角色 3D 三视图或正侧背立绘设定图。在 QQ 单聊中发送风景/生活照片且气氛合适时，LLM 会据此规划位置、动作与光影，自动把角色融入你的照片并回传 QQ。
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
            Boost 模式启用网关选择
            <span className={`pill ${value.boost?.enabled ? 'ok' : ''}`}>
              {value.boost?.enabled ? 'Boost 开启中' : 'Boost 未开启'}
            </span>
          </h2>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          自由勾选 Boost 模式联动开启的外部聊天网关（可单选或同时开启，实时同步至 ARM 设备）。
        </p>
        <div className="row2">
          <label className="switch">
            <input
              type="checkbox"
              checked={boostQq}
              disabled={busy}
              onChange={(e) => {
                const checked = e.target.checked
                setBoostQq(checked)
                void window.dhvw.setBoostGateways({ qq: checked, feishu: boostFeishu }).then((r) => {
                  if (r.settings) onSaved(r.settings)
                })
              }}
            />
            启用 QQ 官方 Bot 网关（有平台主动次数限制）
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={boostFeishu}
              disabled={busy}
              onChange={(e) => {
                const checked = e.target.checked
                setBoostFeishu(checked)
                void window.dhvw.setBoostGateways({ qq: boostQq, feishu: checked }).then((r) => {
                  if (r.settings) onSaved(r.settings)
                })
              }}
            />
            启用飞书官方长连接网关（推荐 · 无每日主动次数限制）
          </label>
        </div>
      </section>

      <section className="panel settings-section">
        <div className="section-head">
          <h2>
            飞书官方 Bot（Boost 长连接 · 无每日主动限制）
            <span className={`pill ${qqStatus?.feishu?.paired ? 'ok' : ''}`}>
              {qqStatus?.feishu?.paired
                ? `已绑定 · ${qqStatus.feishu.ownerOpenIdMasked || '主人'}`
                : qqStatus?.feishu?.connected
                  ? '长连接在线 · 待首条飞书消息激活'
                  : qqStatus?.feishu?.configured
                    ? '待连接激活'
                    : '未配置'}
            </span>
          </h2>
          <div className="actions" style={{ display: 'flex', gap: 8 }}>
            {onOpenFeishuGuide && (
              <button type="button" onClick={onOpenFeishuGuide}>
                打开注册与绑定向导
              </button>
            )}
            <button type="button" onClick={() => void window.dhvw.openExternal('https://open.feishu.cn/app')}>
              打开飞书开放平台
            </button>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          接入步骤：1. 在飞书创建「企业自建应用」并开启机器人能力，在「权限管理」开通：<code>im:message</code>、<code>im:message.p2p_msg:readonly</code>（读取单聊消息，必开！）、<code>im:message:send_as_bot</code>、<code>im:resource</code>；2. 先在下方保存凭据并开启 Boost（勾选飞书网关），待上方显示「长连接在线」后，去飞书「事件与回调 → 事件配置」选择「使用长连接接收事件」并添加 <code>im.message.receive_v1</code>；3. <b>务必在「版本管理与发布」创建并发布新版本</b>，否则新权限/事件不推送！然后私聊机器人发任意一句话即可自动认主。
        </p>
        {qqStatus?.feishu?.gatewayError && <p className="msg bad">飞书网关异常：{qqStatus.feishu.gatewayError}</p>}
        <div className="row2">
          <div className="field">
            <label>App ID</label>
            <input value={fsAppId} onChange={(e) => setFsAppId(e.target.value)} placeholder="如 cli_a6xxxxxxxx" />
          </div>
          <div className="field">
            <label>App Secret</label>
            <input
              type="password"
              value={fsSecret}
              onChange={(e) => setFsSecret(e.target.value)}
              placeholder={value.feishuBot?.hasSecret ? '已加密保存（留空保留）' : '填写飞书 App Secret'}
            />
          </div>
        </div>
        <div className="row2">
          <label className="switch">
            <input type="checkbox" checked={fsProactive} onChange={(e) => setFsProactive(e.target.checked)} />
            允许心情 / 世界事件主动发飞书消息（全天候无每日次数锁）
          </label>
          <div className="field" style={{ maxWidth: 160 }}>
            <label>表情包积极度 (0~3)</label>
            <input value={qqEagerness} onChange={(e) => setQqEagerness(e.target.value)} inputMode="numeric" />
          </div>
        </div>
        {fsMsg && <p className={`msg ${fsMsg.ok ? 'ok' : 'bad'}`}>{fsMsg.text}</p>}
        <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true)
                setFsMsg(null)
                try {
                  const res = await window.dhvw.feishuBotSave({
                    appId: fsAppId.trim(),
                    appSecret: fsSecret.trim() || undefined,
                    proactive: fsProactive,
                    stickerEagerness: Number(qqEagerness),
                    activateBoost: true,
                  })
                  if (!res.ok) {
                    setFsMsg({ ok: false, text: res.error || '保存失败' })
                    return
                  }
                  setBoostFeishu(true)
                  if (res.settings) onSaved(res.settings)
                  if (res.status) setQqStatus(res.status)
                  setFsSecret('')
                  setFsMsg({ ok: true, text: '飞书 Bot 配置已加密保存并自动启用飞书网关，请在飞书后台选长连接并发布版本' })
                } finally {
                  setBusy(false)
                }
              })()
            }
          >
            保存并启用飞书网关
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void (async () => {
                setBusy(true)
                setFsMsg(null)
                try {
                  const res = await window.dhvw.feishuBotRebind()
                  if (res.settings) onSaved(res.settings)
                  if (res.status) setQqStatus(res.status)
                  setFsMsg({
                    ok: true,
                    text: '已解除旧飞书账号绑定！请用目标飞书账号私聊机器人发任意消息完成重新绑定',
                  })
                } finally {
                  setBusy(false)
                }
              })()
            }
          >
            重新绑定飞书（解除旧绑定）
          </button>
        </div>
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
