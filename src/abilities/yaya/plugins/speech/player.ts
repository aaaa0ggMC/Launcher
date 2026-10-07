/**
 * 朗读播放器（渲染端，模块级单例：切换页面 / 能力不中断）。
 *
 * - 系统语音：框架 SDK `@ui/speech` 逐段朗读（安卓 App = 系统 TTS，电脑 = speechSynthesis），
 *   不经过主进程；系统 TTS 不一定能暂停，暂停 = 停在当前段，继续 = 从这一段开头重念；
 * - 接口：`yaya.speech-speak` 在主进程后台任务里逐段合成，`cockpit:bt` 推送每段的音频地址，
 *   这里按顺序用 `<audio>` 播放；下一段还没合成好就等着（显示「合成中」）。
 *
 * 界面：悬浮播放器（Outsider `yaya.tts-player`）；用户在「设置 → 能力」里禁用了 YAYA 的悬浮窗时，
 * `tts.inline = true`，由 YAYA 页面在输入框上方显示同一个播放器。
 */
import { reactive } from 'vue'
import { closeOutsider, openOutsider } from '@ui/outsider'
import { speak as systemSpeak, systemSpeechSupport, type Utterance } from '@ui/speech'
import { engineOf, type SpeechEngine } from './engines'
import { pluginConfigValues } from '../../components/plugin-ui-registry'
import { speechText, splitSpeech } from './text'

export const TTS_OUTSIDER_ID = 'yaya.tts-player'

export type TtsStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

interface ChunkInfo {
  text: string
  url?: string
}

export const tts = reactive({
  status: 'idle' as TtsStatus,
  /** 正在朗读的消息（回答操作栏据此显示「停止」） */
  key: '',
  /** 朗读内容的开头（播放器标题） */
  title: '',
  /** system = 系统语音（渲染端）；api = 主进程接口合成 */
  engine: 'system' as 'system' | 'api',
  /** 具体引擎（播放器副标题） */
  provider: 'system' as SpeechEngine,
  index: 0,
  /** 总段数（接口引擎在合成结束前可能还不确定，以 done 为准） */
  total: 0,
  /** 已合成好的段数（接口引擎） */
  ready: 0,
  rate: 1,
  /** 当前段播放进度 0–1（系统语音按字符边界估算） */
  progress: 0,
  /** 错误：errorKey 有值时界面按它翻译（error 是中文兜底），否则 error 是原始错误文本 */
  error: '',
  errorKey: '',
  /** 悬浮窗被禁用：由 YAYA 页面内嵌显示 */
  inline: false
})

let chunks: ChunkInfo[] = []
let taskId = ''
let synthDone = false
let audio: HTMLAudioElement | null = null
let utterance: Utterance | null = null
/** 每次 speak / stop +1：旧的回调发现代变了就不再动状态 */
let gen = 0
/** 系统朗读的代：暂停 / 跳段 / 调速会 stop 当前段，旧段的 done 回来时据此忽略 */
let sysGen = 0
let btSubscribed = false

function cfg(): Record<string, unknown> {
  return pluginConfigValues('speech')
}

function errText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : String(e)
}

export function isSpeaking(key: string): boolean {
  return tts.key === key && tts.status !== 'idle' && tts.status !== 'error'
}

function showPlayer(): void {
  tts.inline = !openOutsider(TTS_OUTSIDER_ID)
}

function resetPlayback(): void {
  if (audio) {
    audio.onended = null
    audio.ontimeupdate = null
    audio.onerror = null
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }
  stopSystem()
}

/** 停掉系统朗读（先 gen 作废它的回调，不会被当成「念完了」去播下一段） */
function stopSystem(): void {
  if (utterance) {
    sysGen++
    utterance.stop()
    utterance = null
  }
}

function stopTask(): void {
  if (taskId) void window.cockpit.command('background.stop', { id: taskId }).catch(() => {})
  taskId = ''
}

/** 停止并关掉播放器 */
export function stop(): void {
  gen++
  resetPlayback()
  stopTask()
  chunks = []
  Object.assign(tts, { status: 'idle', key: '', title: '', index: 0, total: 0, ready: 0 })
  tts.progress = 0
  tts.error = ''
  tts.errorKey = ''
  setMediaSession(false)
  closeOutsider(TTS_OUTSIDER_ID)
  tts.inline = false
}

