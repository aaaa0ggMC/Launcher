<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { ToolDefinition, ToolField } from '../../types'

const props = defineProps<{ tool: ToolDefinition }>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

interface Strings {
  settings: string
  focusMinutes: string
  breakMinutes: string
  minutes: string
  focus: string
  break: string
  start: string
  pause: string
  resume: string
  reset: string
  clearCount: string
  completed: string
  nextPhase: string
  ringAria: string
  stateIdle: string
  stateRunning: string
  statePaused: string
}

const ZH: Strings = {
  settings: '设置',
  focusMinutes: '专注分钟',
  breakMinutes: '休息分钟',
  minutes: '分钟',
  focus: '专注',
  break: '休息',
  start: '开始',
  pause: '暂停',
  resume: '继续',
  reset: '重置',
  clearCount: '清除完成数',
  completed: '已完成专注',
  nextPhase: '下一阶段',
  ringAria: '番茄钟剩余时间进度环',
  stateIdle: '待开始',
  stateRunning: '计时中',
  statePaused: '已暂停'
}

const EN: Strings = {
  settings: 'Settings',
  focusMinutes: 'Focus minutes',
  breakMinutes: 'Break minutes',
  minutes: 'min',
  focus: 'Focus',
  break: 'Break',
  start: 'Start',
  pause: 'Pause',
  resume: 'Resume',
  reset: 'Reset',
  clearCount: 'Clear count',
  completed: 'Completed focus',
  nextPhase: 'Next',
  ringAria: 'Pomodoro remaining-time progress ring',
  stateIdle: 'Idle',
  stateRunning: 'Running',
  statePaused: 'Paused'
}

const L = computed<Strings>(() => (uiLang.value.startsWith('en') ? EN : ZH))

const toolDescription = computed<string>(
  () =>
    (uiLang.value.startsWith('en')
      ? (props.tool.descriptionEn ?? props.tool.description)
      : props.tool.description) || ''
)

// ---------------------------------------------------------------------------
// 设置项直接来自 definition 的 fields（min/max/默认值一致，便于 CLI 兜底）
// ---------------------------------------------------------------------------
function fieldOf(key: string): ToolField | undefined {
  return props.tool.fields.find((f) => f.key === key)
}

interface Range {
  min: number
  max: number
}

function initialMinutes(key: string, fallback: number, range: Range): number {
  const raw = fieldOf(key)?.default
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
  return Math.min(range.max, Math.max(range.min, Math.round(n)))
}

function rangeOf(key: string, fallback: Range): Range {
  const field = fieldOf(key)
  return {
    min: typeof field?.min === 'number' ? field.min : fallback.min,
    max: typeof field?.max === 'number' ? field.max : fallback.max
  }
}

const focusRange = computed<Range>(() => rangeOf('focusMinutes', { min: 1, max: 180 }))
const breakRange = computed<Range>(() => rangeOf('breakMinutes', { min: 1, max: 60 }))

const focusMinutes = ref(initialMinutes('focusMinutes', 25, { min: 1, max: 180 }))
const breakMinutes = ref(initialMinutes('breakMinutes', 5, { min: 1, max: 60 }))

// ---------------------------------------------------------------------------
// 计时状态：deadline 驱动，避免 setInterval 累积漂移
// ---------------------------------------------------------------------------
type Phase = 'focus' | 'break'

const phase = ref<Phase>('focus')
const running = ref(false)
/** 是否已经开过一轮（区分「待开始」与「已暂停」）。 */
const started = ref(false)
/** 暂停/待开始时保留的剩余毫秒；运行中每 tick 用 deadline 反推刷新。 */
const remainingMs = ref(focusMinutes.value * 60000)
const completedFocus = ref(0)
let deadline = 0
let timerId: ReturnType<typeof setInterval> | null = null

const TICK_MS = 200
const RING_CIRCUMFERENCE = 2 * Math.PI * 104
const STORAGE_KEY = 'cockpit-toolbox-pomodoro-completed'

