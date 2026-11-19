import React, { useCallback, useEffect, useState } from 'react'
import type {
  CharacterCardData,
  MemoryFactView,
  PersonaJobView,
  SettingsView,
} from '../../shared/types'

function emptyCard(settings: SettingsView | null): CharacterCardData {
  if (settings?.olvt?.personaCard) return { ...settings.olvt.personaCard }
  return {
    name: settings?.olvt.characterName || '小仓',
    description: settings?.olvt.personaPrompt || '',
    personality: '',
    scenario: '住在数字人虚拟仓与现实桌面之间，随时陪伴用户聊天、汇报仓库日常并响应唤醒。',
    first_mes: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    creator_notes: '',
    tags: ['虚拟仓', '语音陪伴'],
    creator: 'DHVW',
    character_version: '1.0',
    spec: 'chara_card_v2',
  }
}

function compileLocalPrompt(card: CharacterCardData, humanName: string): string {
  const charName = card.name.trim() || '小仓'
  const userLabel = humanName.trim() || '主人'
  const sub = (s: string) =>
    s
      .replace(/\{\{char\}\}|<BOT>/gi, charName)
      .replace(/\{\{user\}\}|<USER>/gi, userLabel)
      .trim()
  const blocks: string[] = []
  blocks.push(
    card.system_prompt
      ? sub(card.system_prompt)
      : `你是${charName}，正在与${userLabel}进行自然实时语音陪伴对话。请始终保持角色人设，语气口语化、自然亲切，每次回复简短明确（通常1到3句话）。不要使用 Markdown 格式，不要输出括号里的动作或心理描写。`,
  )
  if (card.description) blocks.push(`【角色设定】\n${sub(card.description)}`)
  if (card.personality) blocks.push(`【性格与说话风格】\n${sub(card.personality)}`)
  if (card.scenario) blocks.push(`【所处情景与日常】\n${sub(card.scenario)}`)
  if (card.mes_example) blocks.push(`【口吻示例】\n${sub(card.mes_example)}`)
  if (card.post_history_instructions) blocks.push(`【表达约束】\n${sub(card.post_history_instructions)}`)
  return blocks.join('\n\n')
}

const JOB_STATE_LABEL: Record<PersonaJobView['status'], string> = {
  queued: '排队中',
  running: '检索撰写中',
  done: '已完成',
  error: '失败',
}