/** 朗读一条回答；同一条正在读 = 停止 */
export async function speak(key: string, markdown: string): Promise<void> {
  if (isSpeaking(key)) {
    stop()
    return
  }
  stop()
  const my = ++gen
  const text = speechText(markdown)
  const provider = engineOf(cfg().tts_engine)
  const engine = provider === 'system' ? 'system' : 'api'
  const rate = Number(cfg().tts_speed) || 1
  Object.assign(tts, {
    status: 'loading',
    key,
    title: text.replace(/\s+/g, ' ').slice(0, 80),
    engine,
    provider,
    rate: Math.min(2.5, Math.max(0.5, rate)),
    error: '',
    errorKey: ''
  })
  showPlayer()
  setMediaSession(true)
  if (!text) return fail(my, '没有可以朗读的文字', 'yaya.speech.err_no_text')

  if (engine === 'system') {
    if (!systemSpeechSupport().tts)
      return fail(
        my,
        '当前环境没有系统语音：设置 → YAYA → 插件 → 语音，改用接口引擎',
        'yaya.speech.err_no_browser_tts'
      )
    chunks = splitSpeech(text, 220, 120).map((t) => ({ text: t }))
    tts.total = chunks.length
    tts.ready = chunks.length
    playSystem(my, 0)
    return
  }

  subscribeBt()
  synthDone = false
  try {
    const res = (await window.cockpit.command('yaya.speech-speak', { text })) as {
      taskId: string
      total: number
    }
    if (my !== gen) {
      void window.cockpit.command('background.stop', { id: res.taskId }).catch(() => {})
      return
    }
    taskId = res.taskId
    chunks = []
    tts.total = res.total
    // 任务可能在命令返回前就推送过了：从缓冲里补一次
    const out = (await window.cockpit.command('background.output', { id: taskId })) as {
      messages?: { data?: unknown }[]
    }
    if (my !== gen) return
    for (const m of out.messages ?? []) onTaskData(m.data)
  } catch (e) {
    fail(my, errText(e))
  }
}

function fail(my: number, message: string, key = ''): void {
  if (my !== gen) return
  resetPlayback()
  tts.status = 'error'
  tts.error = message
  tts.errorKey = key
}

// ---- 系统语音 ----

function playSystem(my: number, index: number): void {
  if (my !== gen) return
  if (index >= chunks.length) return finish(my)
  tts.index = index
  tts.progress = 0
  const text = chunks[index].text
  const mine = ++sysGen
  const u = systemSpeak(text, {
    voice: String(cfg().tts_browser_voice ?? '') || undefined,
    rate: tts.rate,
    onStart: () => {
      if (my === gen && mine === sysGen && tts.status !== 'paused') tts.status = 'playing'
    },
    onBoundary: (i) => {
      if (my === gen && mine === sysGen) tts.progress = Math.min(1, i / Math.max(1, text.length))
    }
  })
  utterance = u
  // 没有 onStart 的引擎也要显示成「播放中」
  if (tts.status === 'loading') tts.status = 'playing'
  u.done.then(
    () => {
      if (my !== gen || mine !== sysGen) return
      if (utterance === u) utterance = null
      playSystem(my, index + 1)
    },
    (e: unknown) => {
      if (my === gen && mine === sysGen) fail(my, errText(e))
    }
  )
}

// ---- 接口 ----

function subscribeBt(): void {
  if (btSubscribed) return
  btSubscribed = true
  window.cockpit.on('cockpit:bt', (payload: unknown) => {
    const ev = payload as { type?: string; id?: string; messages?: { data?: unknown }[] }
    if (!taskId || ev.id !== taskId) return
    if (ev.type === 'output') for (const m of ev.messages ?? []) onTaskData(m.data)
    else if (ev.type === 'exit' && !synthDone && tts.status === 'loading' && !nextReady())
      fail(gen, '朗读任务已结束', 'yaya.speech.err_task_ended')
  })
}

function nextReady(): boolean {
  return !!chunks[tts.index]?.url
}

