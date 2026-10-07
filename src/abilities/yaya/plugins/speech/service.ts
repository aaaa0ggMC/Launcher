/**
 * speech 插件的主进程实现：OpenAI 兼容的语音接口。
 * - TTS：`POST {base}/audio/speech`（OpenAI / SiliconFlow / Groq / Kokoro-FastAPI / openedai-speech …）
 * - ASR：`POST {base}/audio/transcriptions`（Whisper 系：OpenAI / Groq / SiliconFlow / whisper.cpp server …）
 *
 * 网络走 Electron `net.fetch`（跟随系统代理），不在 Electron 里（无头 / 测试）用全局 fetch。
 * multipart 自己拼成 Buffer，不依赖 net.fetch 对 FormData 的支持。
 */
import { randomBytes } from 'node:crypto'
import { t, te } from '../../../../main/process/i18n'

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

export interface TtsSettings {
  baseUrl: string
  apiKey: string
  model: string
  voice: string
  format: string
  instructions: string
}

export function ttsSettings(values: Record<string, unknown>): TtsSettings {
  const format = str(values.tts_format) || 'mp3'
  return {
    baseUrl: str(values.tts_base_url),
    apiKey: str(values.tts_api_key),
    model: str(values.tts_model),
    voice: str(values.tts_voice),
    format: AUDIO_EXT[format] ? format : 'mp3',
    instructions: str(values.tts_instructions)
  }
}

/** 配置缺什么（空数组 = 可用） */
export function ttsMissing(s: TtsSettings): string[] {
  const out: string[] = []
  if (!s.baseUrl) out.push(t('yaya.speech.field.base_url', '接口地址'))
  if (!s.model) out.push(t('yaya.speech.field.model', '模型'))
  if (!s.voice) out.push(t('yaya.speech.field.voice', '音色'))
  return out
}

/** 合成一段文字 → 音频字节 */
export async function synthesize(
  s: TtsSettings,
  input: string,
  signal?: AbortSignal
): Promise<Buffer> {
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
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error(t('yaya.speech.err_empty_audio', 'TTS 接口返回了空音频'))
  return buf
}

export interface AsrSettings {
  baseUrl: string
  apiKey: string
  model: string
  language: string
  prompt: string
}

export function asrSettings(values: Record<string, unknown>): AsrSettings {
  return {
    baseUrl: str(values.asr_base_url),
    apiKey: str(values.asr_api_key),
    model: str(values.asr_model),
    language: str(values.asr_language),
    prompt: str(values.asr_prompt)
  }
}

export function asrMissing(s: AsrSettings): string[] {
  const out: string[] = []
  if (!s.baseUrl) out.push(t('yaya.speech.field.base_url', '接口地址'))
  if (!s.model) out.push(t('yaya.speech.field.model', '模型'))
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
  throw new Error(
    te('yaya.speech.err_bad_asr', { body: raw.slice(0, 200) }, 'ASR 返回格式不对：{body}')
  )
}
