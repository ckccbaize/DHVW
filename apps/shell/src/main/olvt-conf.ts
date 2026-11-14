import fs from 'node:fs'
import path from 'node:path'

/**
 * OLVT 的 conf.yaml 由外壳生成，用户永远不用手改后端配置文件。
 * 结构取自 OLVT v1.2.1 的 pydantic 模型（config_manager/*.py 中标了 ... 的必填字段）。
 * 字符串一律走 JSON.stringify：JSON 的字符串字面量是合法 YAML 双引号标量。
 */

export interface OlvtConfInput {
  port: number
  /** Live2D 模型 id（模型库目录名），PC 舞台与 OLVT 共用 */
  live2dModel: string
  characterName: string
  humanName: string
  personaPrompt: string
  llm: { baseUrl: string; model: string; temperature: number; apiKey: string; protocol: 'openai-compatible' | 'anthropic' }
  tts: { apiUrl: string; refAudioPath: string; refText: string; refLang: string; textLang: string }
  asr: { enabled: boolean; modelPath: string; tokensPath: string }
}

const q = (v: string): string => JSON.stringify(v)
const block = (v: string, indent: string): string =>
  v
    .split(/\r?\n/)
    .map((line) => (line ? `${indent}${line}` : ''))
    .join('\n')

export function renderOlvtConf(input: OlvtConfInput): string {
  // OpenAI 兼容客户端会自己在 base_url 后补 /chat/completions，所以 base_url 要落在 /v1 上；
  // Anthropic 客户端补 /v1/messages，根地址即可。
  const base =
    input.llm.protocol === 'anthropic'
      ? input.llm.baseUrl.replace(/\/+$/, '')
      : /\/v1$/.test(input.llm.baseUrl.replace(/\/+$/, ''))
        ? input.llm.baseUrl.replace(/\/+$/, '')
        : `${input.llm.baseUrl.replace(/\/+$/, '')}/v1`
  const provider = input.llm.protocol === 'anthropic' ? 'claude_llm' : 'openai_compatible_llm'
  const llmBlock =
    input.llm.protocol === 'anthropic'
      ? `      claude_llm:
        base_url: ${q(base)}
        llm_api_key: ${q(input.llm.apiKey)}
        model: ${q(input.llm.model)}
        interrupt_method: 'user'`
      : `      openai_compatible_llm:
        base_url: ${q(base)}
        llm_api_key: ${q(input.llm.apiKey)}
        organization_id: null
        project_id: null
        model: ${q(input.llm.model)}
        temperature: ${input.llm.temperature}
        interrupt_method: 'user'`
  const asrReady = input.asr.enabled && Boolean(input.asr.modelPath) && Boolean(input.asr.tokensPath)
  // pydantic 校验：sherpa 必须带真实模型路径；模型没下载时退到不落盘的远端占位实现，
  // 保证后端仍能启动（此时麦克风不可用，界面上会给出提示）。
  const asrBlock = asrReady
    ? `
    sherpa_onnx_asr:
      model_type: 'sense_voice'
      sense_voice: ${q(input.asr.modelPath)}
      tokens: ${q(input.asr.tokensPath)}
      num_threads: 4
      use_itn: true
      provider: 'cpu'`
    : `    # ASR 模型未就绪（未启用或未下载 SenseVoice），后端以占位 ASR 启动
    groq_whisper_asr:
      api_key: ''
      model: 'whisper-large-v3-turbo'
      lang: ''`

  return `# 由 DHVW 主机端生成，请勿手改（每次启动覆盖）。
system_config:
  conf_version: 'v1.2.1'
  host: '127.0.0.1'
  port: ${input.port}
  config_alts_dir: 'characters'
  tool_prompts:
    live2d_expression_prompt: 'live2d_expression_prompt'

character_config:
  conf_name: 'dhvw'
  conf_uid: 'dhvw_001'
  live2d_model_name: ${q(input.live2dModel)}
  character_name: ${q(input.characterName)}
  human_name: ${q(input.humanName)}
  avatar: ''
  persona_prompt: |
${block(input.personaPrompt, '    ')}

  agent_config:
    conversation_agent_choice: 'basic_memory_agent'
    agent_settings:
      basic_memory_agent:
        llm_provider: '${provider}'
        faster_first_response: true
        segment_method: 'regex'
        use_mcpp: false
        mcp_enabled_servers: []
    llm_configs:
${llmBlock}

  asr_config:
    asr_model: ${asrReady ? "'sherpa_onnx_asr'" : "'groq_whisper_asr'"}
${asrBlock}

  tts_config:
    tts_model: 'gpt_sovits_tts'
    gpt_sovits_tts:
      api_url: ${q(input.tts.apiUrl)}
      text_lang: ${q(input.tts.textLang)}
      ref_audio_path: ${q(input.tts.refAudioPath)}
      prompt_lang: ${q(input.tts.refLang)}
      prompt_text: ${q(input.tts.refText)}
      text_split_method: 'cut5'
      batch_size: '1'
      media_type: 'wav'
      streaming_mode: 'false'

  # silero_vad 依赖 torch（约 2.5 GB），运行环境不含 torch，语音分段交给客户端
  vad_config:
    vad_model: null

  tts_preprocessor_config:
    remove_special_char: true
    ignore_brackets: true
    ignore_parentheses: true
    ignore_asterisks: true
    ignore_angle_brackets: true
    translator_config:
      translate_audio: false
      translate_provider: 'deeplx'
`
}

export function writeOlvtConf(dir: string, content: string): string {
  const file = path.join(dir, 'conf.yaml')
  fs.writeFileSync(file, content, 'utf8')
  return file
}
