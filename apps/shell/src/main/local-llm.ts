import fs from 'node:fs'
import path from 'node:path'
import { componentsRoot, dataDir, resourcesRoot } from './paths'

export const NEMOTRON_MODEL_ID = 'nemotron-3.5-bolt-e4b'
export const NEMOTRON_FILE = 'NVIDIA-Nemotron-3.5-Bolt-E4B-Uncensored-AD-Q4_K_M-00001-of-00001.gguf'
export const NEMOTRON_SHA256 = '6f31c73b2fcac7464045f99a42dad707fe999e3691ca205fe4875358d14f0779'
export const NEMOTRON_MIN_BYTES = 5_000_000_000
export const NEMOTRON_RECOMMENDED_TEMP = 1.05

export const NEMOTRON_URLS: string[] = [
  'https://hf-mirror.com/AtomicChat/NVIDIA-Nemotron-3.5-Bolt-E4B-Uncensored-GGUF/resolve/main/NVIDIA-Nemotron-3.5-Bolt-E4B-Uncensored-AD-Q4_K_M/NVIDIA-Nemotron-3.5-Bolt-E4B-Uncensored-AD-Q4_K_M-00001-of-00001.gguf',
  'https://huggingface.co/AtomicChat/NVIDIA-Nemotron-3.5-Bolt-E4B-Uncensored-GGUF/resolve/main/NVIDIA-Nemotron-3.5-Bolt-E4B-Uncensored-AD-Q4_K_M/NVIDIA-Nemotron-3.5-Bolt-E4B-Uncensored-AD-Q4_K_M-00001-of-00001.gguf',
]

export const NEMOTRON_MMPROJ_FILE = 'mmproj-NVIDIA-Nemotron-3.5-Bolt-E4B-F16.gguf'
export const NEMOTRON_MMPROJ_CANDIDATES = [
  'mmproj-NVIDIA-Nemotron-3.5-Bolt-E4B-F16.gguf',
  'mmproj-NVIDIA-Nemotron-3.5-Bolt-E4B-f16.gguf',
  'mmproj-NVIDIA-Nemotron-3.5-Bolt-E4B-bf16.gguf',
  'mmproj-NVIDIA-Nemotron-3.5-Bolt-E4B-BF16.gguf',
]
export const NEMOTRON_MMPROJ_MIN_BYTES = 800_000_000
export const NEMOTRON_MMPROJ_URLS: string[] = [
  'https://hf-mirror.com/AtomicChat/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF/resolve/main/mmproj-NVIDIA-Nemotron-3.5-Bolt-E4B-F16.gguf',
  'https://huggingface.co/AtomicChat/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF/resolve/main/mmproj-NVIDIA-Nemotron-3.5-Bolt-E4B-F16.gguf',
  'https://hf-mirror.com/bartowski/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF/resolve/main/mmproj-NVIDIA-Nemotron-3.5-Bolt-E4B-f16.gguf',
]

export const NEMOTRON_TUNING_SUMMARY =
  'llama · -ngl 99 --flash-attn on --jinja -c 16384 f16KV -b 1024 -ub 512 -t 6 --no-mmproj-offload --temp 1.05 --top-p 0.95'

export interface LlamaServerRef {
  exe: string
  dir: string
  variant: string
}

/** 固定根目录 `<project_root>/local_ai`（开发期在 PC/local_ai，打包后在 resources/local_ai；可用 DHVW_LOCAL_AI 覆盖） */
export function primaryLocalAiRoot(): string {
  const override = process.env.DHVW_LOCAL_AI?.trim()
  if (override) return path.resolve(override)
  return path.join(resourcesRoot(), 'local_ai')
}