const phaseTotalMs = computed<number>(
  () => (phase.value === 'focus' ? focusMinutes.value : breakMinutes.value) * 60000
)
const progress = computed<number>(() => {
  const total = phaseTotalMs.value
  if (total <= 0) return 0
  const ratio = remainingMs.value / total
  return Math.min(1, Math.max(0, ratio))
})
const ringOffset = computed<number>(() => RING_CIRCUMFERENCE * (1 - progress.value))
const ringColor = computed<string>(() =>
  phase.value === 'focus' ? 'rgb(var(--v-theme-primary))' : 'rgb(var(--v-theme-secondary))'
)
const clock = computed<string>(() => formatClock(remainingMs.value))
const phaseLabel = computed<string>(() => (phase.value === 'focus' ? L.value.focus : L.value.break))
const stateLabel = computed<string>(() => {
  if (running.value) return L.value.stateRunning
  return started.value ? L.value.statePaused : L.value.stateIdle
})
const nextPhaseMinutes = computed<number>(() =>
  phase.value === 'focus' ? breakMinutes.value : focusMinutes.value
)
const nextPhaseLabel = computed<string>(() =>
  phase.value === 'focus' ? L.value.break : L.value.focus
)
const primaryLabel = computed<string>(() => {
  if (running.value) return L.value.pause
  return started.value ? L.value.resume : L.value.start
})

function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function stopTimer(): void {
  if (timerId !== null) {
    clearInterval(timerId)
    timerId = null
  }
}

function tick(): void {
  const left = deadline - Date.now()
  if (left <= 0) {
    completePhase()
    return
  }
  remainingMs.value = left
}

function completePhase(): void {
  if (phase.value === 'focus') {
    completedFocus.value += 1
    persistCount()
  }
  phase.value = phase.value === 'focus' ? 'break' : 'focus'
  remainingMs.value = phaseTotalMs.value
  deadline = Date.now() + remainingMs.value
}

function start(): void {
  if (running.value) return
  if (remainingMs.value <= 0) {
    phase.value = 'focus'
    remainingMs.value = phaseTotalMs.value
  }
  started.value = true
  deadline = Date.now() + remainingMs.value
  running.value = true
  stopTimer()
  timerId = setInterval(tick, TICK_MS)
}

function pause(): void {
  if (!running.value) return
  remainingMs.value = Math.max(0, deadline - Date.now())
  running.value = false
  stopTimer()
}

function toggle(): void {
  if (running.value) pause()
  else start()
}

function reset(): void {
  stopTimer()
  running.value = false
  started.value = false
  phase.value = 'focus'
  remainingMs.value = phaseTotalMs.value
}

function clearCount(): void {
  completedFocus.value = 0
  persistCount()
}

// ---------------------------------------------------------------------------
// 只持久化完成次数，不保存任何用户输入/内容
// ---------------------------------------------------------------------------
function loadCount(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return 0
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  } catch {
    return 0
  }
}

function persistCount(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(completedFocus.value))
  } catch {
    // 隐私模式/存储不可用时静默降级，不影响计时
  }
}

completedFocus.value = loadCount()

function sanitizeMinutes(raw: unknown, range: Range): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return range.min
  return Math.min(range.max, Math.max(range.min, Math.round(n)))
}

watch(focusMinutes, (v) => {
  const next = sanitizeMinutes(v, focusRange.value)
  if (next !== v) focusMinutes.value = next
  if (!running.value && phase.value === 'focus') remainingMs.value = next * 60000
})

watch(breakMinutes, (v) => {
  const next = sanitizeMinutes(v, breakRange.value)
  if (next !== v) breakMinutes.value = next
  if (!running.value && phase.value === 'break') remainingMs.value = next * 60000
})

onDeactivated(() => {
  // 离开页面即停止计时，不在后台空转
  pause()
})

onBeforeUnmount(() => {
  stopTimer()
})
</script>

