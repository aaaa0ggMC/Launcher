/**
 * speech 插件的引擎定义（主进程 / 渲染端共用，不依赖任何运行时模块）。
 */

export type SpeechEngine = 'system' | 'openai' | 'mimo' | 'gemini'
export type ApiEngine = Exclude<SpeechEngine, 'system'>

/** 配置里的引擎值 → 引擎（旧值 browser / api 兼容） */
export function engineOf(v: unknown, fallback: SpeechEngine = 'system'): SpeechEngine {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s === 'browser') return 'system'
  if (s === 'api') return 'openai'
  return s === 'system' || s === 'openai' || s === 'mimo' || s === 'gemini' ? s : fallback
}

/** 字段留空时用的服务商默认值 */
export const PROVIDER_DEFAULTS: Record<
  ApiEngine,
  { baseUrl: string; ttsModel: string; voice: string; asrModel: string }
> = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    ttsModel: 'gpt-4o-mini-tts',
    voice: 'alloy',
    asrModel: 'whisper-1'
  },
  mimo: {
    baseUrl: 'https://api.xiaomimimo.com/v1',
    ttsModel: 'mimo-v2.5-tts',
    voice: 'mimo_default',
    asrModel: 'mimo-v2.5-asr'
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    ttsModel: 'gemini-2.5-flash-preview-tts',
    voice: 'Kore',
    asrModel: 'gemini-2.5-flash'
  }
}

/** 这个引擎要不要渲染端先把录音转成 WAV（MiMo / Gemini 不认浏览器录的 webm） */
export function asrWantsWav(engine: SpeechEngine): boolean {
  return engine === 'mimo' || engine === 'gemini'
}
