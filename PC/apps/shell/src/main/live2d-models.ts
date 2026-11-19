import fs from 'node:fs'
import path from 'node:path'

/**
 * Live2D 模型库：PC 舞台和 OLVT 共用同一份模型。
 *
 * 目录约定：`<库根>/<模型 id>/runtime/*.model3.json`（OLVT 标准）或 `<库根>/<模型 id>/*.model3.json`。
 * 两个库根按顺序取第一个命中的：随包资源（resources/live2d/models）→ OLVT 组件的 live2d-models。
 */
export interface Live2dModelRef {
  id: string
  /** model3.json 文件名 */
  file: string
  /** 相对于模型目录的 model3.json 路径（如 runtime/mao_pro.model3.json 或 大肥鱼.model3.json，POSIX 斜杠） */
  relFile: string
  /** 模型目录 */
  dir: string
  /** 该模型来自哪个库 */
  source: 'bundled' | 'olvt'
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

export function isSafeModelId(id: string): boolean {
  return SAFE_ID.test(id)
}

function findModelEntry(dir: string): { file: string; relFile: string } | null {
  try {
    const runtimeFiles = fs.readdirSync(path.join(dir, 'runtime'))
    const runtimeModel = runtimeFiles.find((f) => f.toLowerCase().endsWith('.model3.json'))
    if (runtimeModel) return { file: runtimeModel, relFile: `runtime/${runtimeModel}` }
  } catch {
    // 无 runtime 目录时继续尝试模型根目录（兼容 VTube Studio 直接导出的目录结构）
  }
  try {
    const rootFiles = fs.readdirSync(dir)
    const rootModel = rootFiles.find((f) => f.toLowerCase().endsWith('.model3.json'))
    if (rootModel) return { file: rootModel, relFile: rootModel }
  } catch {
    return null
  }
  return null
}

/** 扫一个库根下的模型：支持 `<id>/runtime/*.model3.json` 与 `<id>/*.model3.json` */
export function scanModels(root: string, source: Live2dModelRef['source']): Live2dModelRef[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out: Live2dModelRef[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeModelId(entry.name)) continue
    const dir = path.join(root, entry.name)
    const hit = findModelEntry(dir)
    if (hit) out.push({ id: entry.name, file: hit.file, relFile: hit.relFile, dir, source })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** 合并多个库根；同 id 以先出现的为准（随包资源优先） */
export function listModels(roots: Array<{ root: string; source: Live2dModelRef['source'] }>): Live2dModelRef[] {
  const seen = new Map<string, Live2dModelRef>()
  for (const { root, source } of roots) {
    for (const model of scanModels(root, source)) {
      if (!seen.has(model.id)) seen.set(model.id, model)
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export function findModel(
  roots: Array<{ root: string; source: Live2dModelRef['source'] }>,
  id: string,
): Live2dModelRef | null {
  if (!isSafeModelId(id)) return null
  return listModels(roots).find((m) => m.id === id) ?? null
}

/**
 * OLVT 的 model_dict.json 条目：OLVT 只用 emotionMap/idleMotionGroupName 做提示词与动作，
 * 渲染在我们自己的舞台。已有同名条目保持原样（mao_pro 的取景参数是上游调过的）。
 */
export function olvtModelEntry(model: Live2dModelRef): Record<string, unknown> {
  let idleGroup = 'Idle'
  let expressionCount = 0
  try {
    const json = JSON.parse(fs.readFileSync(path.join(model.dir, ...model.relFile.split('/')), 'utf8')) as {
      FileReferences?: { Motions?: Record<string, unknown[]>; Expressions?: unknown[] }
    }
    const motions = json.FileReferences?.Motions ?? {}
    const names = Object.keys(motions)
    if (!names.includes('Idle') && names.length > 0) idleGroup = names[0] ?? idleGroup
    expressionCount = (json.FileReferences?.Expressions ?? []).length
  } catch {
    // 读不动就用默认值；缺字段 OLVT 会在启动时报错，这里不假装模型可用
  }
  const emotions = ['neutral', 'joy', 'sadness', 'anger', 'fear', 'disgust', 'surprise', 'smirk']
  const emotionMap: Record<string, number> = {}
  if (expressionCount > 0) {
    emotions.forEach((key, i) => (emotionMap[key] = i % expressionCount))
  }
  return {
    name: model.id,
    description: '',
    url: `/live2d-models/${model.id}/${model.relFile}`,
    kScale: 0.5,
    initialXshift: 0,
    initialYshift: 0,
    kXOffset: 1150,
    idleMotionGroupName: idleGroup,
    emotionMap,
    tapMotions: {},
  }
}

/** 舞台页面用的模型地址（服务端路由见 live2d.ts） */
export function modelUrlPath(model: Live2dModelRef): string {
  const encodedRel = model.relFile.split('/').map(encodeURIComponent).join('/')
  return `/model/${encodeURIComponent(model.id)}/${encodedRel}`
}
