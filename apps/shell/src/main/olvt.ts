import fs from 'node:fs'
import path from 'node:path'
import { componentDir, COMPONENTS } from './components'
import { overridesRoot } from './paths'
import { renderOlvtConf, writeOlvtConf, type OlvtConfInput } from './olvt-conf'
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
  for (const dir of [overrideDir, componentDir(olvtSpec())]) {
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

/** 写 conf.yaml + 落地补丁；返回 conf 路径 */
export function prepareOlvt(input: PrepareInput): string {
  copyOverrides(input.dir)
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
  const dir = componentDir(asrSpec())
  const model = path.join(dir, 'model.int8.onnx')
  const tokens = path.join(dir, 'tokens.txt')
  if (!fs.existsSync(model) || !fs.existsSync(tokens)) return { modelPath: '', tokensPath: '' }
  return { modelPath: model, tokensPath: tokens }
}
