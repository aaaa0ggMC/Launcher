/**
 * 系统语音 SDK（渲染端，框架层）：任何能力 / 插件都能用的「系统自带」朗读与语音识别。
 *
 *   import { speak, recognize, systemSpeechSupport } from '@ui/speech'
 *   const u = speak('你好', { rate: 1.2 })      // u.done: Promise<void>，u.stop()
 *   const r = recognize({ onPartial: (t) => … }) // r.result: Promise<string>，r.stop() / r.cancel()
 *
 * 后端按宿主自动选：
 * - **安卓 App（0.8.0+）**：WebView 没有 Web Speech API，走原生桥 `tts.*` / `asr.*`
 *   （系统 TextToSpeech / SpeechRecognizer，见 android/…/SpeechBridge.java）；
 * - **浏览器 / Electron**：`speechSynthesis`；识别用 `SpeechRecognition`（Chrome / Edge 在线识别）。
 *   Electron 里 `webkitSpeechRecognition` 存在但连不上识别服务，视为不支持。
 *
 * 同一时刻只有一段朗读：新的 speak 会打断旧的（旧的 done 以「已停止」正常结束）。
 * 识别同理只有一路。不支持时 speak / recognize 返回的 Promise 以 `SpeechError('unsupported')` 失败，
 * 调用前可先看 `systemSpeechSupport()`。
 */

export type SpeechErrorCode =
  'unsupported' | 'permission' | 'network' | 'no-speech' | 'busy' | 'failed'

export class SpeechError extends Error {
  constructor(
    public code: SpeechErrorCode,
    message?: string
  ) {
    super(message || code)
    this.name = 'SpeechError'
  }
}

export interface SystemVoice {
  id: string
  name: string
  /** BCP-47，如 zh-CN */
  lang: string
  /** 本地语音（不需要联网） */
  local: boolean
}

export interface SpeakOptions {
  /** BCP-47；缺省按文字猜（含汉字 = zh-CN，否则 en-US） */
  lang?: string
  /** 语音 id，或名称的一部分（不区分大小写）；找不到就按 lang 选 */
  voice?: string
  /** 0.5–2.5，缺省 1 */
  rate?: number
  /** 0.5–2，缺省 1 */
  pitch?: number
  onStart?: () => void
  /** 念到第几个字（不是所有引擎都有） */
  onBoundary?: (charIndex: number) => void
}

export interface Utterance {
  /** 念完 / 被 stop 打断时 resolve；出错时 reject（SpeechError） */
  done: Promise<void>
  stop: () => void
}

export interface RecognizeOptions {
  /** BCP-47；缺省 = 界面 / 浏览器语言 */
  lang?: string
  /** 实时的中间结果（缺省开启） */
  onPartial?: (text: string) => void
  /** 0–1 的音量电平（只有部分后端有） */
  onLevel?: (level: number) => void
  /** 麦克风开始收音 */
  onReady?: () => void
}

export interface Recognition {
  /** 最终文字；cancel 后为空串；没听到说话也是空串 */
  result: Promise<string>
  /** 说完了：停止收音，等最终结果 */
  stop: () => void
  /** 放弃：result 立即以空串结束 */
  cancel: () => void
}

export interface SystemSpeechSupport {
  tts: boolean
  asr: boolean
  backend: 'native' | 'browser' | 'none'
}

// ---------------------------------------------------------------------------
// 后端探测
// ---------------------------------------------------------------------------

/** 原生客户端版本 ≥ 0.8.0 才有 tts.* / asr.* */
function nativeClient(): NonNullable<typeof window.cockpit.client> | null {
  const c = typeof window !== 'undefined' ? window.cockpit?.client : null
  if (!c || c.kind !== 'android') return null
  const [maj, min] = String(c.version || '0')
    .split('.')
    .map((n) => Number(n) || 0)
  return maj > 0 || min >= 8 ? c : null
}

