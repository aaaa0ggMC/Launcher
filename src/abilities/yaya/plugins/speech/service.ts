/**
 * speech 插件的主进程实现：各服务商的语音接口。
 *
 * | 引擎    | TTS                                             | ASR                                         |
 * |---------|-------------------------------------------------|---------------------------------------------|
 * | openai  | `POST {base}/audio/speech`（OpenAI / SiliconFlow / Groq / Kokoro …） | `POST {base}/audio/transcriptions`（Whisper 系） |
 * | mimo    | `POST {base}/chat/completions` + `audio`（SSE，PCM16 24kHz） | `chat/completions` + `input_audio`（WAV data URL） |
 * | gemini  | `models/{model}:generateContent`，responseModalities AUDIO（PCM16 24kHz） | `generateContent` + inlineData 音频 + 转写提示词 |
 * | system  | 不经过主进程：渲染端 `@ui/speech`（系统 TTS / 识别）                                          ||
 *
 * MiMo / Gemini 的格式参照 Rikkahub 的实现（speech/…/MiMoTTSProvider.kt 等）。
 * 网络走 Electron `net.fetch`（跟随系统代理），不在 Electron 里（无头 / 测试）用全局 fetch。
 */
import { randomBytes } from 'node:crypto'
import { t, te } from '../../../../main/process/i18n'
import { PROVIDER_DEFAULTS, engineOf, type SpeechEngine } from './engines'

export { PROVIDER_DEFAULTS, engineOf, asrWantsWav } from './engines'
export type { ApiEngine, SpeechEngine } from './engines'

type FetchLike = (url: string, init: RequestInit) => Promise<Response>
let fetchForTest: FetchLike | null = null

/** 测试注入假 fetch；null 恢复 */
export function __setSpeechFetchForTest(impl: FetchLike | null): void {
  fetchForTest = impl
}

