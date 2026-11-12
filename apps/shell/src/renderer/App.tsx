import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSnapshot, ComponentStatus, HostEvent, LlmProtocol, SettingsView, WorkerSnapshot } from '../shared/types'

declare global {
  interface Window {
    dhvw: {
      snapshot: () => Promise<AppSnapshot>
      action: (req: { id: string; action: 'start' | 'stop' | 'restart' }) => Promise<{ ok: boolean }>
      tailLog: (id: string, lines?: number) => Promise<string>
      setAutoLaunch: (enabled: boolean) => Promise<{ ok: boolean }>
      openDataDir: () => Promise<string>
      restartHost: () => Promise<{ ok: boolean }>
      probeLlm: () => Promise<{ ok: boolean; ms: number; status?: number; note?: string }>
      onSnapshot: (cb: (s: AppSnapshot) => void) => () => void
      onEvent: (cb: (e: HostEvent) => void) => () => void
    }
  }
}

const stateLabel: Record<WorkerSnapshot['state'], string> = {
  running: '运行中',
  starting: '启动中',
  stopped: '已停止',
  failed: '失败',
}

function SettingsDialog({
  value,
  onClose,
  onSaved,
}: {
  value: SettingsView
  onClose: () => void
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
  const [charName, setCharName] = useState(value.olvt.characterName)
  const [humanName, setHumanName] = useState(value.olvt.humanName)
  const [persona, setPersona] = useState(value.olvt.personaPrompt)
  const [refAudio, setRefAudio] = useState(value.tts.refAudioPath)
  const [refText, setRefText] = useState(value.tts.refText)
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(value.llm.hasKey)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

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
        olvt: { characterName: charName, humanName, personaPrompt: persona },
        tts: { refAudioPath: refAudio, refText },
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
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

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
          <label>人设</label>
          <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={4} spellCheck={false} />
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
          启用语音识别（ASR）{!value.asr.ready && asr ? '（模型未下载，需在组件面板安装）' : ''}
        </label>
        {msg && <p className={`msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
        <div className="actions dialog-actions">
          <button className="primary" disabled={busy} onClick={() => void save()}>
            保存
          </button>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

function EventLine({ e }: { e: HostEvent }): React.ReactElement {
  return (
    <div className={`ev ${e.type}`}>
      <span className="ts">{new Date(e.ts).toLocaleTimeString('zh-CN', { hour12: false })}</span>
      <span className="type">{e.type}</span>
      {e.service && <span className="svc">{e.service}</span>}
      {typeof e.pid === 'number' && <span className="kv">pid={e.pid}</span>}
      {typeof e.code === 'number' && <span className="kv">code={e.code}</span>}
      {e.message && <span className="msg">{e.message}</span>}
    </div>
  )
}

export default function App(): React.ReactElement {
  const [snap, setSnap] = useState<AppSnapshot | null>(null)
  const [events, setEvents] = useState<HostEvent[]>([])
  const [selected, setSelected] = useState<string>('host')
  const [logText, setLogText] = useState('')
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState<{ ok: boolean; ms: number; note?: string } | null>(null)
  const [probing, setProbing] = useState(false)
  const [components, setComponents] = useState<ComponentStatus[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [settings, setSettings] = useState<SettingsView | null>(null)

  const refresh = useCallback(async () => setSnap(await window.dhvw.snapshot()), [])
  const refreshLog = useCallback(async () => setLogText(await window.dhvw.tailLog(selected, 120)), [selected])

  useEffect(() => {
    void refresh()
    void window.dhvw.probeLlm().then(setProbe)
    void window.dhvw.components().then(setComponents)
    void window.dhvw.settings().then(setSettings)
    const offComp = window.dhvw.onComponentProgress(({ id, progress }) =>
      setComponents((prev) => prev.map((c) => (c.id === id ? { ...c, progress } : c))),
    )
    const offSnap = window.dhvw.onSnapshot((s) => setSnap(s))
    // 心跳每 5 s 一条，留在日志里即可，事件流只保留状态变化
    const offEvt = window.dhvw.onEvent((e) => {
      if (e.type === 'host.heartbeat') return
      setEvents((prev) => [e, ...prev].slice(0, 300))
    })
    const timer = setInterval(() => void refreshLog(), 2000)
    return () => {
      offSnap()
      offEvt()
      offComp()
      clearInterval(timer)
    }
  }, [refresh, refreshLog])

  useEffect(() => {
    void refreshLog()
  }, [refreshLog])

  const act = async (id: string, action: 'start' | 'stop' | 'restart'): Promise<void> => {
    setBusy(true)
    try {
      await window.dhvw.action({ id, action })
      setTimeout(() => void refresh(), 150)
    } finally {
      setBusy(false)
    }
  }

  const workers = snap?.workers ?? []
  const running = useMemo(() => workers.filter((w) => w.state === 'running').length, [workers])

  return (
    <div className="app">
      <header>
        <div className="brand">
          <h1>DHVW 主机端</h1>
          <span className={`pill ${snap?.hostReady ? 'ok' : 'bad'}`}>
            宿主 {snap?.hostReady ? '就绪' : '未就绪'}
            {snap?.hostPid ? ` · pid ${snap.hostPid}` : ''}
          </span>
          <span className="pill">{running}/{workers.length} 服务运行</span>
          {snap && <span className="pill mono">{snap.llm.model}</span>}
          {probe && (
            <span className={`pill ${probe.ok ? 'ok' : 'bad'}`} title={probe.note}>
              端点 {probe.ok ? '可达' : '不可达'} · {probe.ms} ms
            </span>
          )}
        </div>
        <div className="actions">
          <label className="switch">
            <input
              type="checkbox"
              checked={snap?.autoLaunch ?? false}
              onChange={(e) => void window.dhvw.setAutoLaunch(e.target.checked).then(refresh)}
            />
            开机自启
          </label>
          <button
            disabled={probing}
            onClick={() => {
              setProbing(true)
              void window.dhvw
                .probeLlm()
                .then(setProbe)
                .finally(() => setProbing(false))
            }}
          >
            检测端点
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void window.dhvw.restartHost().then(() => setTimeout(() => void refresh(), 800))}
          >
            重启宿主
          </button>
          <button onClick={() => { setShowSettings(true); void window.dhvw.settings().then(setSettings) }}>设置</button>
          <button onClick={() => void window.dhvw.openDataDir()}>打开数据目录</button>
        </div>
      </header>

      {showSettings && settings && (
        <SettingsDialog
          value={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(next) => {
            setSettings(next)
            setSnap((prev) => (prev ? { ...prev, llm: { baseUrl: next.llm.baseUrl, model: next.llm.model } } : prev))
          }}
        />
      )}

      <main>
        <section className="panel services">
          <h2>服务</h2>
          <div className="table-wrap">
            <table>
            <thead>
              <tr>
                <th>服务</th>
                <th>状态</th>
                <th>端口</th>
                <th className="col-optional">PID</th>
                <th className="col-optional">重启</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => (
                <tr key={w.id} className={w.state}>
                  <td className="name">{w.name}</td>
                  <td>
                    <span className={`dot ${w.state === 'running' && w.healthy === false ? 'failed' : w.state}`} />
                    {w.state === 'running' && w.healthy === false ? '无响应' : stateLabel[w.state]}
                  </td>
                  <td className="mono">{w.port || '—'}</td>
                  <td className="mono col-optional">{w.pid ?? '—'}</td>
                  <td className="mono col-optional">{w.restarts}</td>
                  <td className="row-actions">
                    <button disabled={busy} onClick={() => void act(w.id, 'restart')}>重启</button>
                    {w.state === 'running' ? (
                      <button disabled={busy} onClick={() => void act(w.id, 'stop')}>停止</button>
                    ) : (
                      <button disabled={busy} onClick={() => void act(w.id, 'start')}>启动</button>
                    )}
                    <button onClick={() => setSelected(w.id)}>日志</button>
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </div>
          <p className="hint">数据目录：{snap?.dataDir ?? '…'} · Python：{snap?.pythonPath ?? '…'}</p>
        </section>

        <div className="col">
        <section className="panel events">
          <h2>事件</h2>
          <div className="scroll">
            {events.length === 0 && <div className="empty">等待宿主事件…</div>}
            {events.map((e, i) => (
              <EventLine key={`${e.ts}-${i}`} e={e} />
            ))}
          </div>
        </section>

        <section className="panel components">
          <h2>组件</h2>
          {components.length === 0 && <div className="empty">读取中…</div>}
          {components.map((c) => (
            <div className="comp" key={c.id}>
              <div className="comp-info">
                <span className="comp-name">{c.name}</span>
                <span className={`pill ${c.state === 'ready' ? 'ok' : c.state === 'failed' ? 'bad' : ''}`}>
                  {c.state === 'ready' ? '就绪' : c.state === 'failed' ? '失败' : c.state === 'installing' ? '下载中' : '未安装'}
                </span>
                <span className="comp-ver mono">v{c.version}</span>
              </div>
              {c.state === 'installing' && (
                <div className="bar">
                  <div style={{ width: `${c.progress ?? 0}%` }} />
                </div>
              )}
              {c.error && <div className="comp-err">{c.error}</div>}
              {c.state !== 'ready' && c.state !== 'installing' && (
                <button
                  disabled={c.state === 'installing'}
                  onClick={() =>
                    void window.dhvw.installComponent(c.id).then((st) =>
                      setComponents((prev) => prev.map((x) => (x.id === st.id ? st : x))),
                    )
                  }
                >
                  下载并安装
                </button>
              )}
            </div>
          ))}
        </section>
        </div>
      </main>

      <footer className="panel logs">
        <div className="logs-head">
          <h2>日志 · {selected}</h2>
          <div className="tabs">
            {['host', ...workers.map((w) => w.id)].map((id) => (
              <button key={id} className={id === selected ? 'active' : ''} onClick={() => setSelected(id)}>
                {id}
              </button>
            ))}
          </div>
        </div>
        <pre>{logText || '…'}</pre>
      </footer>
    </div>
  )
}