function onTaskData(data: unknown): void {
  const d = data as {
    type?: string
    index?: number
    total?: number
    text?: string
    url?: string
    message?: string
  }
  if (!d || typeof d !== 'object') return
  const my = gen
  if (d.type === 'chunk' && typeof d.index === 'number' && d.url) {
    if (chunks[d.index]?.url) return
    chunks[d.index] = { text: d.text ?? '', url: window.cockpit.hostUrl(d.url) }
    tts.ready = chunks.filter((c) => c?.url).length
    if (typeof d.total === 'number') tts.total = d.total
    // 正在等这一段：开播
    if (tts.status === 'loading' && d.index === tts.index) playApi(my, d.index)
  } else if (d.type === 'done') {
    synthDone = true
    taskId = ''
    if (typeof d.total === 'number') tts.total = d.total
  } else if (d.type === 'error') {
    synthDone = true
    taskId = ''
    // 已经合成好的照样念完；一段都没有才报错
    if (!nextReady()) fail(my, d.message || '朗读失败', d.message ? '' : 'yaya.speech.err_failed')
    else tts.error = d.message || ''
  }
}

function ensureAudio(): HTMLAudioElement {
  if (!audio) audio = new Audio()
  return audio
}

function playApi(my: number, index: number): void {
  if (my !== gen) return
  if (tts.total && index >= tts.total) return finish(my)
  tts.index = index
  tts.progress = 0
  const c = chunks[index]
  if (!c?.url) {
    // 还没合成好：等 onTaskData 来叫；合成已经结束（失败）就到此为止
    if (synthDone) return finish(my)
    tts.status = 'loading'
    return
  }
  const a = ensureAudio()
  a.onended = () => playApi(my, index + 1)
  a.ontimeupdate = () => {
    if (my === gen && a.duration > 0) tts.progress = a.currentTime / a.duration
  }
  a.onerror = () => fail(my, '音频播放失败', 'yaya.speech.err_play')
  a.src = c.url
  a.playbackRate = tts.rate
  a.play().then(
    () => {
      if (my === gen) tts.status = 'playing'
    },
    (e: unknown) => {
      // 被浏览器的自动播放策略挡住：停在暂停态，用户点播放即可
      if (my !== gen) return
      if (e instanceof DOMException && e.name === 'NotAllowedError') tts.status = 'paused'
      else fail(my, errText(e))
    }
  )
}

function finish(my: number): void {
  if (my !== gen) return
  // 念完了：收起播放器
  stop()
}

// ---- 控制 ----

export function toggle(): void {
  if (tts.status === 'playing') {
    // 系统 TTS（尤其安卓）不一定能暂停：停在当前段，继续时从这一段开头重念
    if (tts.engine === 'system') stopSystem()
    else audio?.pause()
    tts.status = 'paused'
  } else if (tts.status === 'paused') {
    if (tts.engine === 'system') {
      tts.status = 'playing'
      playSystem(gen, tts.index)
      return
    } else if (audio?.src) void audio.play()
    else playApi(gen, tts.index)
    tts.status = 'playing'
  }
}

function restartChunk(): void {
  const my = gen
  if (tts.engine === 'system') {
    stopSystem()
    playSystem(my, tts.index)
  } else playApi(my, tts.index)
}

/** 跳到上一段 / 下一段 */
export function skip(delta: number): void {
  if (tts.status === 'idle' || tts.status === 'error') return
  const max = (tts.total || chunks.length) - 1
  const next = Math.max(0, Math.min(max, tts.index + delta))
  if (next === tts.index && delta > 0) return
  tts.index = next
  if (tts.engine === 'api' && audio) {
    audio.onended = null
    audio.pause()
  }
  restartChunk()
}

export function setRate(rate: number): void {
  tts.rate = Math.min(2.5, Math.max(0.5, rate))
  if (tts.engine === 'api') {
    if (audio) audio.playbackRate = tts.rate
  } else if (tts.status === 'playing') restartChunk()
}

// ---- 系统媒体控制（安卓 App 的通知栏 / 锁屏；浏览器的媒体键） ----

function setMediaSession(on: boolean): void {
  const ms = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined
  if (!ms) return
  try {
    if (!on) {
      ms.metadata = null
      for (const a of ['play', 'pause', 'stop', 'nexttrack', 'previoustrack'] as const)
        ms.setActionHandler(a, null)
      return
    }
    ms.metadata = new MediaMetadata({ title: tts.title || 'YAYA', artist: 'YAYA' })
    ms.setActionHandler('play', () => tts.status === 'paused' && toggle())
    ms.setActionHandler('pause', () => tts.status === 'playing' && toggle())
    ms.setActionHandler('stop', stop)
    ms.setActionHandler('nexttrack', () => skip(1))
    ms.setActionHandler('previoustrack', () => skip(-1))
  } catch {
    /* 不支持的动作忽略 */
  }
}
