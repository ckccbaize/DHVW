import fs from 'node:fs'
import path from 'node:path'
import { COMPONENTS, resolveComponentDir } from './components'
import { overridesRoot, bundledResourceDir } from './paths'
import { renderOlvtConf, writeOlvtConf, type OlvtConfInput } from './olvt-conf'
import { olvtModelEntry, type Live2dModelRef } from './live2d-models'
import { log } from './logger'

/** 上游 OLVT 未开放请求头/额外请求体，这两个补丁随组件一起落地覆盖 */
const OVERRIDES = overridesRoot()

export function olvtSpec() {
  const spec = COMPONENTS.find((c) => c.id === 'olvt')
  if (!spec) throw new Error('缺少 OLVT 组件定义')
  return spec
}

export function asrSpec() {
  const spec = COMPONENTS.find((c) => c.id === 'asr-sensevoice')
  if (!spec) throw new Error('缺少 ASR 组件定义')
  return spec
}

/** 目录里真有 run_server.py 才算可用（组件未下载或下载到一半都会走到 false） */
export function isOlvtDir(dir: string): boolean {
  return Boolean(dir) && fs.existsSync(path.join(dir, 'run_server.py'))
}

export function resolveOlvtDir(overrideDir: string): string {
  for (const dir of [overrideDir, resolveComponentDir(olvtSpec())]) {
    if (isOlvtDir(dir)) return dir
  }
  return ''
}

function copyOverrides(dir: string): void {
  if (!fs.existsSync(OVERRIDES)) return
  const walk = (src: string, rel: string): void => {
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, entry.name)
      const relPath = path.join(rel, entry.name)
      if (entry.isDirectory()) {
        walk(from, relPath)
        continue
      }
      const to = path.join(dir, relPath)
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
      log('info', 'olvt', '补丁已落地', { file: relPath })
    }
  }
  walk(OVERRIDES, '')
}

export interface PrepareInput extends Omit<OlvtConfInput, 'port'> {
  dir: string
  port: number
}

/**
 * 上游 GitHub 源码归档里 `frontend/` 只有源码，没有构建产物，下载完 `/?remote=1` 直接 404
 * ——显现模式必然打不开（2026-11-21 实测）。所以前端产物随安装包带一份，缺了才拷。
 * 已有 `index.html` 就不动，避免覆盖用户手工替换的前端。
 */
function ensureFrontend(dir: string): void {
  const bundled = path.join(bundledResourceDir(), 'olvt-frontend')
  if (!fs.existsSync(path.join(bundled, 'index.html'))) {
    log('warn', 'olvt', '随包前端产物缺失，显现页面将不可用', { dir: bundled })
    return
  }
  const target = path.join(dir, 'frontend')
  if (fs.existsSync(path.join(target, 'index.html'))) return
  fs.mkdirSync(target, { recursive: true })
  fs.cpSync(bundled, target, { recursive: true, force: true })
  log('info', 'olvt', '前端产物已落地', { dir: target })
}

/**
 * 把选中的模型同步进 OLVT 目录：模型文件（缺才拷）+ model_dict.json 条目。
 * OLVT 只在自己的 `live2d-models/` 与 `model_dict.json` 里找模型，二者必须一起就位。
 */
export function syncOlvtModel(dir: string, model: Live2dModelRef): void {
  const lib = path.join(dir, 'live2d-models')
  const target = path.join(lib, model.id)
  if (path.resolve(target) !== path.resolve(model.dir) && !fs.existsSync(target)) {
    fs.mkdirSync(lib, { recursive: true })
    fs.cpSync(model.dir, target, { recursive: true })
    log('info', 'olvt', '模型已复制进 OLVT', { model: model.id, from: model.dir })
  }

  const dictFile = path.join(dir, 'model_dict.json')
  let dict: Array<Record<string, unknown>> = []
  try {
    const parsed = JSON.parse(fs.readFileSync(dictFile, 'utf8')) as unknown
    if (Array.isArray(parsed)) dict = parsed as Array<Record<string, unknown>>
  } catch {
    // 文件缺失/损坏：按空表重建，条目信息由模型文件推导
  }
  const index = dict.findIndex((m) => m && m.name === model.id)
  if (index >= 0) return
  dict.push(olvtModelEntry(model))
  fs.writeFileSync(dictFile, JSON.stringify(dict, null, 4), 'utf8')
  log('info', 'olvt', 'model_dict.json 已补条目', { model: model.id })
}

/** 写 conf.yaml + 落地补丁；返回 conf 路径 */
export function prepareOlvt(input: PrepareInput): string {
  copyOverrides(input.dir)
  ensureFrontend(input.dir)
  const conf = writeOlvtConf(input.dir, renderOlvtConf(input))
  log('info', 'olvt', 'conf.yaml 已生成', {
    dir: input.dir,
    port: input.port,
    llm: input.llm.baseUrl,
    model: input.llm.model,
    asr: input.asr.enabled,
  })
  return conf
}

/** ASR 模型路径（组件未下载时返回空串，conf 里如实留空） */
export function asrModelPaths(enabled: boolean): { modelPath: string; tokensPath: string } {
  if (!enabled) return { modelPath: '', tokensPath: '' }
  const dir = resolveComponentDir(asrSpec())
  const model = path.join(dir, 'model.int8.onnx')
  const tokens = path.join(dir, 'tokens.txt')
  if (!fs.existsSync(model) || !fs.existsSync(tokens)) return { modelPath: '', tokensPath: '' }
  return { modelPath: model, tokensPath: tokens }
}
