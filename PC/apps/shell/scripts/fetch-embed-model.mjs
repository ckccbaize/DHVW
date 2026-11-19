// 准备随包内置的中文句向量模型（bge-small-zh-v1.5 量化 ONNX，约 24.5 MB）：
// 优先从国内镜像下载到 apps/shell/resources/models/bge-small-zh-v1.5（ADR-PC-017）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadWithMirrors } from './lib/mirror.mjs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const shellDir = path.resolve(dir, '..')
const modelDir = path.join(shellDir, 'resources', 'models', 'bge-small-zh-v1.5')

const FILES = [
  {
    name: 'config.json',
    minBytes: 100,
    urls: ['https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/config.json'],
  },
  {
    name: 'tokenizer.json',
    minBytes: 100_000,
    urls: ['https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/tokenizer.json'],
  },
  {
    name: 'model.onnx',
    minBytes: 10_000_000,
    urls: ['https://hf-mirror.com/Xenova/bge-small-zh-v1.5/resolve/main/onnx/model_quantized.onnx'],
  },
]

fs.mkdirSync(modelDir, { recursive: true })
for (const f of FILES) {
  const target = path.join(modelDir, f.name)
  if (fs.existsSync(target) && fs.statSync(target).size >= f.minBytes && !process.argv.includes('--force')) {
    continue
  }
  await downloadWithMirrors(f.urls, target, { label: `bge-small-zh-v1.5/${f.name}`, minBytes: f.minBytes })
}
console.log(`[ok] 句向量模型就绪：${modelDir}`)
