<script setup lang="ts">
/**
 * speech 插件的输入框扩展：往「+」面板注册「语音输入」，录音时在输入框里显示录音条。
 * 录音（MediaRecorder）→ base64 → `yaya.speech-transcribe` → 识别结果插到光标处。
 * 录音只在本机内存里，不落盘；识别失败录音就丢掉（不重试，避免重复消耗额度）。
 */
import { computed, inject, onBeforeUnmount, onMounted, ref, toRef } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { PluginInputContext } from '../../components/plugin-input'
import { pluginConfigValues } from '../../components/plugin-ui-registry'

const props = defineProps<{ context: PluginInputContext }>()
const context = toRef(props, 'context')

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

type State = 'idle' | 'starting' | 'recording' | 'transcribing' | 'error'
const state = ref<State>('idle')
const error = ref('')
const elapsed = ref(0)
/** 电平条（0–1），录音时实时刷新 */
const levels = ref<number[]>(Array(16).fill(0))

let stream: MediaStream | null = null
let recorder: MediaRecorder | null = null
let parts: Blob[] = []
let audioCtx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let frame = 0
let timer: ReturnType<typeof setInterval> | null = null
let startedAt = 0
/** 取消 = 停止录音但不识别 */
let discard = false
let disposeAction: (() => void) | null = null
let disposeHooks: (() => void) | null = null

const maxSec = computed(() => {
  const v = Number(pluginConfigValues('speech').asr_max_sec)
  return Number.isFinite(v) && v >= 10 ? Math.min(600, v) : 120
})

const timeText = computed(() => {
  const s = Math.floor(elapsed.value)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})

function pickMime(): string {
  const prefs = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']
  if (typeof MediaRecorder === 'undefined') return ''
  return prefs.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
}

function fail(message: string): void {
  cleanup()
  state.value = 'error'
  error.value = message
}

async function start(): Promise<void> {
  if (state.value === 'recording' || state.value === 'starting') return
  error.value = ''
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    fail(
      window.isSecureContext
        ? t('yaya.speech.asr.unsupported', '当前环境不支持录音')
        : t(
            'yaya.speech.asr.insecure',
            '浏览器只在 https 或 localhost 下允许使用麦克风：请用安全地址打开网页版'
          )
    )
    return
  }
  state.value = 'starting'
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    })
  } catch (e) {
    const name = e instanceof DOMException ? e.name : ''
    fail(
      name === 'NotAllowedError'
        ? t('yaya.speech.asr.denied', '没有麦克风权限')
        : name === 'NotFoundError'
          ? t('yaya.speech.asr.no_mic', '没有找到麦克风')
          : String(e)
    )
    return
  }
  const mime = pickMime()
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  } catch (e) {
    fail(String(e))
    return
  }
  parts = []
  discard = false
  recorder.ondataavailable = (e) => {
    if (e.data.size) parts.push(e.data)
  }
  recorder.onstop = () => void finishRecording(recorder?.mimeType || mime || 'audio/webm')
  recorder.start(250)
  startedAt = performance.now()
  elapsed.value = 0
  state.value = 'recording'
  timer = setInterval(() => {
    elapsed.value = (performance.now() - startedAt) / 1000
    if (elapsed.value >= maxSec.value) stopRecording()
  }, 200)
  startMeter(stream)
}

function startMeter(s: MediaStream): void {
  try {
    audioCtx = new AudioContext()
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = 256
    audioCtx.createMediaStreamSource(s).connect(analyser)
    const buf = new Uint8Array(analyser.frequencyBinCount)
    const tick = (): void => {
      if (!analyser) return
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128)
      levels.value = [...levels.value.slice(1), Math.min(1, peak * 2.2)]
      frame = requestAnimationFrame(tick)
    }
    tick()
  } catch {
    /* 电平条只是装饰：失败不影响录音 */
  }
}

function stopRecording(): void {
  if (recorder && recorder.state !== 'inactive') recorder.stop()
}

function cancel(): void {
  discard = true
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  else cleanup()
  state.value = 'idle'
}

function cleanup(): void {
  if (timer) clearInterval(timer)
  timer = null
  cancelAnimationFrame(frame)
  analyser = null
  void audioCtx?.close().catch(() => {})
  audioCtx = null
  for (const track of stream?.getTracks() ?? []) track.stop()
  stream = null
  levels.value = Array(16).fill(0)
}

