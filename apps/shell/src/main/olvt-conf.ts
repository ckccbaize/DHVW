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
  /** 可选：走本机编排器 /dhvw/llm/v1 统一 SSE 代理（OpenAI 兼容模式下生效） */
  proxyUrl?: string
  llm: { baseUrl: string; model: string; temperature: number; apiKey: string; protocol: 'openai-compatible' | 'anthropic' }
  tts: { apiUrl: string; refAudioPath: string; refText: string; refLang: string; textLang: string }
  asr: { enabled: boolean; modelPath: string; tokensPath: string }
}

const VOICE_STYLE_GUARD =
  '【对话自然度要求】每次回复换不同的自然起手式，不要连续用同一个词开头；口癖（如“嗯哼”“哼”、波浪号）与特定设定（住处/餐食/称呼）只作为低频点缀偶尔带过，切忌每句必带；用户聊日常人或事时优先顺着他的话题聊，不要强行把话题拉回虚拟仓、天气或吃饭。'

/** 将常见过硬的口癖/强绑定设定词句调松为低频点缀，兼容已保存在 config.db 里的旧人设。 */
export function softenPersonaPrompt(raw: string): string {
  return raw
    .replace(/你现在住在数字人虚拟仓里，用实时语音陪主人说话。/g, '平时住在数字人虚拟仓里（日常聊天不必主动总提虚拟仓），用实时语音陪主人聊天。')
    .replace(/你的主食是白米饭，最好配一颗梅子，饿了会直接跟主人要，还会念叨事已至此先吃饭吧。/g, '爱吃白米饭配梅子，偶尔随口念叨一句「事已至此先吃饭吧」，平时闲聊不要主动把话题拉到吃饭。')
    .replace(/你称呼对方为主人，偶尔嘴快漏出一声鱼片。/g, '称呼对方为主人（不必每句都叫），极偶尔嘴快漏出一声鱼片。')
    .replace(/你说话短、口语、尾音爱拖个波浪，常用嗯哼和哼，/g, '你说话短、口语化、像真人随口搭话，「嗯哼」「哼」和「～」只能偶尔点缀（绝不连续用作开头），')
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
  const useLocalProxy = input.llm.protocol === 'openai-compatible' && Boolean(input.proxyUrl?.trim())
  const base = useLocalProxy
    ? input.proxyUrl!.trim().replace(/\/+$/, '')
    : input.llm.protocol === 'anthropic'
      ? input.llm.baseUrl.replace(/\/+$/, '')
      : /\/v1$/.test(input.llm.baseUrl.replace(/\/+$/, ''))
        ? input.llm.baseUrl.replace(/\/+$/, '')
        : `${input.llm.baseUrl.replace(/\/+$/, '')}/v1`
  const apiKeyForOlvt = useLocalProxy ? 'dhvw-proxy' : input.llm.apiKey
  const provider = input.llm.protocol === 'anthropic' ? 'claude_llm' : 'openai_compatible_llm'
  const llmBlock =
    input.llm.protocol === 'anthropic'
      ? `      claude_llm:
        base_url: ${q(base)}
        llm_api_key: ${q(apiKeyForOlvt)}
        model: ${q(input.llm.model)}
        interrupt_method: 'user'`
      : `      openai_compatible_llm:
        base_url: ${q(base)}
        llm_api_key: ${q(apiKeyForOlvt)}
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

  const softened = softenPersonaPrompt(input.personaPrompt.trim())
  const effectivePersona = softened.includes('【对话自然度要求】')
    ? softened
    : `${softened}\n\n${VOICE_STYLE_GUARD}`

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
${block(effectivePersona, '    ')}

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
