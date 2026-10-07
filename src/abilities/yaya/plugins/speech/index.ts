/**
 * 内置 speech 插件（语音服务）：ASR 语音输入 + TTS 朗读回答。
 *
 * 没有给模型的工具，也没有 instructions（不进提示词，缓存不受影响）；只往界面注入：
 * - 输入框「+」面板里的「语音输入」（`ui.ts` 的 inputExtension → SpeechInput.vue）：
 *   浏览器录音 → `yaya.speech-transcribe` → OpenAI 兼容 `/audio/transcriptions` → 文字插到光标处；
 * - 每条回答操作栏里的「朗读」（`ui.ts` 的 messageActions → player.ts）：
 *   引擎 = 系统语音（浏览器 speechSynthesis，零配置）或 OpenAI 兼容 `/audio/speech`。
 *   接口合成在后台任务里跑（`yaya.speech-speak`，切页面不中断，面板里能停），
 *   播放在悬浮播放器里（Outsider `yaya.tts-player`；悬浮窗被禁用时在 YAYA 页面里显示）。
 *
 * 两个子分组 tts / asr 只用来组织设置表单与显示「配好了没有」。
 */
import { t } from '../../../../main/process/i18n'
import { loadYayaConfig } from '../../services/config'
import type { PluginConfigField, PluginStatus, YayaPlugin } from '../../services/plugins/types'
import { asrMissing, asrSettings, ttsMissing, ttsSettings } from './service'

export const SPEECH_PLUGIN_ID = 'speech'

/** 引擎选项（TTS / ASR 共用）；旧配置里的 browser / api 由 engineOf 兼容 */
const ENGINE_OPTIONS = [
  { value: 'system', label: '系统语音', labelKey: 'yaya.speech.engine.system' },
  { value: 'openai', label: 'OpenAI 兼容接口', labelKey: 'yaya.speech.engine.openai' },
  { value: 'mimo', label: '小米 MiMo', labelKey: 'yaya.speech.engine.mimo' },
  { value: 'gemini', label: 'Google Gemini', labelKey: 'yaya.speech.engine.gemini' }
]