<template>
  <div class="pomodoro-panel d-flex flex-column h-100 min-h-0">
    <!-- 工具栏：文字按钮默认密度，wrap + gap12 + padding24 -->
    <div class="pomodoro-toolbar d-flex flex-wrap align-center ga-3 pa-6">
      <v-text-field
        v-model.number="focusMinutes"
        class="pomodoro-num"
        type="number"
        :min="focusRange.min"
        :max="focusRange.max"
        :label="L.focusMinutes"
        hide-details
      />
      <v-text-field
        v-model.number="breakMinutes"
        class="pomodoro-num"
        type="number"
        :min="breakRange.min"
        :max="breakRange.max"
        :label="L.breakMinutes"
        hide-details
      />
      <v-btn
        density="default"
        variant="flat"
        color="primary"
        prepend-icon="mdi-play"
        @click="toggle"
      >
        {{ primaryLabel }}
      </v-btn>
      <v-btn density="default" variant="text" prepend-icon="mdi-restart" @click="reset">
        {{ L.reset }}
      </v-btn>
      <v-btn
        density="default"
        variant="text"
        prepend-icon="mdi-counter"
        :disabled="completedFocus <= 0"
        @click="clearCount"
      >
        {{ L.clearCount }}
      </v-btn>
      <v-spacer />
      <span v-if="toolDescription" class="text-body-2 text-medium-emphasis pomodoro-desc">
        {{ toolDescription }}
      </span>
    </div>

    <!-- 主区：进度环 + 状态 -->
    <div class="pomodoro-stage d-flex flex-column align-center justify-center flex-grow-1 pa-4">
      <div class="pomodoro-ring-wrapper">
        <svg class="pomodoro-ring" viewBox="0 0 240 240" role="img" :aria-label="L.ringAria">
          <title>{{ L.ringAria }}</title>
          <circle
            class="pomodoro-ring-track"
            cx="120"
            cy="120"
            r="104"
            fill="none"
            stroke-width="12"
          />
          <circle
            class="pomodoro-ring-progress"
            cx="120"
            cy="120"
            r="104"
            fill="none"
            :stroke="ringColor"
            stroke-width="12"
            stroke-linecap="round"
            :stroke-dasharray="RING_CIRCUMFERENCE"
            :stroke-dashoffset="ringOffset"
            transform="rotate(-90 120 120)"
          />
        </svg>
        <div class="pomodoro-readout">
          <div class="pomodoro-clock">{{ clock }}</div>
          <div class="pomodoro-phase" aria-live="polite">{{ phaseLabel }} · {{ stateLabel }}</div>
        </div>
      </div>

      <div class="pomodoro-meta d-flex flex-wrap align-center justify-center ga-3 mt-6">
        <v-chip density="default" class="pomodoro-chip">
          <v-icon start icon="mdi-check-circle-outline" />
          {{ L.completed }}: {{ completedFocus }}
        </v-chip>
        <span class="text-body-2 text-medium-emphasis">
          {{ L.nextPhase }}: {{ nextPhaseLabel }} {{ nextPhaseMinutes }} {{ L.minutes }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pomodoro-panel {
  overflow: hidden;
}

.pomodoro-toolbar {
  border-bottom: 1px solid rgba(var(--v-border-color, var(--v-theme-outline)), 0.24);
}

.pomodoro-num {
  max-width: 148px;
}

.pomodoro-desc {
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pomodoro-ring-wrapper {
  position: relative;
  width: 240px;
  height: 240px;
  max-width: 100%;
}

.pomodoro-ring {
  width: 100%;
  height: 100%;
}

.pomodoro-ring-track {
  stroke: rgba(var(--v-theme-on-surface), 0.12);
}

.pomodoro-ring-progress {
  transition:
    stroke-dashoffset 0.2s linear,
    stroke 0.2s linear;
}

.pomodoro-readout {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  pointer-events: none;
}

.pomodoro-clock {
  font-size: 2.75rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
  color: rgb(var(--v-theme-on-surface));
}

.pomodoro-phase {
  font-size: 0.9375rem;
  color: rgb(var(--v-theme-on-surface-variant));
}

.pomodoro-chip {
  padding-block: 4px;
  min-height: 24px;
}
</style>