/** 原生端报告的识别可用性（info.speech.asr），首次探测后缓存 */
let nativeAsr: boolean | null = null
async function probeNativeAsr(): Promise<boolean> {
  if (nativeAsr !== null) return nativeAsr
  const c = nativeClient()
  if (!c) return (nativeAsr = false)
  try {
    const info = await c.call<{ speech?: { asr?: boolean } }>('info')
    nativeAsr = info?.speech?.asr === true
  } catch {
    nativeAsr = false
  }
  return nativeAsr
}

function isElectron(): boolean {
  return typeof navigator !== 'undefined' && /Electron\//.test(navigator.userAgent)
}

type RecognitionCtor = new () => BrowserRecognition
interface BrowserRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<BrowserResult> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  onaudiostart: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
interface BrowserResult {
  isFinal: boolean
  0: { transcript: string }
}

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined' || isElectron()) return null
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor
    webkitSpeechRecognition?: RecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** 同步的可用性（安卓 App 的识别以原生 info 为准，首次调用 `systemSpeechReady()` 后才准确） */
export function systemSpeechSupport(): SystemSpeechSupport {
  if (nativeClient()) return { tts: true, asr: nativeAsr !== false, backend: 'native' }
  const tts = typeof speechSynthesis !== 'undefined'
  const asr = !!recognitionCtor()
  return { tts, asr, backend: tts || asr ? 'browser' : 'none' }
}

/** 异步探测（安卓 App 要问一次原生端识别是否可用） */
export async function systemSpeechReady(): Promise<SystemSpeechSupport> {
  if (nativeClient()) await probeNativeAsr()
  return systemSpeechSupport()
}

function guessLang(text: string): string {
  return /[㐀-鿿]/.test(text) ? 'zh-CN' : 'en-US'
}

function clamp(v: number | undefined, min: number, max: number, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt
}

// ---------------------------------------------------------------------------
// 语音列表
// ---------------------------------------------------------------------------

function browserVoices(): Promise<SpeechSynthesisVoice[]> {
  if (typeof speechSynthesis === 'undefined') return Promise.resolve([])
  const now = speechSynthesis.getVoices()
  if (now.length) return Promise.resolve(now)
  // Chrome 首次 getVoices() 为空，要等 voiceschanged
  return new Promise((resolve) => {
    const done = (): void => {
      speechSynthesis.removeEventListener('voiceschanged', done)
      resolve(speechSynthesis.getVoices())
    }
    speechSynthesis.addEventListener('voiceschanged', done)
    setTimeout(done, 1200)
  })
}

export async function systemVoices(): Promise<SystemVoice[]> {
  const c = nativeClient()
  if (c) {
    const r = await c.call<{ voices?: SystemVoice[] }>('tts.voices')
    return r?.voices ?? []
  }
  return (await browserVoices()).map((v) => ({
    id: v.voiceURI,
    name: v.name,
    lang: v.lang,
    local: v.localService
  }))
}

/** 按 id / 名称片段 / 语言挑一个 */
export function pickVoice<T extends { id?: string; name: string; lang: string; local?: boolean }>(
  voices: T[],
  want: string | undefined,
  lang: string
): T | null {
  const w = (want ?? '').trim().toLowerCase()
  if (w) {
    const hit =
      voices.find((v) => v.id?.toLowerCase() === w) ??
      voices.find((v) => v.name.toLowerCase().includes(w))
    if (hit) return hit
  }
  const l = lang.toLowerCase()
  const base = l.split('-')[0]
  const norm = (s: string): string => s.toLowerCase().replace('_', '-')
  return (
    voices.find((v) => norm(v.lang) === l && v.local !== false) ??
    voices.find((v) => norm(v.lang) === l) ??
    voices.find((v) => norm(v.lang).startsWith(base) && v.local !== false) ??
    voices.find((v) => norm(v.lang).startsWith(base)) ??
    null
  )
}