async function finishRecording(mime: string): Promise<void> {
  const blob = new Blob(parts, { type: mime })
  parts = []
  recorder = null
  cleanup()
  if (discard) {
    state.value = 'idle'
    return
  }
  if (!blob.size) {
    fail(t('yaya.speech.err_no_audio', '没有录到声音'))
    return
  }
  state.value = 'transcribing'
  try {
    const b64 = await blobToBase64(blob)
    const res = (await window.cockpit.command('yaya.speech-transcribe', {
      audio: b64,
      mime: mime.split(';')[0]
    })) as { text?: string }
    if (state.value !== 'transcribing') return
    insert((res.text ?? '').trim())
    state.value = 'idle'
  } catch (e) {
    if (state.value === 'transcribing') fail(e instanceof Error ? e.message : String(e))
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const s = String(reader.result ?? '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** 识别结果插到光标处（前后按需补空格，中文不补） */
function insert(text: string): void {
  if (!text) return
  const draft = context.value.draft.value
  const { start, end } = context.value.selection()
  const before = draft.slice(0, start)
  const after = draft.slice(end)
  const ascii = /[A-Za-z0-9]$/
  const lead = before && ascii.test(before) && /^[A-Za-z0-9]/.test(text) ? ' ' : ''
  const trail = after && /^[A-Za-z0-9]/.test(after) && ascii.test(text) ? ' ' : ''
  context.value.replaceRange(start, end, lead + text + trail)
}

function toggle(): void {
  if (state.value === 'recording') stopRecording()
  else void start()
}

onMounted(() => {
  disposeAction = context.value.addAction({
    id: 'asr',
    icon: 'mdi-microphone-outline',
    label: t('yaya.speech.asr.action', '语音输入'),
    description: t('yaya.speech.asr.action_desc', '录音并转成文字，插到光标处'),
    order: 10,
    active: () => state.value === 'recording',
    disabled: () => state.value === 'transcribing' || state.value === 'starting',
    run: toggle
  })
  // 切换会话 / 发送后宿主会 reset：正在录的直接丢掉
  disposeHooks = context.value.register({
    reset: () => {
      if (state.value === 'recording' || state.value === 'starting') cancel()
      if (state.value === 'error') state.value = 'idle'
    }
  })
})

onBeforeUnmount(() => {
  discard = true
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  cleanup()
  disposeAction?.()
  disposeHooks?.()
})
</script>

<template>
  <div v-if="state !== 'idle'" class="asr-row" :class="`is-${state}`" role="status">
    <template v-if="state === 'recording' || state === 'starting'">
      <span class="asr-dot" aria-hidden="true" />
      <div class="asr-levels" aria-hidden="true">
        <span
          v-for="(l, i) in levels"
          :key="i"
          :style="{ transform: `scaleY(${0.15 + l * 0.85})` }"
        />
      </div>
      <span class="asr-time">{{ timeText }}</span>
      <span class="asr-hint asr-listening text-medium-emphasis">{{
        t('yaya.speech.asr.listening', '正在听…')
      }}</span>
      <v-spacer />
      <v-btn
        icon="mdi-close"
        variant="text"
        size="small"
        :title="t('yaya.speech.asr.cancel', '取消录音')"
        :aria-label="t('yaya.speech.asr.cancel', '取消录音')"
        @pointerdown.prevent
        @click="cancel"
      />
      <v-btn
        icon="mdi-check"
        color="primary"
        variant="tonal"
        size="small"
        :disabled="state !== 'recording'"
        :title="t('yaya.speech.asr.done', '结束并识别')"
        :aria-label="t('yaya.speech.asr.done', '结束并识别')"
        @pointerdown.prevent
        @click="stopRecording"
      />
    </template>
    <template v-else-if="state === 'transcribing'">
      <v-progress-circular indeterminate size="18" width="2" color="primary" />
      <span class="asr-hint">{{ t('yaya.speech.asr.transcribing', '正在识别…') }}</span>
    </template>
    <template v-else>
      <v-icon icon="mdi-microphone-off" size="18" color="error" class="flex-shrink-0" />
      <span class="asr-error text-error" :title="error">{{ error }}</span>
      <v-spacer />
      <v-btn
        icon="mdi-close"
        variant="text"
        size="small"
        :title="t('yaya.cancel', '取消')"
        :aria-label="t('yaya.cancel', '取消')"
        @pointerdown.prevent
        @click="state = 'idle'"
      />
    </template>
  </div>
</template>

<style scoped>
.asr-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  margin: -2px 0 8px;
  padding: 2px 0 6px 4px;
  border-bottom: 1px solid rgba(var(--v-theme-primary), 0.2);
}
.asr-row.is-error {
  border-bottom-color: rgba(var(--v-theme-error), 0.3);
}
.asr-dot {
  width: 10px;
  height: 10px;
  flex-shrink: 0;
  border-radius: 50%;
  background: rgb(var(--v-theme-error));
  animation: asr-pulse 1.2s ease-in-out infinite;
}
@keyframes asr-pulse {
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .asr-dot {
    animation: none;
  }
}
.asr-levels {
  display: flex;
  align-items: center;
  gap: 2px;
  height: 22px;
  flex-shrink: 0;
}
.asr-levels span {
  width: 3px;
  height: 100%;
  border-radius: 2px;
  background: rgb(var(--v-theme-primary));
  transform-origin: center;
  transition: transform 0.08s linear;
}
.asr-time {
  font-variant-numeric: tabular-nums;
  font-size: 0.875rem;
  font-weight: 500;
}
.asr-hint {
  font-size: 0.8125rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.asr-error {
  font-size: 0.8125rem;
  min-width: 0;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
@media (max-width: 720px) {
  .asr-listening {
    display: none;
  }
}
</style>
