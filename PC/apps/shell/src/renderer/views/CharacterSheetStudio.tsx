import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CharacterSampleView,
  CharacterSheetMetaJson,
  CharacterSheetView,
  Generated4x4ItemView,
  SettingsView,
} from '../../shared/types'

const ROW_ORDER_OPTIONS = [
  { value: 'auto', label: '自动识别行序（推荐 · 智能分辨正/背/左/右）' },
  { value: 'S,W,E,N', label: 'S / W / E / N（正 / 左 / 右 / 背）' },
  { value: 'N,S,E,W', label: 'N / S / E / W（背 / 正 / 右 / 左）' },
  { value: 'S,N,E,W', label: 'S / N / E / W（正 / 背 / 右 / 左）' },
  { value: 'S,E,W,N', label: 'S / E / W / N（正 / 右 / 左 / 背）' },
]

const FRAME_SIZE_OPTIONS = [
  { value: '32x48', fw: 32, fh: 48, label: '32×48（推荐 · 高清像素细节）' },
  { value: '16x24', fw: 16, fh: 24, label: '16×24（标准紧凑网格）' },
  { value: '32x32', fw: 32, fh: 32, label: '32×32（方格比例）' },
]

const DIR_LABELS: Array<{ key: string; label: string }> = [
  { key: 'S', label: 'S 正面' },
  { key: 'N', label: 'N 背面' },
  { key: 'W', label: 'W 左侧' },
  { key: 'E', label: 'E 右侧' },
]

const ACTION_LABELS: Record<string, string> = {
  idle: '待机',
  walk: '行走',
  sit: '坐下',
  sleep: '睡觉',
  read: '看书',
  play_cat: '撸猫',
  water_plants: '浇花',
  cook: '做饭',
  eat: '吃饭',
  drink: '喝水',
  bathe: '洗澡',
  wash_up: '洗手',
  work: '办公',
  watch_tv: '看电视',
  rest: '休息',
  tidy: '整理',
  print: '打印',
  laundry: '洗衣',
  dress: '换衣',
  hang_coat: '挂衣',
  meet: '迎客',
  use_toilet: '如厕',
}

function WalkFrameTile({
  img,
  meta,
  dir,
  frameIdx,
  flipped,
  disabled,
  onClick,
}: {
  img: HTMLImageElement
  meta: CharacterSheetMetaJson
  dir: string
  frameIdx: number
  flipped: boolean
  disabled: boolean
  onClick: () => void
}): React.ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    const walkAnim = meta.animations.walk || meta.animations.idle
    const idx = walkAnim?.frames?.[dir]?.[frameIdx] ?? 0
    const fw = meta.frame.w
    const fh = meta.frame.h
    const scale = fw >= 24 ? 2 : 3
    c.width = fw * scale
    c.height = fh * scale
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, c.width, c.height)
    const sx = (idx % 4) * fw
    const sy = Math.floor(idx / 4) * fh
    ctx.drawImage(img, sx, sy, fw, fh, 0, 0, c.width, c.height)
  }, [img, meta, dir, frameIdx])

  return (
    <button
      type="button"
      className={`sprite-frame-tile ${flipped ? 'flipped' : ''}`}
      disabled={disabled}
      title={`点击手动水平镜像 ${dir} 第 ${frameIdx + 1} 帧`}
      onClick={onClick}
    >
      <canvas ref={ref} />
      <span className="mono">{flipped ? `F${frameIdx + 1} ⇄` : `F${frameIdx + 1}`}</span>
    </button>
  )
}

/**
 * 像素形象工坊：将 4×4 四向行走图自动检测并纠偏方向后，
 * 通过本地程序化管线扩展为全套 22 种动作图集，并可同步到设置角色组与 ARM 设备端。
 */
