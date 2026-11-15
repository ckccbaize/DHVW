import React, { useEffect, useState } from 'react'
import type { Live2dModelView, LlmProtocol, SettingsView } from '../../shared/types'
import { SaveBackupPanel } from './SaveBackupPanel'

/** 独立设置页：按模型 / 角色语音 / 运行 / 存档分类。 */
export function SettingsPage({
  value,
  onSaved,
}: {
  value: SettingsView
  onSaved: (next: SettingsView) => void
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
  const [live2dList, setLive2dList] = useState<Live2dModelView[]>([])
  const [charName, setCharName] = useState(value.olvt.characterName)
  const [humanName, setHumanName] = useState(value.olvt.humanName)
  const [persona, setPersona] = useState(value.olvt.personaPrompt)
  const [ttsDir, setTtsDir] = useState(value.tts.backendDir)
  const [refAudio, setRefAudio] = useState(value.tts.refAudioPath)
  const [refText, setRefText] = useState(value.tts.refText)
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(value.llm.hasKey)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const refreshLive2d = async (): Promise<void> => {
    const res = await window.dhvw.live2dModels()
    setLive2dList(res.models)
    if (res.models.length > 0 && !res.models.some((m) => m.id === live2dModel)) {
      setLive2dModel(res.current ?? res.models[0]?.id ?? live2dModel)
    }
  }

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
        </div>
        <div className="field">
          <label>人设</label>
          <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={4} spellCheck={false} />
        </div>
        <div className="field">
          <label>语音合成后端目录（GPT-SoVITS，留空则用内置占位）</label>
          <input value={ttsDir} onChange={(e) => setTtsDir(e.target.value)} spellCheck={false} placeholder="如 D:\tts\GPT-SoVITS" />
        </div>
        <div className="field">
          <label>参考音色（GPT-SoVITS，留空则用服务默认）</label>
          <input value={refAudio} onChange={(e) => setRefAudio(e.target.value)} spellCheck={false} />
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