// ---------------------------------------------------------------------------
// 朗读
// ---------------------------------------------------------------------------

let current: Utterance | null = null
let seq = 0

/** 停止当前朗读（没有在念就什么也不做） */
export function stopSpeaking(): void {
  current?.stop()
  current = null
}

type TtsEvent = { id?: string; type?: string; start?: number; error?: string }
const nativeTtsListeners = new Map<string, (e: TtsEvent) => void>()
let nativeTtsSubscribed = false
function subscribeNativeTts(): void {
  if (nativeTtsSubscribed) return
  nativeTtsSubscribed = true
  window.cockpit.on('cockpit:client-tts', (payload: unknown) => {
    const e = payload as TtsEvent
    if (e?.id) nativeTtsListeners.get(e.id)?.(e)
  })
}

export function speak(text: string, opts: SpeakOptions = {}): Utterance {
  stopSpeaking()
  const lang = opts.lang || guessLang(text)
  const rate = clamp(opts.rate, 0.5, 2.5, 1)
  const pitch = clamp(opts.pitch, 0.5, 2, 1)
  let resolveDone!: () => void
  let rejectDone!: (e: unknown) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  // 调用方不 await 也不要变成未处理的拒绝
  done.catch(() => {})
  let finished = false
  const finish = (err?: unknown): void => {
    if (finished) return
    finished = true
    if (current === utter) current = null
    if (err) rejectDone(err)
    else resolveDone()
  }

  const c = nativeClient()
  let stopImpl: () => void

  if (c) {
    subscribeNativeTts()
    const id = `u${Date.now().toString(36)}${++seq}`
    nativeTtsListeners.set(id, (e) => {
      if (e.type === 'start') opts.onStart?.()
      else if (e.type === 'range' && typeof e.start === 'number') opts.onBoundary?.(e.start)
      else if (e.type === 'done' || e.type === 'stopped') {
        nativeTtsListeners.delete(id)
        finish()
      } else if (e.type === 'error') {
        nativeTtsListeners.delete(id)
        finish(new SpeechError('failed', e.error))
      }
    })
    void (async () => {
      let voice = opts.voice
      if (voice) {
        try {
          voice = pickVoice(await systemVoices(), voice, lang)?.id
        } catch {
          voice = undefined
        }
      }
      if (finished) return
      await c.call('tts.speak', { id, text, lang, voice, rate, pitch })
    })().catch((e: unknown) => {
      nativeTtsListeners.delete(id)
      finish(new SpeechError('failed', e instanceof Error ? e.message : String(e)))
    })
    stopImpl = () => {
      nativeTtsListeners.delete(id)
      void c.call('tts.stop').catch(() => {})
      finish()
    }
  } else if (typeof speechSynthesis !== 'undefined') {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = lang
    u.rate = rate
    u.pitch = pitch
    u.onstart = () => opts.onStart?.()
    u.onboundary = (e) => opts.onBoundary?.(e.charIndex)
    u.onend = () => finish()
    u.onerror = (e) => {
      // 自己 cancel 的（停止 / 打断）不算失败
      if (e.error === 'canceled' || e.error === 'interrupted') finish()
      else finish(new SpeechError('failed', e.error))
    }
    void browserVoices().then((list) => {
      if (finished) return
      const v = pickVoice(
        list.map((x) => ({ id: x.voiceURI, name: x.name, lang: x.lang, local: x.localService, x })),
        opts.voice,
        lang
      )
      if (v) {
        u.voice = v.x
        u.lang = v.lang
      }
      speechSynthesis.cancel()
      speechSynthesis.speak(u)
    })
    stopImpl = () => {
      u.onend = null
      u.onerror = null
      speechSynthesis.cancel()
      finish()
    }
  } else {
    stopImpl = () => finish()
    queueMicrotask(() => finish(new SpeechError('unsupported', 'no system text-to-speech')))
  }

  const utter: Utterance = { done, stop: () => stopImpl() }
  current = utter
  return utter
}