const CONFIG: PluginConfigField[] = [
  // ---- 朗读（TTS） ----
  {
    key: 'tts_engine',
    type: 'select',
    group: 'tts',
    label: '朗读引擎',
    labelKey: 'yaya.speech.cfg.tts_engine',
    description:
      '系统语音不用配置（安卓 App 用系统 TTS，电脑用浏览器 / 系统语音）；其余引擎要填下面的密钥，地址 / 模型 / 音色留空用服务商默认',
    descriptionKey: 'yaya.speech.cfg.tts_engine_desc',
    default: 'system',
    options: ENGINE_OPTIONS
  },
  {
    key: 'tts_speed',
    type: 'number',
    group: 'tts',
    label: '默认语速',
    labelKey: 'yaya.speech.cfg.tts_speed',
    description: '播放倍速，播放器里可以随时调',
    descriptionKey: 'yaya.speech.cfg.tts_speed_desc',
    default: 1,
    min: 0.5,
    max: 2.5,
    step: 0.1
  },
  {
    key: 'tts_browser_voice',
    type: 'string',
    group: 'tts',
    label: '系统语音名称',
    labelKey: 'yaya.speech.cfg.tts_browser_voice',
    description: '留空 = 按界面语言自动选；填语音名称的一部分即可（如 Xiaoxiao）',
    descriptionKey: 'yaya.speech.cfg.tts_browser_voice_desc',
    default: ''
  },
  {
    key: 'tts_base_url',
    type: 'string',
    group: 'tts',
    label: '接口地址',
    labelKey: 'yaya.speech.cfg.base_url',
    description:
      '留空 = 服务商默认：OpenAI api.openai.com/v1 · MiMo api.xiaomimimo.com/v1 · Gemini generativelanguage.googleapis.com/v1beta',
    descriptionKey: 'yaya.speech.cfg.base_url_desc',
    default: '',
    placeholder: 'https://…'
  },
  {
    key: 'tts_api_key',
    type: 'string',
    group: 'tts',
    secret: true,
    label: 'API Key',
    labelKey: 'yaya.speech.cfg.api_key'
  },
  {
    key: 'tts_model',
    type: 'string',
    group: 'tts',
    label: '模型',
    labelKey: 'yaya.speech.cfg.model',
    description: '留空 = 默认：gpt-4o-mini-tts / mimo-v2.5-tts / gemini-2.5-flash-preview-tts',
    descriptionKey: 'yaya.speech.cfg.tts_model_desc',
    default: '',
    placeholder: 'tts-1 / FunAudioLLM/CosyVoice2-0.5B / …'
  },
  {
    key: 'tts_voice',
    type: 'string',
    group: 'tts',
    label: '音色',
    labelKey: 'yaya.speech.cfg.voice',
    description: '留空 = 默认：alloy / mimo_default / Kore',
    descriptionKey: 'yaya.speech.cfg.voice_desc',
    default: '',
    placeholder: 'nova / Puck / …'
  },
  {
    key: 'tts_format',
    type: 'select',
    group: 'tts',
    label: '音频格式',
    labelKey: 'yaya.speech.cfg.format',
    description: '只对 OpenAI 兼容接口有效；MiMo / Gemini 返回 PCM，存成 WAV',
    descriptionKey: 'yaya.speech.cfg.format_desc',
    default: 'mp3',
    options: ['mp3', 'opus', 'aac', 'flac', 'wav'].map((v) => ({ value: v, label: v }))
  },
  {
    key: 'tts_instructions',
    type: 'text',
    group: 'tts',
    label: '语气说明',
    labelKey: 'yaya.speech.cfg.instructions',
    description:
      'OpenAI（gpt-4o-mini-tts）与 Gemini：用自然语言描述语气、情绪、语速；MiMo：写风格词，如「开心 磁性」',
    descriptionKey: 'yaya.speech.cfg.instructions_desc',
    default: ''
  },
  {
    key: 'tts_chunk',
    type: 'number',
    group: 'tts',
    label: '每段字数上限',
    labelKey: 'yaya.speech.cfg.chunk',
    description: '长回答按句子切段逐段合成；第一段更短，声音更快出来',
    descriptionKey: 'yaya.speech.cfg.chunk_desc',
    default: 400,
    min: 80,
    max: 4000,
    step: 20
  },
  // ---- 语音输入（ASR） ----
  {
    key: 'asr_engine',
    type: 'select',
    group: 'asr',
    label: '识别引擎',
    labelKey: 'yaya.speech.cfg.asr_engine',
    description:
      '系统语音：安卓 App 用系统语音识别，Chrome / Edge 用浏览器在线识别（电脑版 Electron 不支持）；其余引擎要填下面的密钥',
    descriptionKey: 'yaya.speech.cfg.asr_engine_desc',
    default: 'system',
    options: ENGINE_OPTIONS
  },
  {
    key: 'asr_base_url',
    type: 'string',
    group: 'asr',
    label: '接口地址',
    labelKey: 'yaya.speech.cfg.base_url',
    description:
      '留空 = 服务商默认：OpenAI api.openai.com/v1 · MiMo api.xiaomimimo.com/v1 · Gemini generativelanguage.googleapis.com/v1beta',
    descriptionKey: 'yaya.speech.cfg.base_url_desc',
    default: '',
    placeholder: 'https://…'
  },
  {
    key: 'asr_api_key',
    type: 'string',
    group: 'asr',
    secret: true,
    label: 'API Key',
    labelKey: 'yaya.speech.cfg.api_key'
  },
  {
    key: 'asr_model',
    type: 'string',
    group: 'asr',
    label: '模型',
    labelKey: 'yaya.speech.cfg.model',
    description: '留空 = 默认：whisper-1 / mimo-v2.5-asr / gemini-2.5-flash',
    descriptionKey: 'yaya.speech.cfg.asr_model_desc',
    default: '',
    placeholder: 'gpt-4o-mini-transcribe / whisper-large-v3 / …'
  },
  {
    key: 'asr_language',
    type: 'string',
    group: 'asr',
    label: '语言',
    labelKey: 'yaya.speech.cfg.language',
    description:
      '留空 = 自动 / 跟随浏览器。接口引擎填 ISO-639-1 代码（zh / en / ja …）；系统语音可填 zh-CN 这类区域代码',
    descriptionKey: 'yaya.speech.cfg.language_desc',
    default: ''
  },
  {
    key: 'asr_prompt',
    type: 'text',
    group: 'asr',
    label: '提示词',
    labelKey: 'yaya.speech.cfg.prompt',
    description: '专有名词、写法偏好（如「输出简体中文，带标点」），帮助识别更准',
    descriptionKey: 'yaya.speech.cfg.prompt_desc',
    default: ''
  },
  {
    key: 'asr_max_sec',
    type: 'number',
    group: 'asr',
    label: '单次录音最长（秒）',
    labelKey: 'yaya.speech.cfg.max_sec',
    default: 120,
    min: 10,
    max: 600,
    step: 10
  }
]

