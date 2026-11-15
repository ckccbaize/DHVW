import fs from 'node:fs'
import path from 'node:path'

/**
 * Live2D 模型库：PC 舞台和 OLVT 共用同一份模型。
 *
 * 目录约定（与 OLVT 一致）：`<库根>/<模型 id>/runtime/<id>.model3.json`。
 * 两个库根按顺序取第一个命中的：随包资源（resources/live2d/models）→ OLVT 组件的 live2d-models。
 */
export interface Live2dModelRef {
  id: string
  /** model3.json 文件名 */
  file: string
  /** 模型目录（含 runtime/） */
  dir: string
  /** 启动时该模型来自哪个库 */
  source: 'bundled' | 'olvt' | 'user'
}

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isSafeModelId(id: string): boolean {
  return SAFE_ID.test(id)
}

/** 扫一个库根下的模型：只看 `<id>/runtime/*.model3.json` */
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
    const runtime = path.join(dir, 'runtime')
    let files: string[]
    try {
      files = fs.readdirSync(runtime)
    } catch {
      continue
    }
    const file = files.find((f) => f.toLowerCase().endsWith('.model3.json'))
    if (file) out.push({ id: entry.name, file, dir, source })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** 目录里 runtime/*.model3.json 的文件名，没有则 null */
function modelFileOf(dir: string): string | null {
  try {
    return fs.readdirSync(path.join(dir, 'runtime')).find((f) => f.toLowerCase().endsWith('.model3.json')) ?? null
  } catch {
    return null
  }
}

/** 从文件夹名推出合法模型 id；推不出返回 null（不猜） */
function idFromDirName(name: string): string | null {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64)
  return isSafeModelId(id) ? id : null
}

export interface ImportResult {
  imported: string[]
  errors: string[]
}

/**
 * 把用户选的文件夹里的模型复制进用户模型库。
 * 支持两种布局：选中的就是模型目录（含 runtime/），或选中一堆模型目录的父目录（逐个导入）。
 * 同名不覆盖——已有模型请先在库里删掉，避免把正在用的模型静默换掉。
 */
export function importModels(srcDir: string, destRoot: string): ImportResult {
  const out: ImportResult = { imported: [], errors: [] }
  let isDir = false
  try {
    isDir = fs.statSync(srcDir).isDirectory()
  } catch {
    out.errors.push('所选路径不存在或不是文件夹')
    return out
  }
  if (!isDir) {
    out.errors.push('所选路径不是文件夹')
    return out
  }
  const candidates = modelFileOf(srcDir)
    ? [srcDir]
    : fs
        .readdirSync(srcDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(srcDir, e.name))
        .filter((d) => modelFileOf(d) !== null)
  if (candidates.length === 0) {
    out.errors.push('所选文件夹里没有模型：需要 <模型>/runtime/*.model3.json')
    return out
  }
  for (const dir of candidates) {
    const id = idFromDirName(path.basename(dir))
    if (!id) {
      out.errors.push(`${path.basename(dir)}：文件夹名要能以小写字母/数字开头（只允许 a-z 0-9 _ -）`)
      continue
    }
    const target = path.join(destRoot, id)
    if (fs.existsSync(target)) {
      out.errors.push(`${id}：模型库里已有同名模型（先删掉旧目录再导入）`)
      continue
    }
    try {
      fs.mkdirSync(destRoot, { recursive: true })
      fs.cpSync(dir, target, { recursive: true })
      out.imported.push(id)
    } catch (err) {
      out.errors.push(`${id}：复制失败 ${(err as Error).message}`)
    }
  }
  return out
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
    const json = JSON.parse(fs.readFileSync(path.join(model.dir, 'runtime', model.file), 'utf8')) as {
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
    url: `/live2d-models/${model.id}/runtime/${model.file}`,
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
  return `/model/${model.id}/runtime/${encodeURIComponent(model.file)}`
}