// ---------------------------------------------------------------------------
// 识别
// ---------------------------------------------------------------------------

let currentRec: Recognition | null = null

type AsrEvent = { type?: string; text?: string; error?: string; level?: number }

function errorCode(e: string | undefined): SpeechErrorCode {
  const s = (e ?? '').toLowerCase()
  if (s.includes('not-allowed') || s.includes('permission') || s.includes('service-not-allowed'))
    return 'permission'
  if (s.includes('network')) return 'network'
  if (s.includes('no-speech')) return 'no-speech'
  if (s.includes('busy')) return 'busy'
  return 'failed'
}

export function recognize(opts: RecognizeOptions = {}): Recognition {
  currentRec?.cancel()
  const lang =
    opts.lang ||
    (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh-CN')
  let resolveResult!: (t: string) => void
  let rejectResult!: (e: unknown) => void
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  result.catch(() => {})
  let finished = false
  let finalText = ''
  let partialText = ''
  const finish = (err?: SpeechError, text?: string): void => {
    if (finished) return
    finished = true
    if (currentRec === rec) currentRec = null
    if (err && err.code !== 'no-speech') rejectResult(err)
    else resolveResult((text ?? (finalText || partialText)).trim())
  }

  const c = nativeClient()
  let stopImpl: () => void
  let cancelImpl: () => void

  if (c) {
    const off = window.cockpit.on('cockpit:client-asr', (payload: unknown) => {
      const e = payload as AsrEvent
      if (finished) return
      if (e.type === 'ready') opts.onReady?.()
      else if (e.type === 'level' && typeof e.level === 'number') opts.onLevel?.(e.level)
      else if (e.type === 'partial' && e.text) {
        partialText = e.text
        opts.onPartial?.(e.text)
      } else if (e.type === 'final') finalText = e.text ?? ''
      else if (e.type === 'error') {
        off()
        finish(new SpeechError(errorCode(e.error), e.error))
      } else if (e.type === 'end') {
        off()
        finish()
      }
    })
    void c.call('asr.start', { lang, partial: true }).catch((e: unknown) => {
      off()
      const msg = e instanceof Error ? e.message : String(e)
      finish(new SpeechError(/unavailable/.test(msg) ? 'unsupported' : 'failed', msg))
    })
    stopImpl = () => void c.call('asr.stop').catch(() => {})
    cancelImpl = () => {
      off()
      void c.call('asr.cancel').catch(() => {})
      finish(undefined, '')
    }
  } else {
    const Ctor = recognitionCtor()
    if (!Ctor) {
      stopImpl = cancelImpl = () => finish(undefined, '')
      queueMicrotask(() => finish(new SpeechError('unsupported', 'no system speech recognition')))
    } else {
      const r = new Ctor()
      r.lang = lang
      r.continuous = true
      r.interimResults = true
      r.onaudiostart = () => opts.onReady?.()
      r.onresult = (e) => {
        let fin = ''
        let interim = ''
        for (let i = 0; i < e.results.length; i++) {
          const res = e.results[i]
          if (res.isFinal) fin += res[0].transcript
          else interim += res[0].transcript
        }
        finalText = fin
        partialText = fin + interim
        opts.onPartial?.(partialText)
      }
      r.onerror = (e) => finish(new SpeechError(errorCode(e.error), e.error))
      r.onend = () => finish()
      try {
        r.start()
      } catch (e) {
        queueMicrotask(() => finish(new SpeechError('busy', String(e))))
      }
      stopImpl = () => r.stop()
      cancelImpl = () => {
        r.onend = null
        r.onerror = null
        r.abort()
        finish(undefined, '')
      }
    }
  }

  const rec: Recognition = { result, stop: () => stopImpl(), cancel: () => cancelImpl() }
  currentRec = rec
  return rec
}