async function httpFetch(url: string, init: RequestInit): Promise<Response> {
  if (fetchForTest) return fetchForTest(url, init)
  try {
    const { net } = await import('electron')
    if (net?.fetch) return await net.fetch(url, init)
  } catch {
    /* 不在 Electron 里 */
  }
  return fetch(url, init)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim()
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`
}

async function httpError(res: Response, what: string): Promise<Error> {
  const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300)
  return new Error(`${what}: HTTP ${res.status}${body ? ` — ${body}` : ''}`)
}

export const AUDIO_EXT: Record<string, string> = {
  mp3: 'mp3',
  wav: 'wav',
  opus: 'opus',
  aac: 'aac',
  flac: 'flac'
}

/** PCM16 小端 → WAV（MiMo / Gemini 返回裸 PCM） */
export function pcm16ToWav(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** `audio/L16;codec=pcm;rate=24000` → 24000 */
export function rateOfMime(mime: string, fallback = 24000): number {
  const m = /rate=(\d+)/i.exec(mime)
  return m ? Number(m[1]) : fallback
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface TtsSettings {
  engine: SpeechEngine
  baseUrl: string
  apiKey: string
  model: string
  voice: string
  format: string
  instructions: string
}

export function ttsSettings(values: Record<string, unknown>): TtsSettings {
  const engine = engineOf(values.tts_engine)
  const d = engine === 'system' ? null : PROVIDER_DEFAULTS[engine]
  const format = str(values.tts_format) || 'mp3'
  return {
    engine,
    baseUrl: str(values.tts_base_url) || d?.baseUrl || '',
    apiKey: str(values.tts_api_key),
    model: str(values.tts_model) || d?.ttsModel || '',
    voice: str(values.tts_voice) || d?.voice || '',
    format: AUDIO_EXT[format] ? format : 'mp3',
    instructions: str(values.tts_instructions)
  }
}

/** 配置缺什么（空数组 = 可用）；system 引擎不经过主进程，永远可用 */
export function ttsMissing(s: TtsSettings): string[] {
  if (s.engine === 'system') return []
  const out: string[] = []
  if (!s.baseUrl) out.push(t('yaya.speech.field.base_url', '接口地址'))
  if (!s.model) out.push(t('yaya.speech.field.model', '模型'))
  if (!s.voice) out.push(t('yaya.speech.field.voice', '音色'))
  // MiMo / Gemini 没有免密钥的自托管版本
  if (s.engine !== 'openai' && !s.apiKey) out.push('API Key')
  return out
}

export interface SynthResult {
  data: Buffer
  /** 文件扩展名 */
  ext: string
}

/** 合成一段文字 → 音频 */
export async function synthesize(
  s: TtsSettings,
  input: string,
  signal?: AbortSignal
): Promise<SynthResult> {
  let out: SynthResult
  if (s.engine === 'mimo') out = await synthMimo(s, input, signal)
  else if (s.engine === 'gemini') out = await synthGemini(s, input, signal)
  else out = await synthOpenAi(s, input, signal)
  if (!out.data.length) throw new Error(t('yaya.speech.err_empty_audio', 'TTS 接口返回了空音频'))
  return out
}

async function synthOpenAi(
  s: TtsSettings,
  input: string,
  signal?: AbortSignal
): Promise<SynthResult> {
  const body: Record<string, unknown> = {
    model: s.model,
    input,
    voice: s.voice,
    response_format: s.format
  }
  if (s.instructions) body.instructions = s.instructions
  const res = await httpFetch(endpoint(s.baseUrl, '/audio/speech'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) throw await httpError(res, 'TTS')
  return { data: Buffer.from(await res.arrayBuffer()), ext: AUDIO_EXT[s.format] ?? 'mp3' }
}

/** MiMo 的流式音频：24kHz PCM16 */
const MIMO_RATE = 24000

/**
 * MiMo：OpenAI 兼容的 chat/completions + `audio`，SSE 里每个 delta.audio.data 是一段 base64 PCM。
 * 风格（语气说明）按 MiMo 的写法放在正文开头的括号里，如「(开心 磁性)」。
 */
async function synthMimo(
  s: TtsSettings,
  input: string,
  signal?: AbortSignal
): Promise<SynthResult> {
  const style = s.instructions.replace(/[()（）[\]]/g, ' ').trim()
  const text = style ? `(${style})${input}` : input
  const res = await httpFetch(endpoint(s.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': s.apiKey },
    body: JSON.stringify({
      model: s.model,
      messages: [{ role: 'assistant', content: text }],
      audio: { format: 'pcm16', voice: s.voice },
      stream: true
    }),
    signal
  })
  if (!res.ok) throw await httpError(res, 'MiMo TTS')
  return { data: pcm16ToWav(parseMimoSse(await res.text()), MIMO_RATE), ext: 'wav' }
}

/** MiMo SSE 文本 → 拼好的 PCM（`data: [DONE]` 与没有音频的增量忽略） */
export function parseMimoSse(raw: string): Buffer {
  const parts: Buffer[] = []
  for (const line of raw.split(/\r?\n/)) {
    const m = /^data:\s*(.*)$/.exec(line)
    if (!m || !m[1] || m[1].trim() === '[DONE]') continue
    let chunk: { choices?: { delta?: { audio?: { data?: string } } }[] }
    try {
      chunk = JSON.parse(m[1])
    } catch {
      continue
    }
    const data = chunk.choices?.[0]?.delta?.audio?.data
    if (data) parts.push(Buffer.from(data, 'base64'))
  }
  return Buffer.concat(parts)
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; inlineData?: { data?: string; mimeType?: string } }[] }
  }[]
}

/** Gemini：generateContent 要音频输出；语气说明按 Gemini 的写法放在正文前（「Say cheerfully: …」） */
async function synthGemini(
  s: TtsSettings,
  input: string,
  signal?: AbortSignal
): Promise<SynthResult> {
  const text = s.instructions ? `${s.instructions}: ${input}` : input
  const res = await httpFetch(
    endpoint(s.baseUrl, `/models/${encodeURIComponent(s.model)}:generateContent`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } } }
        }
      }),
      signal
    }
  )
  if (!res.ok) throw await httpError(res, 'Gemini TTS')
  const json = (await res.json()) as GeminiResponse
  const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData
  if (!inline?.data) throw new Error(t('yaya.speech.err_empty_audio', 'TTS 接口返回了空音频'))
  const pcm = Buffer.from(inline.data, 'base64')
  const mime = inline.mimeType ?? ''
  // 一般是 audio/L16（裸 PCM）；万一给的是完整的音频文件就原样存
  if (/wav/i.test(mime)) return { data: pcm, ext: 'wav' }
  if (/mpeg|mp3/i.test(mime)) return { data: pcm, ext: 'mp3' }
  return { data: pcm16ToWav(pcm, rateOfMime(mime)), ext: 'wav' }
}

// ---------------------------------------------------------------------------
// ASR
// ---------------------------------------------------------------------------

export interface AsrSettings {
  engine: SpeechEngine
  baseUrl: string
  apiKey: string
  model: string
  language: string
  prompt: string
}

export function asrSettings(values: Record<string, unknown>): AsrSettings {
  const engine = engineOf(values.asr_engine)
  const d = engine === 'system' ? null : PROVIDER_DEFAULTS[engine]
  return {
    engine,
    baseUrl: str(values.asr_base_url) || d?.baseUrl || '',
    apiKey: str(values.asr_api_key),
    model: str(values.asr_model) || d?.asrModel || '',
    language: str(values.asr_language),
    prompt: str(values.asr_prompt)
  }
}

export function asrMissing(s: AsrSettings): string[] {
  if (s.engine === 'system') return []
  const out: string[] = []
  if (!s.baseUrl) out.push(t('yaya.speech.field.base_url', '接口地址'))
  if (!s.model) out.push(t('yaya.speech.field.model', '模型'))
  if (s.engine !== 'openai' && !s.apiKey) out.push('API Key')
  return out
}

/** 录音的扩展名（Whisper 系接口按文件名后缀判断格式） */
export function audioExtOf(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a'
  if (m.includes('wav')) return 'wav'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  return 'webm'
}

/** 手拼 multipart/form-data */
export function multipart(
  fields: Record<string, string>,
  file: { name: string; mime: string; data: Buffer }
): { body: Buffer; contentType: string } {
  const boundary = `----cockpit${randomBytes(12).toString('hex')}`
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (!v) continue
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
    )
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
        `Content-Type: ${file.mime}\r\n\r\n`
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  )
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

/** 录音 → 文字 */
export async function transcribe(
  s: AsrSettings,
  audio: Buffer,
  mime: string,
  signal?: AbortSignal
): Promise<string> {
  if (s.engine === 'mimo') return transcribeMimo(s, audio, mime, signal)
  if (s.engine === 'gemini') return transcribeGemini(s, audio, mime, signal)
  return transcribeOpenAi(s, audio, mime, signal)
}

function badAsr(raw: string): Error {
  return new Error(
    te('yaya.speech.err_bad_asr', { body: raw.slice(0, 200) }, 'ASR 返回格式不对：{body}')
  )
}

async function transcribeOpenAi(
  s: AsrSettings,
  audio: Buffer,
  mime: string,
  signal?: AbortSignal
): Promise<string> {
  const ext = audioExtOf(mime)
  const { body, contentType } = multipart(
    { model: s.model, language: s.language, prompt: s.prompt, response_format: 'json' },
    { name: `speech.${ext}`, mime: mime || 'audio/webm', data: audio }
  )
  const res = await httpFetch(endpoint(s.baseUrl, '/audio/transcriptions'), {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {})
    },
    body: new Uint8Array(body),
    signal
  })
  if (!res.ok) throw await httpError(res, 'ASR')
  const raw = await res.text()
  try {
    const json = JSON.parse(raw) as { text?: unknown }
    if (typeof json.text === 'string') return json.text.trim()
  } catch {
    // 有的服务（response_format 被忽略）直接回纯文本
    if (raw.trim()) return raw.trim()
  }
  throw badAsr(raw)
}

/** MiMo：chat/completions，音频以 data URL 放在 input_audio 里，结果在 message.content */
async function transcribeMimo(
  s: AsrSettings,
  audio: Buffer,
  mime: string,
  signal?: AbortSignal
): Promise<string> {
  const body: Record<string, unknown> = {
    model: s.model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: { data: `data:${mime || 'audio/wav'};base64,${audio.toString('base64')}` }
          }
        ]
      }
    ]
  }
  if (s.language && s.language !== 'auto') body.asr_options = { language: s.language }
  const res = await httpFetch(endpoint(s.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': s.apiKey },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) throw await httpError(res, 'MiMo ASR')
  const raw = await res.text()
  try {
    const json = JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] }
    const content = json.choices?.[0]?.message?.content
    if (typeof content === 'string') return content.trim()
  } catch {
    /* 落到下面报格式错误 */
  }
  throw badAsr(raw)
}

/** 给 Gemini 的转写提示词（固定英文；语言 / 用户提示词附在后面） */
export function geminiAsrPrompt(language: string, prompt: string): string {
  return [
    'Transcribe the speech in this audio verbatim.',
    'Output only the transcript text: no timestamps, speaker labels, quotes or commentary.',
    'If there is no intelligible speech, output nothing.',
    language && language !== 'auto' ? `The speech is in language "${language}".` : '',
    prompt ? `Notes: ${prompt}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

async function transcribeGemini(
  s: AsrSettings,
  audio: Buffer,
  mime: string,
  signal?: AbortSignal
): Promise<string> {
  const res = await httpFetch(
    endpoint(s.baseUrl, `/models/${encodeURIComponent(s.model)}:generateContent`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: geminiAsrPrompt(s.language, s.prompt) },
              { inlineData: { mimeType: mime || 'audio/wav', data: audio.toString('base64') } }
            ]
          }
        ],
        generationConfig: { temperature: 0 }
      }),
      signal
    }
  )
  if (!res.ok) throw await httpError(res, 'Gemini ASR')
  const raw = await res.text()
  try {
    const json = JSON.parse(raw) as GeminiResponse
    const parts = json.candidates?.[0]?.content?.parts
    if (Array.isArray(parts))
      return parts
        .map((p) => p.text ?? '')
        .join('')
        .trim()
  } catch {
    /* 落到下面报格式错误 */
  }
  throw badAsr(raw)
}