function stored(): Record<string, unknown> {
  try {
    const raw = loadYayaConfig().pluginConfig?.[SPEECH_PLUGIN_ID]
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 默认值 + 已存值（只用来判断「配好了没有」） */
function values(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of CONFIG) if (f.default !== undefined) out[f.key] = f.default
  return { ...out, ...stored() }
}

function missingStatus(missing: string[]): PluginStatus {
  return missing.length
    ? {
        state: 'idle',
        message: `${t('yaya.speech.status_missing', '还没填')}：${missing.join('、')}`
      }
    : { state: 'ready' }
}

const plugin: YayaPlugin = {
  id: SPEECH_PLUGIN_ID,
  kind: 'builtin',
  label: '语音',
  labelKey: 'yaya.speech.label',
  description: '语音输入（「+」→ 语音输入）与朗读回答（回答下面的朗读按钮），不给模型加工具',
  descriptionKey: 'yaya.speech.desc',
  icon: 'mdi-microphone-outline',
  defaultEnabled: false,
  mentionable: false,
  docs: [
    '### 引擎',
    '| 引擎 | 朗读 | 语音输入 |',
    '|---|---|---|',
    '| 系统语音 | 安卓 App：系统 TTS；电脑：浏览器 / 系统语音 | 安卓 App：系统语音识别；Chrome / Edge：在线识别（Electron 不支持） |',
    '| OpenAI 兼容 | `/audio/speech`（OpenAI、SiliconFlow、Groq、Kokoro…） | `/audio/transcriptions`（Whisper 系） |',
    '| 小米 MiMo | `mimo-v2.5-tts`（风格写在语气说明里，如「开心 磁性」） | `mimo-v2.5-asr` |',
    '| Google Gemini | `gemini-2.5-flash-preview-tts`，音色如 Kore / Puck | 用 Gemini 模型转写（默认 `gemini-2.5-flash`） |',
    '',
    '地址 / 模型 / 音色留空 = 该服务商的默认值。',
    '',
    '### 语音输入（ASR）',
    '输入框「+」→「语音输入」开始录音，再点一次（或录音条上的 ✓）结束，识别结果插到光标处。',
    '网页版需要安全上下文（https 或 localhost）才能使用麦克风。',
    '',
    '### 朗读（TTS）',
    '回答下面的 🔊 按钮朗读这一条；播放器悬浮在页面上，可以暂停、调速、跳段、停止。',
    '接口引擎在后台任务里逐段合成（切换页面不中断，后台任务面板里可停止）。',
    '',
    '### 给其他能力用',
    '系统语音是框架层 SDK `@ui/speech`（`speak` / `recognize`），任何能力或插件都能直接调用。'
  ].join('\n'),
  tools: () => [],
  configSchema: CONFIG,
  groups: () => [
    {
      id: 'tts',
      label: '朗读（TTS）',
      labelKey: 'yaya.speech.group.tts',
      description: '回答下面的朗读按钮',
      descriptionKey: 'yaya.speech.group.tts_desc',
      status: () => {
        const v = values()
        return missingStatus(ttsMissing(ttsSettings(v)))
      }
    },
    {
      id: 'asr',
      label: '语音输入（ASR）',
      labelKey: 'yaya.speech.group.asr',
      description: '输入框「+」里的语音输入',
      descriptionKey: 'yaya.speech.group.asr_desc',
      status: () => missingStatus(asrMissing(asrSettings(values())))
    }
  ]
}

export default plugin