export function localAiRoots(overrideDir?: string): string[] {
  const candidates = [
    overrideDir?.trim() ?? '',
    process.env.DHVW_LOCAL_AI?.trim() ?? '',
    path.join(resourcesRoot(), 'local_ai'),
    path.join(dataDir, 'local_ai'),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    if (!c) continue
    const norm = path.resolve(c)
    if (seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

/** 解析固定目录下的 `llama-server.exe`：优先 `local_ai/llama/`，兼容 `llama-prism` / `llama-new` / `llama.cpp` 子目录 */
export function resolveLlamaServer(overrideDir?: string): LlamaServerRef | null {
  const subdirs: Array<[string, string]> = [
    ['llama', 'local_ai/llama'],
    ['llama-prism', 'local_ai/llama-prism'],
    ['llama-new', 'local_ai/llama-new'],
    ['llama.cpp', 'local_ai/llama.cpp'],
    ['', 'local_ai'],
  ]
  for (const root of localAiRoots(overrideDir)) {
    for (const [sub, variant] of subdirs) {
      const exe = sub ? path.join(root, sub, 'llama-server.exe') : path.join(root, 'llama-server.exe')
      if (fs.existsSync(exe)) {
        return { exe, dir: path.dirname(exe), variant }
      }
    }
  }
  return null
}

/** 查找本地 GGUF 模型目录列表（固定以项目根 `local_ai/models` 为主）。 */
export function localModelsSearchDirs(overrideDir?: string): string[] {
  const dirs: string[] = []
  for (const root of localAiRoots(overrideDir)) {
    dirs.push(path.join(root, 'models'))
  }
  dirs.push(path.join(componentsRoot(), 'local-llm', 'models'))
  dirs.push(path.join(dataDir, 'components', 'local-llm', 'models'))
  return [...new Set(dirs.map((d) => path.resolve(d)))]
}

/** 默认本地模型存放目录：`<root>/local_ai/models`。 */
export function preferredModelsDir(overrideDir?: string): string {
  if (overrideDir?.trim()) return path.join(path.resolve(overrideDir), 'models')
  return path.join(primaryLocalAiRoot(), 'models')
}

/** 默认本地 llama 引擎存放目录：`<root>/local_ai/llama`。 */
export function preferredLlamaDir(overrideDir?: string): string {
  if (overrideDir?.trim()) return path.join(path.resolve(overrideDir), 'llama')
  return path.join(primaryLocalAiRoot(), 'llama')
}

/** 定位本地 `NVIDIA-Nemotron-3.5-Bolt-E4B-Uncensored-AD-Q4_K_M-00001-of-00001.gguf`。 */
export function resolveNemotronModel(overrideDir?: string): { path: string; dir: string; bytes: number } | null {
  for (const dir of localModelsSearchDirs(overrideDir)) {
    const file = path.join(dir, NEMOTRON_FILE)
    try {
      const st = fs.statSync(file)
      if (st.isFile() && st.size >= NEMOTRON_MIN_BYTES) {
        return { path: file, dir, bytes: st.size }
      }
    } catch {
      /* ignore missing */
    }
  }
  return null
}

/** 定位本地 `NVIDIA-Nemotron-3.5-Bolt-E4B` 视觉投影头（严格按专用文件名匹配，避免误挂其他模型的 mmproj）。 */
export function resolveNemotronMmproj(overrideDir?: string): { path: string; dir: string; bytes: number } | null {
  for (const dir of localModelsSearchDirs(overrideDir)) {
    for (const name of NEMOTRON_MMPROJ_CANDIDATES) {
      const file = path.join(dir, name)
      try {
        const st = fs.statSync(file)
        if (st.isFile() && st.size >= NEMOTRON_MMPROJ_MIN_BYTES) {
          return { path: file, dir, bytes: st.size }
        }
      } catch {
        /* ignore missing */
      }
    }
  }
  return null
}

/**
 * 构建经 RTX 5070 + Gemma4 E4B 实测调优的 `llama-server` 启动参数：
 * - `--flash-attn on` + `16K f16` KV cache + `-b 1024`：避免 q8_0 KV 预填充退化，同时比 32K/-b 2048 节省约 500 MiB 显存
 * - 若存在配套 `mmproj`，附加 `--mmproj <路径> --no-mmproj-offload`：视觉编码器放内存按需推理，节省 ~990 MiB 常驻显存
 * - `--jinja` + `--temp 1.05 --top-p 0.95 --top-k 64`：在官方推荐采样分布基础上略微提高温度，保留思考链与输出欲望
 * - 不锁定 `--reasoning-budget 0` 与 `reasoning_effort=none`：保留完整思考以提升对话与工具调用质量
 */
export function buildNemotronLlamaArgs(modelPath: string, mmprojPath?: string | null): string[] {
  const args = [
    '-m',
    modelPath,
    ...(mmprojPath ? ['--mmproj', mmprojPath, '--no-mmproj-offload'] : []),
    '--alias',
    NEMOTRON_MODEL_ID,
    '-ngl',
    '99',
    '--flash-attn',
    'on',
    '--jinja',
    '-c',
    '16384',
    '--cache-type-k',
    'f16',
    '--cache-type-v',
    'f16',
    '-b',
    '1024',
    '-ub',
    '512',
    '-t',
    '6',
    '-np',
    '1',
    '--temp',
    '1.05',
    '--top-p',
    '0.95',
    '--top-k',
    '64',
    '--host',
    '127.0.0.1',
    '--port',
    '{port}',
  ]
  return args
}

export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl)
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
  } catch {
    return false
  }
}