/** Agent 角色人设与 L0 记忆工坊：支持酒馆 PNG/JSON 角色卡与联网 Agent 生成。 */
export function PersonaStudio({
  settings,
  onSettingsChange,
}: {
  settings: SettingsView | null
  onSettingsChange?: (next: SettingsView) => void
}): React.ReactElement {
  const [card, setCard] = useState<CharacterCardData>(() => emptyCard(settings))
  const [humanName, setHumanName] = useState(settings?.olvt.humanName || '主人')
  const [compiledPrompt, setCompiledPrompt] = useState(settings?.olvt.personaPrompt || '')
  const [tagsText, setTagsText] = useState(() => (emptyCard(settings).tags || []).join(', '))

  // Agent 联网撰写表单
  const [query, setQuery] = useState('')
  const [extraPrompt, setExtraPrompt] = useState('')
  const [autoApply, setAutoApply] = useState(true)
  const [jobs, setJobs] = useState<PersonaJobView[]>([])
  const [generating, setGenerating] = useState(false)

  // L0 核心记忆管理
  const [l0Facts, setL0Facts] = useState<MemoryFactView[]>([])
  const [newFactText, setNewFactText] = useState('')
  const [pendingL0, setPendingL0] = useState<Array<{ id?: string; text: string; importance?: number }>>([])
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [appliedJobIds, setAppliedJobIds] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (!settings) return
    setHumanName(settings.olvt.humanName || '主人')
    if (settings.olvt.personaPrompt) setCompiledPrompt(settings.olvt.personaPrompt)
    if (settings.olvt.personaCard) {
      setCard({ ...settings.olvt.personaCard })
      setTagsText((settings.olvt.personaCard.tags || []).join(', '))
    }
  }, [settings?.olvt.characterName, settings?.olvt.humanName, settings?.olvt.personaPrompt, settings?.olvt.personaCard])

  const refreshData = useCallback(async () => {
    const [jobsRes, factsRes] = await Promise.all([
      window.dhvw.personaJobs(),
      window.dhvw.memoryFacts('L0', 100),
    ])
    if (jobsRes.ok) setJobs(jobsRes.jobs)
    if (factsRes.ok) setL0Facts(factsRes.facts)
  }, [])

  useEffect(() => {
    void refreshData()
  }, [refreshData])

  const hasActiveJob = jobs.some((j) => j.status === 'queued' || j.status === 'running')

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshData()
    }, hasActiveJob ? 1800 : 8000)
    return () => window.clearInterval(timer)
  }, [hasActiveJob, refreshData])

  // 当 autoApply 打开且刚完成的任务尚未应用到配置，自动落地并重启 OLVT
  useEffect(() => {
    const readyAuto = jobs.find((j) => j.status === 'done' && j.autoApply && j.result && !appliedJobIds[j.id])
    if (!readyAuto?.result) return
    setAppliedJobIds((prev) => ({ ...prev, [readyAuto.id]: true }))
    const res = readyAuto.result
    const nextCard: CharacterCardData = { ...res.card, avatarDataUrl: card.avatarDataUrl }
    setCard(nextCard)
    setTagsText((nextCard.tags || []).join(', '))
    setCompiledPrompt(res.compiledPrompt)
    void window.dhvw
      .personaApply({
        card: nextCard,
        characterName: nextCard.name,
        humanName: readyAuto.humanName || humanName,
        personaPrompt: res.compiledPrompt,
        l0Facts: res.l0Memories,
      })
      .then((applyRes) => {
        if (applyRes.ok && applyRes.settings) onSettingsChange?.(applyRes.settings)
        setStatusMsg({ ok: true, text: `Agent 任务已完成并自动应用角色「${nextCard.name}」与 ${res.l0Memories.length} 条 L0 记忆` })
        void refreshData()
      })
  }, [jobs, appliedJobIds, card.avatarDataUrl, humanName, onSettingsChange, refreshData])

  const updateField = <K extends keyof CharacterCardData>(key: K, value: CharacterCardData[K]): void => {
    setCard((prev) => ({ ...prev, [key]: value }))
  }

  const parsedCard = (): CharacterCardData => ({
    ...card,
    tags: tagsText
      .split(/[,，\n]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  })

  const importCard = async (): Promise<void> => {
    setStatusMsg(null)
    const res = await window.dhvw.personaImportCard()
    if (!res.ok || !res.card) {
      if (res.error && res.error !== '已取消选择') setStatusMsg({ ok: false, text: res.error })
      return
    }
    setCard(res.card)
    setTagsText((res.card.tags || []).join(', '))
    setCompiledPrompt(res.compiledPrompt || compileLocalPrompt(res.card, humanName))
    setPendingL0(res.suggestedL0 || [])
    setStatusMsg({
      ok: true,
      text: `已导入酒馆角色卡「${res.card.name}」（${res.specDetected || 'v2'}），请检查后点击「应用人设并写入记忆」`,
    })
  }

  const uploadAvatar = async (): Promise<void> => {
    const res = await window.dhvw.personaAvatar()
    if (!res.ok) {
      if (res.error) setStatusMsg({ ok: false, text: res.error })
      return
    }
    if (res.avatarDataUrl) {
      updateField('avatarDataUrl', res.avatarDataUrl)
      setStatusMsg({ ok: true, text: '已加载 PNG 立绘底图，导出酒馆 PNG 时会嵌入角色数据块' })
    }
  }

  const exportCard = async (format: 'png' | 'json'): Promise<void> => {
    const res = await window.dhvw.personaExportCard({ card: parsedCard(), format })
    if (res.canceled) return
    setStatusMsg(
      res.ok
        ? { ok: true, text: `已导出至 ${res.path}` }
        : { ok: false, text: res.error || '导出失败' },
    )
  }

  const applyPersona = async (): Promise<void> => {
    setBusy(true)
    setStatusMsg(null)
    try {
      const current = parsedCard()
      const finalPrompt = compiledPrompt.trim() || compileLocalPrompt(current, humanName)
      setCompiledPrompt(finalPrompt)
      const res = await window.dhvw.personaApply({
        card: current,
        characterName: current.name,
        humanName,
        personaPrompt: finalPrompt,
        l0Facts: pendingL0,
      })
      if (!res.ok) {
        setStatusMsg({ ok: false, text: res.error || '应用人设失败' })
        return
      }
      if (res.settings) onSettingsChange?.(res.settings)
      const addedCount = pendingL0.length
      setPendingL0([])
      setStatusMsg({
        ok: true,
        text: `已保存「${current.name}」人设并重载 OLVT${addedCount ? `，同时写入 ${addedCount} 条 L0 核心记忆` : ''}`,
      })
      void refreshData()
    } finally {
      setBusy(false)
    }
  }

  const submitGenerate = async (): Promise<void> => {
    const q = query.trim()
    if (!q) {
      setStatusMsg({ ok: false, text: '请输入要搜索并撰写的角色名称或设定关键词' })
      return
    }
    setGenerating(true)
    setStatusMsg(null)
    try {
      const res = await window.dhvw.personaGenerate({
        query: q,
        humanName: humanName.trim() || '主人',
        extraPrompt: extraPrompt.trim(),
        autoApply,
      })
      if (!res.ok) {
        setStatusMsg({ ok: false, text: res.error || '提交人设 Agent 任务失败' })
        return
      }
      setStatusMsg({ ok: true, text: `已提交「${q}」联网创作任务，Agent 正在检索公开资料并撰写 L0 记忆…` })
      void refreshData()
    } finally {
      setGenerating(false)
    }
  }

  const loadJobResult = async (job: PersonaJobView, alsoWriteFacts: boolean): Promise<void> => {
    if (!job.result) return
    const nextCard: CharacterCardData = { ...job.result.card, avatarDataUrl: card.avatarDataUrl }
    setCard(nextCard)
    setTagsText((nextCard.tags || []).join(', '))
    setCompiledPrompt(job.result.compiledPrompt)
    if (alsoWriteFacts) {
      const applyRes = await window.dhvw.personaApply({
        card: nextCard,
        characterName: nextCard.name,
        humanName: job.humanName || humanName,
        personaPrompt: job.result.compiledPrompt,
        l0Facts: job.result.l0Memories,
      })
      if (applyRes.ok && applyRes.settings) onSettingsChange?.(applyRes.settings)
      setStatusMsg({
        ok: true,
        text: `已采用「${nextCard.name}」人设并写入 ${job.result.l0Memories.length} 条 L0 记忆`,
      })
      void refreshData()
    } else {
      setPendingL0(job.result.l0Memories)
      setStatusMsg({ ok: true, text: `已载入「${nextCard.name}」到编辑器，可继续修改后点击应用` })
    }
  }

  const addSingleL0 = async (): Promise<void> => {
    const text = newFactText.trim()
    if (!text) return
    const res = await window.dhvw.memoryAddFacts([{ text, tier: 'L0', importance: 0.96 }])
    if (!res.ok) {
      setStatusMsg({ ok: false, text: res.error || '写入 L0 记忆失败' })
      return
    }
    setNewFactText('')
    setStatusMsg({ ok: true, text: '已写入 L0 核心记忆并同步给在线设备' })
    void refreshData()
  }

  const removeL0 = async (id: string): Promise<void> => {
    const res = await window.dhvw.memoryDeleteFact(id)
    if (!res.ok) {
      setStatusMsg({ ok: false, text: res.error || '删除 L0 记忆失败' })
      return
    }
    void refreshData()
  }

  const stopJob = async (jobId: string): Promise<void> => {
    const res = await window.dhvw.personaStopJob(jobId)
    setStatusMsg(res.ok ? { ok: true, text: '已暂停该人设任务，可随时点击「重试」或「删除」' } : { ok: false, text: res.error || '暂停失败' })
    void refreshData()
  }

  const retryJob = async (jobId: string): Promise<void> => {
    setAppliedJobIds((prev) => {
      const next = { ...prev }
      delete next[jobId]
      return next
    })
    const res = await window.dhvw.personaRetryJob(jobId)
    setStatusMsg(res.ok ? { ok: true, text: '已重启人设任务，正在重新执行…' } : { ok: false, text: res.error || '重启失败' })
    void refreshData()
  }

  const deleteJob = async (jobId: string): Promise<void> => {
    const res = await window.dhvw.personaDeleteJob(jobId)
    if (!res.ok) setStatusMsg({ ok: false, text: res.error || '删除任务失败' })
    void refreshData()
  }

  return (
    <div className="persona-grid">
      <div className="persona-left">
        <section className="panel">
          <h2>Agent 联网撰写人设与 L0 记忆</h2>
          <p className="hint">
            Agent 会检索百科与公开网页，输出兼容酒馆（SillyTavern V2）的完整角色卡、适配 TTS 的语音对话 Prompt，以及 6–10 条核心 L0 锚点记忆。
          </p>
          <div className="row2">
            <div className="field">
              <label>角色名称 / 联网检索词</label>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                spellCheck={false}
                placeholder="如 初音未来 / 芙宁娜 / 虚拟仓库守夜少女小仓"
              />
            </div>
            <div className="field">
              <label>称呼用户（{`{{user}}`}）</label>
              <input
                value={humanName}
                onChange={(e) => setHumanName(e.target.value)}
                spellCheck={false}
                placeholder="如 主人 / 管理员"
              />
            </div>
          </div>
          <div className="field">
            <label>创作补充要求（可选）</label>
            <textarea
              value={extraPrompt}
              onChange={(e) => setExtraPrompt(e.target.value)}
              rows={2}
              spellCheck={false}
              placeholder="如：融合数字人虚拟仓设定；语气元气带点吐槽；重点记住我的作息和忌口"
            />
          </div>
          <label className="checkline">
            <input type="checkbox" checked={autoApply} onChange={(e) => setAutoApply(e.target.checked)} />
            完成后自动应用人设并写入生成的 L0 记忆
          </label>
          <div className="actions">
            <button className="primary" disabled={generating || hasActiveJob} onClick={() => void submitGenerate()}>
              {generating ? '提交中…' : hasActiveJob ? 'Agent 撰写中…' : '联网搜索并由 Agent 撰写'}
            </button>
            <button onClick={() => void refreshData()}>刷新</button>
          </div>
        </section>

        <section className="panel">
          <h2>酒馆角色卡（SillyTavern PNG / JSON）与人设详情</h2>
          <div className="persona-card-bar">
            {card.avatarDataUrl ? (
              <img className="persona-avatar" src={card.avatarDataUrl} alt={card.name || '角色头像'} />
            ) : (
              <div className="persona-avatar empty-avatar">PNG</div>
            )}
            <div className="actions">
              <button onClick={() => void importCard()}>导入酒馆卡 (PNG/JSON)</button>
              <button onClick={() => void uploadAvatar()}>选 PNG 立绘底图</button>
              <button onClick={() => void exportCard('png')}>导出酒馆 PNG</button>
              <button onClick={() => void exportCard('json')}>导出 JSON</button>
            </div>
          </div>

          <div className="row2">
            <div className="field">
              <label>角色名（{`{{char}}`}）</label>
              <input value={card.name} onChange={(e) => updateField('name', e.target.value)} spellCheck={false} />
            </div>
            <div className="field">
              <label>角色标签（逗号分隔）</label>
              <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} spellCheck={false} />
            </div>
          </div>

          <div className="field">
            <label>角色设定（Description / 世界观与身份）</label>
            <textarea
              value={card.description}
              onChange={(e) => updateField('description', e.target.value)}
              rows={4}
              spellCheck={false}
            />
          </div>
          <div className="field">
            <label>性格与口吻（Personality）</label>
            <textarea
              value={card.personality}
              onChange={(e) => updateField('personality', e.target.value)}
              rows={3}
              spellCheck={false}
            />
          </div>
          <div className="row2">
            <div className="field">
              <label>所处情景（Scenario）</label>
              <textarea
                value={card.scenario}
                onChange={(e) => updateField('scenario', e.target.value)}
                rows={3}
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label>开场白（First Mes）</label>
              <textarea
                value={card.first_mes}
                onChange={(e) => updateField('first_mes', e.target.value)}
                rows={3}
                spellCheck={false}
              />
            </div>
          </div>
          <div className="field">
            <label>口吻对话示例（Mes Example）</label>
            <textarea
              value={card.mes_example}
              onChange={(e) => updateField('mes_example', e.target.value)}
              rows={3}
              spellCheck={false}
            />
          </div>
          <div className="row2">
            <div className="field">
              <label>System Prompt 覆盖（可选）</label>
              <textarea
                value={card.system_prompt}
                onChange={(e) => updateField('system_prompt', e.target.value)}
                rows={2}
                spellCheck={false}
              />
            </div>
            <div className="field">
              <label>表达约束（Post History）</label>
              <textarea
                value={card.post_history_instructions}
                onChange={(e) => updateField('post_history_instructions', e.target.value)}
                rows={2}
                spellCheck={false}
              />
            </div>
          </div>

          <div className="field">
            <div className="label-row">
              <label>发给 OLVT 的最终语音人设 Prompt</label>
              <button
                type="button"
                className="tiny"
                onClick={() => setCompiledPrompt(compileLocalPrompt(parsedCard(), humanName))}
              >
                根据卡片重新编译
              </button>
            </div>
            <textarea
              value={compiledPrompt}
              onChange={(e) => setCompiledPrompt(e.target.value)}
              rows={5}
              spellCheck={false}
            />
          </div>

          {pendingL0.length > 0 && (
            <div className="pending-l0">
              <strong>待写入的 {pendingL0.length} 条建议 L0 记忆（点下方应用一并写入）：</strong>
              <ul>
                {pendingL0.map((item, idx) => (
                  <li key={`${idx}-${item.text.slice(0, 12)}`}>{item.text}</li>
                ))}
              </ul>
            </div>
          )}

          {statusMsg && <p className={`msg ${statusMsg.ok ? 'ok' : 'bad'}`}>{statusMsg.text}</p>}

          <div className="actions">
            <button className="primary" disabled={busy} onClick={() => void applyPersona()}>
              {busy ? '应用中…' : '应用人设与 L0 记忆并重载 OLVT'}
            </button>
          </div>
        </section>
      </div>

      <div className="persona-right">
        <section className="panel">
          <h2>
            L0 核心常驻记忆 <span className="pill">{l0Facts.length}</span>
          </h2>
          <p className="hint">
            L0 层记忆会在每轮对话常驻注入提示词（当前上限 10 条）并同步给 ARM 硬件，适合放核心人设身份、称呼、性格禁忌与主人核心档案。
          </p>
          <div className="row2 tight">
            <input
              value={newFactText}
              onChange={(e) => setNewFactText(e.target.value)}
              spellCheck={false}
              placeholder="新增一条 L0 核心记忆（如：主人的昵称是阿哲，深夜喜欢听安静的话题）"
            />
            <button className="primary" onClick={() => void addSingleL0()}>
              写入 L0
            </button>
          </div>
          <div className="l0-list">
            {l0Facts.length === 0 ? (
              <div className="empty">当前暂无 L0 核心记忆，可用左侧 Agent 联网撰写或手动添加。</div>
            ) : (
              l0Facts.map((f) => (
                <div key={f.id} className="l0-item">
                  <div className="l0-text">{f.text}</div>
                  <div className="l0-meta">
                    <span className="pill">{f.src || 'pc'}</span>
                    <button className="tiny danger" onClick={() => void removeL0(f.id)}>
                      删除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <section className="panel">
          <h2>
            人设 Agent 任务记录 <span className="pill">{jobs.length}</span>
          </h2>
          {jobs.length === 0 ? (
            <div className="empty">还没有人设生成任务。</div>
          ) : (
            jobs.map((job) => (
              <div
                key={job.id}
                className={`job ${job.status === 'done' ? 'done' : job.status === 'error' ? 'failed' : ''}`}
              >
                <div className="job-head">
                  <span className="job-name">{job.query}</span>
                  <span className="pill">{job.stage === '已暂停' ? '已暂停' : JOB_STATE_LABEL[job.status]}</span>
                  <span className="job-meta">{job.stage}</span>
                </div>
                {job.error && <div className="msg bad">{job.error}</div>}
                {job.result && (
                  <div className="persona-job-result">
                    {job.result.summary && <p className="hint">{job.result.summary}</p>}
                    <div className="job-meta">
                      已生成角色「{job.result.card.name}」与 {job.result.l0Memories.length} 条 L0 记忆
                    </div>
                    {job.result.sources.length > 0 && (
                      <div className="source-links">
                        {job.result.sources.map((s, idx) => (
                          <button
                            key={`${idx}-${s.url}`}
                            type="button"
                            className="tiny"
                            onClick={() => void window.dhvw.openExternal(s.url)}
                          >
                            来源：{s.title}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="actions">
                      <button className="primary tiny" onClick={() => void loadJobResult(job, true)}>
                        应用该人设并写入 {job.result.l0Memories.length} 条 L0
                      </button>
                      <button className="tiny" onClick={() => void loadJobResult(job, false)}>
                        载入左侧编辑器
                      </button>
                    </div>
                  </div>
                )}
                {job.logTail.length > 0 && job.status !== 'done' && (
                  <pre className="job-log">{job.logTail.slice(-10).join('\n')}</pre>
                )}
                <div className="actions">
                  {(job.status === 'queued' || job.status === 'running') && (
                    <button type="button" className="tiny" onClick={() => void stopJob(job.id)}>
                      暂停
                    </button>
                  )}
                  <button type="button" className="tiny" onClick={() => void retryJob(job.id)}>
                    {job.status === 'running' || job.status === 'queued' ? '重启' : '重试'}
                  </button>
                  <button type="button" className="tiny danger" onClick={() => void deleteJob(job.id)}>
                    删除
                  </button>
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    </div>
  )
}