export function CharacterSheetStudio({
  settings,
  onSettingsChange,
}: {
  settings?: SettingsView | null
  onSettingsChange?: (next: SettingsView) => void
}): React.ReactElement {
  const [characters, setCharacters] = useState<CharacterSheetView[]>([])
  const [samples, setSamples] = useState<CharacterSampleView[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reachable, setReachable] = useState(true)

  const [charName, setCharName] = useState(() => settings?.olvt.characterName || '')
  const [rowOrder, setRowOrder] = useState('auto')
  const [frameSizeKey, setFrameSizeKey] = useState('32x48')
  const [autoFixDir, setAutoFixDir] = useState(true)
  const [cleanInnerWhite, setCleanInnerWhite] = useState(true)
  const [autoApply, setAutoApply] = useState(true)
  const [sourceImage, setSourceImage] = useState<{
    filename: string
    imageBase64: string
    dataUrl: string
  } | null>(null)

  const [busy, setBusy] = useState(false)
  const [applyBusy, setApplyBusy] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const [aiPrompt, setAiPrompt] = useState('')
  const [aiRefImage, setAiRefImage] = useState<{
    filename: string
    imageBase64: string
    dataUrl: string
  } | null>(null)
  const [aiUse3dRef, setAiUse3dRef] = useState(false)
  const [aiAutoExpand, setAiAutoExpand] = useState(true)
  const [aiBusy, setAiBusy] = useState(false)
  const [hasRef3d, setHasRef3d] = useState(Boolean(settings?.hasRef3d))
  const [aiHistory, setAiHistory] = useState<Generated4x4ItemView[]>([])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)

  const [previewMode, setPreviewMode] = useState<'anim' | 'walkcheck' | 'overview'>('anim')
  const [previewDir, setPreviewDir] = useState('S')
  const [previewAct, setPreviewAct] = useState('walk')
  const [loadedAssets, setLoadedAssets] = useState<{
    charId: string
    meta: CharacterSheetMetaJson
    sheetDataUrl: string
    previewDataUrl?: string
  } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sheetImgRef = useRef<HTMLImageElement | null>(null)

  const refresh = useCallback(async (preferSelectId?: string | null) => {
    const res = await window.dhvw.characters()
    setReachable(res.ok)
    if (!res.ok) return
    setCharacters(res.characters)
    setActiveId(res.activeId)
    setSelectedId((prev) => {
      if (preferSelectId && res.characters.some((c) => c.id === preferSelectId)) return preferSelectId
      if (prev && res.characters.some((c) => c.id === prev)) return prev
      if (res.activeId && res.characters.some((c) => c.id === res.activeId)) return res.activeId
      return res.characters[0]?.id ?? null
    })
  }, [])

  const refreshHistory = useCallback(async () => {
    const res = await window.dhvw.imageHistory()
    if (res.ok && Array.isArray(res.items)) {
      setAiHistory(res.items)
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshHistory()
    void window.dhvw.characterSamples().then((r) => {
      if (r.ok) setSamples(r.samples)
    })
    void window.dhvw.characterRef3dGet().then((r) => {
      if (r.ok) setHasRef3d(Boolean(r.hasRef3d))
    })
  }, [refresh, refreshHistory, settings?.hasRef3d])

  const loadAssets = useCallback(async (charId: string) => {
    const res = await window.dhvw.characterAssets(charId)
    if (!res.ok || !res.meta || !res.sheetDataUrl) {
      setLoadedAssets(null)
      return
    }
    const img = new Image()
    img.src = res.sheetDataUrl
    await new Promise<void>((resolve) => {
      img.onload = () => resolve()
      img.onerror = () => resolve()
    })
    sheetImgRef.current = img
    setLoadedAssets({
      charId,
      meta: res.meta,
      sheetDataUrl: res.sheetDataUrl,
      previewDataUrl: res.previewDataUrl,
    })
    if (!res.meta.animations[previewAct]) {
      setPreviewAct(res.meta.animations.walk ? 'walk' : Object.keys(res.meta.animations)[0] || 'idle')
    }
  }, [previewAct])

  useEffect(() => {
    if (!selectedId) {
      setLoadedAssets(null)
      sheetImgRef.current = null
      return
    }
    void loadAssets(selectedId)
  }, [selectedId, loadAssets])

  useEffect(() => {
    if (previewMode !== 'anim' || !loadedAssets || !sheetImgRef.current || !canvasRef.current) return
    const { meta } = loadedAssets
    const img = sheetImgRef.current
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const fw = meta.frame.w
    const fh = meta.frame.h
    const scale = fw >= 24 ? 4 : 6
    canvas.width = fw * scale
    canvas.height = fh * scale
    ctx.imageSmoothingEnabled = false

    const anim = meta.animations[previewAct] || meta.animations.walk || meta.animations.idle
    if (!anim) return
    const frames = anim.frames[previewDir] || anim.frames.S || [0]
    const fps = Math.max(1, anim.fps || 6)
    let rafId = 0

    const draw = (now: number) => {
      const idx = frames[Math.floor((now / 1000) * fps) % frames.length] ?? 0
      const sx = (idx % 4) * fw
      const sy = Math.floor(idx / 4) * fh
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, sx, sy, fw, fh, 0, 0, canvas.width, canvas.height)
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [previewMode, loadedAssets, previewDir, previewAct])

  const pickFile = async (): Promise<void> => {
    setStatusMsg(null)
    const res = await window.dhvw.characterPickImage()
    if (res.canceled) return
    if (!res.ok || !res.imageBase64 || !res.dataUrl || !res.filename) {
      setStatusMsg({ ok: false, text: res.error ?? '读取图片失败' })
      return
    }
    setSourceImage({
      filename: res.filename,
      imageBase64: res.imageBase64,
      dataUrl: res.dataUrl,
    })
    if (!charName.trim()) {
      setCharName(res.filename.replace(/\.[^.]+$/, ''))
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const file = e.dataTransfer.files?.[0]
    if (!file) return
    if (!/\.(png|jpe?g|webp)$/i.test(file.name)) {
      setStatusMsg({ ok: false, text: '仅支持 PNG / JPG / WebP 格式的 4×4 行走图' })
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const comma = dataUrl.indexOf(',')
      if (comma < 0) return
      setSourceImage({
        filename: file.name,
        imageBase64: dataUrl.slice(comma + 1),
        dataUrl,
      })
      if (!charName.trim()) {
        setCharName(file.name.replace(/\.[^.]+$/, ''))
      }
      setStatusMsg(null)
    }
    reader.readAsDataURL(file)
  }

  const runGenerate = async (
    img: { filename: string; imageBase64: string },
    targetName: string,
    targetRowOrder: string,
  ): Promise<void> => {
    const fsOpt = FRAME_SIZE_OPTIONS.find((o) => o.value === frameSizeKey) ?? FRAME_SIZE_OPTIONS[0]!
    setBusy(true)
    setStatusMsg(null)
    try {
      const res = await window.dhvw.characterGenerate({
        name: targetName.trim() || undefined,
        filename: img.filename,
        imageBase64: img.imageBase64,
        rowOrder: targetRowOrder,
        frameW: fsOpt.fw,
        frameH: fsOpt.fh,
        autoApply,
        autoFixDir,
        cleanInnerWhite,
      })
      if (!res.ok || !res.character) {
        setStatusMsg({ ok: false, text: res.error ?? '扩展动作失败' })
        return
      }
      if (res.settings) onSettingsChange?.(res.settings)
      const fixCount = res.character.corrections?.length ?? 0
      const fixNote = fixCount > 0 ? `；自动纠偏 ${fixCount} 处方向错误` : ''
      const sceneCount = res.apply?.updatedScenes?.length ?? 0
      setStatusMsg({
        ok: true,
        text: autoApply
          ? `已扩展「${res.character.name}」全部 ${res.character.animations.length} 种动作${fixNote}，已设为当前主角并推送 ARM 端${sceneCount ? `（同步 ${sceneCount} 张产出地图）` : ''}`
          : `已生成「${res.character.name}」全部 ${res.character.animations.length} 种动作${fixNote}`,
      })
      await refresh(res.character.id)
      await loadAssets(res.character.id)
    } finally {
      setBusy(false)
    }
  }

  const submitGenerate = async (): Promise<void> => {
    if (!sourceImage) {
      setStatusMsg({ ok: false, text: '请先选择、拖入或载入下方内置 4×4 角色行走图' })
      return
    }
    await runGenerate(sourceImage, charName, rowOrder)
  }

  const handlePickAiRef = async (): Promise<void> => {
    const res = await window.dhvw.characterPickImage()
    if (!res.ok) {
      if (res.error) setStatusMsg({ ok: false, text: res.error })
      return
    }
    if (res.canceled || !res.imageBase64 || !res.dataUrl || !res.filename) return
    setAiRefImage({
      filename: res.filename,
      imageBase64: res.imageBase64,
      dataUrl: res.dataUrl,
    })
  }

  const handleAiGenerate4x4 = async (): Promise<void> => {
    if (!aiPrompt.trim() && !aiRefImage && !aiUse3dRef) {
      setStatusMsg({ ok: false, text: '请输入角色外貌提示词，或至少附带一张参考图' })
      return
    }
    setAiBusy(true)
    setStatusMsg({ ok: true, text: '正在调用生图模型生成 4×4 行走底图（含无文字、纯白底与朝向约束）…' })
    try {
      const res = await window.dhvw.imageGenerate({
        mode: 'character_4x4',
        prompt: aiPrompt.trim() || undefined,
        refImageBase64: aiRefImage?.imageBase64,
        use3dRef: aiUse3dRef,
      })
      if (!res.ok || !res.imageBase64 || !res.dataUrl) {
        setStatusMsg({ ok: false, text: res.error ?? 'AI 生图失败，请检查「设置 → 生图模型（API）」配置' })
        return
      }
      const nextImg = {
        filename: 'ai_4x4.png',
        imageBase64: res.imageBase64,
        dataUrl: res.dataUrl,
      }
      setSourceImage(nextImg)
      setStatusMsg({ ok: true, text: 'AI 4×4 行走底图生成完成！' })
      await refreshHistory()
      if (aiAutoExpand && reachable) {
        await runGenerate(nextImg, charName || 'ai_character', rowOrder)
      }
    } finally {
      setAiBusy(false)
    }
  }

  const useHistoryItem = async (item: Generated4x4ItemView, immediate: boolean): Promise<void> => {
    const nextImg = {
      filename: `${item.id}.png`,
      imageBase64: item.imageBase64,
      dataUrl: item.dataUrl,
    }
    setSourceImage(nextImg)
    const suggested = item.prompt.trim().slice(0, 14) || 'ai_character'
    if (!charName.trim()) setCharName(suggested)
    setStatusMsg({ ok: true, text: `已载入历史 4×4 生成图（${item.id}）` })
    if (immediate && reachable) {
      await runGenerate(nextImg, charName.trim() || suggested, rowOrder)
    }
  }

  const deleteHistoryItem = async (itemId: string): Promise<void> => {
    const res = await window.dhvw.imageHistoryDelete(itemId)
    if (res.ok) {
      setAiHistory((prev) => prev.filter((x) => x.id !== itemId))
    } else {
      setStatusMsg({ ok: false, text: res.error ?? '删除生成记录失败' })
    }
  }

  const useSample = async (sample: CharacterSampleView, immediate: boolean): Promise<void> => {
    setSourceImage({
      filename: sample.filename,
      imageBase64: sample.imageBase64,
      dataUrl: sample.dataUrl,
    })
    setCharName(sample.name)
    setRowOrder(sample.rowOrder)
    setStatusMsg({ ok: true, text: `已载入示例素材「${sample.name}」` })
    if (immediate && reachable) {
      await runGenerate(
        { filename: sample.filename, imageBase64: sample.imageBase64 },
        sample.name,
        sample.rowOrder,
      )
    }
  }

  const applyChar = async (charId: string): Promise<void> => {
    setApplyBusy(charId)
    setStatusMsg(null)
    try {
      const res = await window.dhvw.characterApply(charId, { applyToScenes: true, syncToolchain: true })
      if (!res.ok) {
        setStatusMsg({ ok: false, text: res.error ?? '应用失败' })
        return
      }
      if (res.settings) onSettingsChange?.(res.settings)
      const n = res.updatedScenes?.length ?? 0
      const delivered = res.delivered ?? 0
      setStatusMsg({
        ok: true,
        text: `已将主角切换为该角色并推送到 ${delivered} 台已连接 ARM 设备${n ? `（同步更新 ${n} 张产出地图）` : ''}`,
      })
      await refresh(charId)
    } finally {
      setApplyBusy(null)
    }
  }

  const regenerateSelected = async (charId: string): Promise<void> => {
    const fsOpt = FRAME_SIZE_OPTIONS.find((o) => o.value === frameSizeKey) ?? FRAME_SIZE_OPTIONS[0]!
    setBusy(true)
    setStatusMsg(null)
    try {
      const res = await window.dhvw.characterRegenerate(charId, {
        rowOrder,
        frameW: fsOpt.fw,
        frameH: fsOpt.fh,
        autoFixDir,
        cleanInnerWhite,
      })
      if (!res.ok || !res.character) {
        setStatusMsg({ ok: false, text: res.error ?? '重新扩展失败' })
        return
      }
      const fixCount = res.character.corrections?.length ?? 0
      setStatusMsg({
        ok: true,
        text: `已按 ${res.character.detectedRowOrder ?? rowOrder} / ${fsOpt.fw}×${fsOpt.fh} 重新生成「${res.character.name}」${fixCount ? `（自动纠偏 ${fixCount} 处）` : ''}`,
      })
      await refresh(charId)
      await loadAssets(charId)
    } finally {
      setBusy(false)
    }
  }

  const toggleManualFlip = async (char: CharacterSheetView, dir: string, frameIdx: number): Promise<void> => {
    const cur = { ...(char.manualFlips ?? {}) }
    const arr = [...(cur[dir] ?? [false, false, false, false])]
    arr[frameIdx] = !arr[frameIdx]
    cur[dir] = arr
    setBusy(true)
    setStatusMsg(null)
    try {
      const res = await window.dhvw.characterRegenerate(char.id, { manualFlips: cur })
      if (!res.ok || !res.character) {
        setStatusMsg({ ok: false, text: res.error ?? '手动翻转失败' })
        return
      }
      setStatusMsg({ ok: true, text: `已${arr[frameIdx] ? '启用' : '取消'} ${dir} 行第 ${frameIdx + 1} 帧手动镜像并重建全部动作` })
      await refresh(char.id)
      await loadAssets(char.id)
    } finally {
      setBusy(false)
    }
  }

  const swapDirectionCategory = async (
    char: CharacterSheetView,
    dirA: string,
    dirB: string,
  ): Promise<void> => {
    if (dirA === dirB) return
    const rawOrder = (char.detectedRowOrder || (char.rowOrder !== 'auto' ? char.rowOrder : 'S,W,E,N'))
      .split(',')
      .map((s) => s.trim().toUpperCase())
    const order = rawOrder.length === 4 ? rawOrder : ['S', 'W', 'E', 'N']
    const idxA = order.indexOf(dirA)
    const idxB = order.indexOf(dirB)
    if (idxA < 0 || idxB < 0) return
    const nextOrderList = [...order]
    nextOrderList[idxA] = dirB
    nextOrderList[idxB] = dirA
    const nextOrder = nextOrderList.join(',')

    const curFlips = { ...(char.manualFlips ?? {}) }
    const flipsA = curFlips[dirA]
    const flipsB = curFlips[dirB]
    if (flipsB) curFlips[dirA] = flipsB
    else delete curFlips[dirA]
    if (flipsA) curFlips[dirB] = flipsA
    else delete curFlips[dirB]

    setBusy(true)
    setStatusMsg(null)
    try {
      const res = await window.dhvw.characterRegenerate(char.id, {
        rowOrder: nextOrder,
        manualFlips: curFlips,
      })
      if (!res.ok || !res.character) {
        setStatusMsg({ ok: false, text: res.error ?? '更换大类朝向失败' })
        return
      }
      setStatusMsg({
        ok: true,
        text: `已将原「${dirA}」与「${dirB}」整行大类对调（当前行序：${res.character.detectedRowOrder ?? nextOrder}）并重建动作`,
      })
      await refresh(char.id)
      await loadAssets(char.id)
    } finally {
      setBusy(false)
    }
  }

  const submitRename = async (charId: string): Promise<void> => {
    const clean = renameDraft.trim()
    if (!clean) {
      setStatusMsg({ ok: false, text: '角色名称不能为空' })
      return
    }
    setRenameBusy(true)
    setStatusMsg(null)
    try {
      const res = await window.dhvw.characterRename(charId, clean)
      if (!res.ok || !res.character) {
        setStatusMsg({ ok: false, text: res.error ?? '重命名失败' })
        return
      }
      if (res.settings) onSettingsChange?.(res.settings)
      setRenamingId(null)
      setStatusMsg({ ok: true, text: `已将角色重命名为「${res.character.name}」` })
      await refresh(charId)
    } finally {
      setRenameBusy(false)
    }
  }

  const resetManualFlips = async (char: CharacterSheetView): Promise<void> => {
    setBusy(true)
    setStatusMsg(null)
    try {
      const res = await window.dhvw.characterRegenerate(char.id, { manualFlips: {} })
      if (!res.ok || !res.character) {
        setStatusMsg({ ok: false, text: res.error ?? '重置失败' })
        return
      }
      setStatusMsg({ ok: true, text: '已重置所有手动镜像覆盖，仅保留自动方向纠偏' })
      await refresh(char.id)
      await loadAssets(char.id)
    } finally {
      setBusy(false)
    }
  }

  const deleteChar = async (charId: string, name: string): Promise<void> => {
    if (!window.confirm(`确定删除角色「${name}」？`)) return
    const res = await window.dhvw.characterDelete(charId)
    if (!res.ok) {
      setStatusMsg({ ok: false, text: res.error ?? '删除失败' })
      return
    }
    if (res.settings) onSettingsChange?.(res.settings)
    setStatusMsg({ ok: true, text: `已删除角色「${name}」` })
    await refresh()
  }

  const exportFile = async (file: 'sheet.png' | 'sheet.json' | 'preview.png'): Promise<void> => {
    if (!selectedChar) return
    const res = await window.dhvw.characterExport({
      charId: selectedChar.id,
      name: selectedChar.name,
      file,
    })
    if (res.canceled) return
    if (res.ok) setStatusMsg({ ok: true, text: `已导出到 ${res.path}` })
    else setStatusMsg({ ok: false, text: res.error ?? '导出失败' })
  }

  const selectedChar = characters.find((c) => c.id === selectedId) ?? null
  const availableAnims = loadedAssets ? Object.keys(loadedAssets.meta.animations) : []
  const hasManualFlips = Boolean(
    selectedChar?.manualFlips && Object.values(selectedChar.manualFlips).some((arr) => arr.some(Boolean)),
  )

  return (
    <div className="agent-grid">
      <section className="panel agent-form">
        <h2>像素形象工坊</h2>
        <div className="sprite-guide-box">
          <strong>操作说明与方向自动纠错功能：</strong>
          <ol>
            <li>
              上传任意 <b>4 行×4 帧</b> 角色行走图（支持白底 JPG 或透明 PNG），或直接载入下方内置示例素材。
            </li>
            <li>
              <b>内置程序化方向纠错</b>：自动识别 <code>N/S/E/W</code> 行序，检测并水平镜像修复 AI 常见错帧（如某帧朝向反转、<code>W/E</code> 互反、两行同向或跨向错帧），并清理头发/手臂围合的闭合白底空隙。
            </li>
            <li>
              生成后可在右侧「实时动画 / 4×4 朝向核验」确认效果，也可在 <b>「设置 → 角色与语音 → 像素角色模型」</b> 自由切换角色并同步至 ARM 端显示。
            </li>
          </ol>
        </div>

        <div className="sprite-ai-box">
          <div className="sprite-ai-head">
            <strong>AI 生成 4×4 行走底图（可选）</strong>
            <span className="hint">
              {settings?.imageGen?.enabled
                ? `已接入生图：${settings.imageGen.model || settings.imageGen.protocol}`
                : '请先在「设置 → 生图模型（API）」开启并保存'}
            </span>
          </div>
          <textarea
            rows={2}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="描述角色外貌（如：双马尾蓝发少女、水手服、黑色短靴），系统会自动追加无文字/无网格/纯白底/Q版4×4四向约束…"
          />
          <div className="sprite-ai-controls">
            <button
              type="button"
              className="secondary"
              disabled={aiBusy || busy}
              onClick={() => void handlePickAiRef()}
            >
              {aiRefImage ? `更换参考图 (${aiRefImage.filename})` : '选用上传参考图'}
            </button>
            {aiRefImage && (
              <>
                <img className="sprite-ai-refthumb" src={aiRefImage.dataUrl} alt="ref" />
                <button
                  type="button"
                  className="secondary"
                  disabled={aiBusy || busy}
                  onClick={() => setAiRefImage(null)}
                >
                  清除参考图
                </button>
              </>
            )}
            <label className="inline-check">
              <input
                type="checkbox"
                checked={aiUse3dRef}
                disabled={!hasRef3d || aiBusy || busy}
                onChange={(e) => setAiUse3dRef(e.target.checked)}
              />
              附带设置中的角色三维参考图{!hasRef3d ? '（未上传）' : ''}
            </label>
            <label className="inline-check">
              <input
                type="checkbox"
                checked={aiAutoExpand}
                disabled={aiBusy || busy}
                onChange={(e) => setAiAutoExpand(e.target.checked)}
              />
              生成后自动纠偏并扩展 22 动作
            </label>
          </div>
          <div className="actions">
            <button
              type="button"
              disabled={aiBusy || busy || !settings?.imageGen?.enabled}
              onClick={() => void handleAiGenerate4x4()}
            >
              {aiBusy ? '正在 AI 生成 4×4 原图…' : 'AI 生成 4×4 原图'}
            </button>
          </div>
          {aiHistory.length > 0 && (
            <div className="sprite-ai-history">
              <div className="sprite-ai-history-title">
                <strong>已生成的 4×4 原图列表（{aiHistory.length}）</strong>
                <span className="hint">点击载入底图或直接扩展动作，不需要可删除</span>
              </div>
              <div className="sprite-ai-history-list">
                {aiHistory.map((item) => (
                  <div className="sprite-ai-history-card" key={item.id}>
                    <img src={item.dataUrl} alt={item.prompt || item.id} />
                    <div className="sprite-ai-history-meta">
                      <span className="sprite-ai-history-prompt" title={item.prompt}>
                        {item.prompt || '（参考图生成）'}
                      </span>
                      <span className="hint mono">
                        {item.model || 'image-gen'} · {new Date(item.createdAt).toLocaleTimeString()}
                      </span>
                      <div className="actions">
                        <button
                          type="button"
                          disabled={busy || aiBusy}
                          onClick={() => void useHistoryItem(item, false)}
                        >
                          载入
                        </button>
                        <button
                          type="button"
                          className="primary"
                          disabled={busy || aiBusy}
                          onClick={() => void useHistoryItem(item, true)}
                        >
                          扩展
                        </button>
                        <button
                          type="button"
                          disabled={busy || aiBusy}
                          onClick={() => void deleteHistoryItem(item.id)}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div
          className="sprite-dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          {sourceImage ? (
            <div className="sprite-source-preview">
              <img src={sourceImage.dataUrl} alt={sourceImage.filename} />
              <div className="sprite-source-meta">
                <span className="mono">{sourceImage.filename}</span>
                <button type="button" onClick={() => void pickFile()}>
                  更换图片
                </button>
              </div>
            </div>
          ) : (
            <div className="sprite-drop-empty">
              <p>将 4×4 行走图拖到这里，或点击选择图片</p>
              <button type="button" className="primary" onClick={() => void pickFile()}>
                选择 4×4 行走图 (PNG / JPG)
              </button>
            </div>
          )}
        </div>

        <div className="row2">
          <div className="field">
            <label>角色名称</label>
            <input
              value={charName}
              onChange={(e) => setCharName(e.target.value)}
              spellCheck={false}
              placeholder="如 鲸鱼娘"
            />
          </div>
          <div className="field">
            <label>输出单帧尺寸</label>
            <select value={frameSizeKey} onChange={(e) => setFrameSizeKey(e.target.value)}>
              {FRAME_SIZE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label>输入图片 4 行朝向顺序（从上到下）</label>
          <select value={rowOrder} onChange={(e) => setRowOrder(e.target.value)}>
            {ROW_ORDER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <label className="sprite-check">
          <input
            type="checkbox"
            checked={autoFixDir}
            onChange={(e) => setAutoFixDir(e.target.checked)}
          />
          <span>开启 AI 方向自动纠错（自动修复单帧反转 / 整行颠倒 / 跨向错帧）</span>
        </label>

        <label className="sprite-check">
          <input
            type="checkbox"
            checked={cleanInnerWhite}
            onChange={(e) => setCleanInnerWhite(e.target.checked)}
          />
          <span>自动清理头发/手臂围合的闭合白底空隙</span>
        </label>

        <label className="sprite-check">
          <input
            type="checkbox"
            checked={autoApply}
            onChange={(e) => setAutoApply(e.target.checked)}
          />
          <span>生成后自动设为当前主角，并同步到 ARM 端与产出地图</span>
        </label>

        {statusMsg && <p className={`msg ${statusMsg.ok ? 'ok' : 'bad'}`}>{statusMsg.text}</p>}

        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={busy || !sourceImage || !reachable}
            onClick={() => void submitGenerate()}
          >
            {busy ? '正在纠错与扩展…' : '自动纠错并扩展 22 种动作'}
          </button>
          <button type="button" onClick={() => void refresh()}>
            刷新列表
          </button>
        </div>

        {samples.length > 0 && (
          <div className="sprite-samples-box">
            <h3>内置示例素材（一键载入对比测试）</h3>
            <div className="sprite-samples-list">
              {samples.map((s) => (
                <div className="sprite-sample-card" key={s.id}>
                  <img src={s.dataUrl} alt={s.name} className="sprite-sample-thumb" />
                  <div className="sprite-sample-body">
                    <div className="sprite-sample-title">
                      <strong>{s.name}</strong>
                      <span className={`pill ${s.id === 'miku_err' ? 'ok' : ''}`}>{s.badge}</span>
                    </div>
                    <p className="hint">{s.description}</p>
                    <div className="actions">
                      <button type="button" disabled={busy} onClick={() => void useSample(s, false)}>
                        载入素材
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy || !reachable}
                        onClick={() => void useSample(s, true)}
                      >
                        载入并自动纠错扩展
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      <div className="agent-right">
        <section className="panel sprite-preview-panel">
          <div className="label-row">
            <h2>
              动作实时验收
              {selectedChar && <span className="pill ok">{selectedChar.name}</span>}
              {selectedChar && selectedChar.id === activeId && <span className="pill ok">当前主角</span>}
              {selectedChar?.detectedRowOrder && (
                <span className="pill mono">行序 {selectedChar.detectedRowOrder}</span>
              )}
            </h2>
            {loadedAssets && (
              <div className="actions">
                <button
                  type="button"
                  className={previewMode === 'anim' ? 'primary' : ''}
                  onClick={() => setPreviewMode('anim')}
                >
                  实时动画
                </button>
                <button
                  type="button"
                  className={previewMode === 'walkcheck' ? 'primary' : ''}
                  onClick={() => setPreviewMode('walkcheck')}
                >
                  4×4 朝向核验
                </button>
                <button
                  type="button"
                  className={previewMode === 'overview' ? 'primary' : ''}
                  onClick={() => setPreviewMode('overview')}
                >
                  22 动作总览图
                </button>
              </div>
            )}
          </div>

          {selectedChar?.corrections && selectedChar.corrections.length > 0 && (
            <div className="sprite-fix-banner">
              <strong>方向纠偏已生效（{selectedChar.corrections.length} 处）：</strong>
              <ul>
                {selectedChar.corrections.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            </div>
          )}

          {!selectedChar || !loadedAssets ? (
            <div className="empty">
              {reachable ? '左侧上传或载入内置 4×4 行走图后，可在此实时预览全部 22 种动作' : '编排器未就绪'}
            </div>
          ) : previewMode === 'overview' ? (
            <div className="sprite-overview-box">
              {loadedAssets.previewDataUrl ? (
                <img src={loadedAssets.previewDataUrl} alt="22 动作总览" />
              ) : (
                <div className="empty">暂无总览图</div>
              )}
            </div>
          ) : previewMode === 'walkcheck' && sheetImgRef.current ? (
            <div className="sprite-walkcheck-box">
              <div className="sprite-walkcheck-head">
                <span className="hint">
                  若整行大类标错（如正面/背面标反或左右侧标反），可用下方快速互换或下拉重设整行归属；单帧反向可点击该帧水平镜像。
                </span>
                <div className="actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void swapDirectionCategory(selectedChar, 'S', 'N')}
                  >
                    ⇄ 互换正/背面 (S⇄N)
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void swapDirectionCategory(selectedChar, 'W', 'E')}
                  >
                    ⇄ 互换左右侧 (W⇄E)
                  </button>
                  {hasManualFlips && (
                    <button type="button" disabled={busy} onClick={() => void resetManualFlips(selectedChar)}>
                      重置手动镜像
                    </button>
                  )}
                </div>
              </div>
              <div className="sprite-walkcheck-grid">
                {DIR_LABELS.map((d) => (
                  <div className="sprite-walkcheck-row" key={d.key}>
                    <div className="sprite-walkcheck-dir-ctrl">
                      <span className="sprite-walkcheck-dir">{d.label}</span>
                      <select
                        value={d.key}
                        disabled={busy}
                        title={`将当前「${d.label}」这组动作换为其他方向大类（将与目标方向整行对调）`}
                        onChange={(e) => void swapDirectionCategory(selectedChar, d.key, e.target.value)}
                      >
                        {DIR_LABELS.map((opt) => (
                          <option key={opt.key} value={opt.key}>
                            {opt.key === d.key ? `设为 ${opt.label}` : `换为 ${opt.label}`}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="sprite-walkcheck-frames">
                      {[0, 1, 2, 3].map((fIdx) => (
                        <WalkFrameTile
                          key={`${d.key}-${fIdx}`}
                          img={sheetImgRef.current!}
                          meta={loadedAssets.meta}
                          dir={d.key}
                          frameIdx={fIdx}
                          flipped={Boolean(selectedChar.manualFlips?.[d.key]?.[fIdx])}
                          disabled={busy}
                          onClick={() => void toggleManualFlip(selectedChar, d.key, fIdx)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="sprite-stage-wrap">
              <div className="sprite-stage">
                <canvas ref={canvasRef} className="sprite-canvas" />
                <div className="sprite-stage-info mono">
                  <span>{ACTION_LABELS[previewAct] ? `${previewAct} · ${ACTION_LABELS[previewAct]}` : previewAct}</span>
                  <span>
                    {loadedAssets.meta.frame.w}×{loadedAssets.meta.frame.h}px ·{' '}
                    {loadedAssets.meta.animations[previewAct]?.fps ?? 6} fps
                  </span>
                </div>
                <div className="sprite-dirs">
                  {DIR_LABELS.map((d) => (
                    <button
                      key={d.key}
                      type="button"
                      className={previewDir === d.key ? 'primary' : ''}
                      onClick={() => setPreviewDir(d.key)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sprite-action-pills">
                {availableAnims.map((act) => (
                  <button
                    key={act}
                    type="button"
                    className={`sprite-act-btn ${previewAct === act ? 'active' : ''}`}
                    onClick={() => setPreviewAct(act)}
                  >
                    <span>{ACTION_LABELS[act] ?? act}</span>
                    <span className="mono">{act}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {selectedChar && (
            <div className="actions sprite-export-bar">
              <button
                type="button"
                className="primary"
                disabled={applyBusy === selectedChar.id}
                onClick={() => void applyChar(selectedChar.id)}
              >
                {applyBusy === selectedChar.id ? '同步中…' : '设为当前主角并推送 ARM 端'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void regenerateSelected(selectedChar.id)}
              >
                按左侧参数重生成
              </button>
              <button type="button" onClick={() => void exportFile('sheet.png')}>
                导出 sheet.png
              </button>
              <button type="button" onClick={() => void exportFile('sheet.json')}>
                导出 sheet.json
              </button>
            </div>
          )}
        </section>

        <section className="panel sprite-lib-panel">
          <h2>
            角色精灵库
            <span className="pill mono">{characters.length} 个</span>
          </h2>
          {characters.length === 0 ? (
            <div className="empty">暂无已扩展的角色精灵，请在左侧上传或载入内置 4×4 行走图生成</div>
          ) : (
            <div className="sprite-lib-list">
              {characters.map((c) => (
                <div className={`job ${c.id === selectedId ? 'done' : ''}`} key={c.id}>
                  <div className="job-head">
                    {renamingId === c.id ? (
                      <div className="sprite-rename-row">
                        <input
                          type="text"
                          value={renameDraft}
                          maxLength={40}
                          disabled={renameBusy}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void submitRename(c.id)
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          autoFocus
                        />
                        <button type="button" className="primary" disabled={renameBusy} onClick={() => void submitRename(c.id)}>
                          {renameBusy ? '保存中…' : '保存'}
                        </button>
                        <button type="button" disabled={renameBusy} onClick={() => setRenamingId(null)}>
                          取消
                        </button>
                      </div>
                    ) : (
                      <span className="job-name">{c.name}</span>
                    )}
                    {c.id === activeId && <span className="pill ok">当前主角</span>}
                    {c.corrections && c.corrections.length > 0 && (
                      <span className="pill ok">已纠偏 {c.corrections.length}</span>
                    )}
                    <span className="job-meta mono">
                      {c.frame.w}×{c.frame.h} · {c.animations.length} 动作 · {c.detectedRowOrder ?? c.rowOrder}
                    </span>
                    <button type="button" onClick={() => setSelectedId(c.id)}>
                      预览
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(c.id)
                        setRenameDraft(c.name)
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      className={c.id === activeId ? '' : 'primary'}
                      disabled={applyBusy === c.id}
                      onClick={() => void applyChar(c.id)}
                    >
                      {c.id === activeId ? '重新推送 ARM' : '设为当前'}
                    </button>
                    <button type="button" onClick={() => void deleteChar(c.id, c.name)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
