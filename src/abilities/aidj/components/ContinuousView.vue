<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, type CSSProperties } from 'vue'
import type { BtTaskInfo, BtOutputMessage } from '@shared/types'
import GameIcon from '../../../main/ui/components/GameIcon.vue'
import SongGrid from './SongGrid.vue'
import type { PlaylistEntry } from '../types'

defineOptions({ name: 'AidjContinuousView' })

const props = defineProps<{
  task?: BtTaskInfo | null
  messages?: BtOutputMessage[]
}>()

interface VolbalInfo {
  enabled: boolean
  method: string
  curve: number
  anchor: number | null
  baseVolume: number
  targetVolume: number | null
  currentLoudness: {
    peak_db: number
    rms_db: number
    integrated_lufs: number | null
  } | null
}

const players = ref<string[]>([])
const info = ref<{
  player: string
  current: string | null
  currentPath: string | null
  next: string | null
  played: number
  total: number
  queue: PlaylistEntry[]
  volbal: VolbalInfo | null
} | null>(null)
const takenByOthers = ref<string[]>([])
const switching = ref(false)
const reordering = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

function shortPlayer(name: string): string {
  const short = name.replace(/^org\.mpris\.MediaPlayer2\./, '')
  if (short.length <= 10) return short
  return short.slice(0, 5) + '…' + short.slice(-4)
}

const playerItems = computed(() =>
  players.value.map((p) => ({
    title: shortPlayer(p),
    value: p,
    disabled: p !== info.value?.player && takenByOthers.value.includes(p)
  }))
)

async function refresh(): Promise<void> {
  try {
    const pl = (await window.cockpit.command('aidj.list-players').catch(() => null)) as {
      ok?: boolean
      players?: string[]
    } | null
    const list = (await window.cockpit.command('aidj.continuous-list').catch(() => null)) as {
      ok?: boolean
      tasks?: {
        taskId: string
        player: string
        current: string | null
        currentPath: string | null
        next: string | null
        played: number
        total: number
        queue: { name: string; path: string }[]
        volbal: VolbalInfo | null
      }[]
    } | null
    if (pl?.ok && Array.isArray(pl.players)) players.value = pl.players
    if (list?.ok && Array.isArray(list.tasks)) {
      const myTask = list.tasks.find((t) => t.taskId === props.task?.id)
      info.value = myTask
        ? {
            player: myTask.player,
            current: myTask.current,
            currentPath: myTask.currentPath,
            next: myTask.next,
            played: myTask.played,
            total: myTask.total,
            queue: myTask.queue ?? [],
            volbal: myTask.volbal ?? null
          }
        : null
      takenByOthers.value = list.tasks
        .filter((t) => t.taskId !== props.task?.id)
        .map((t) => t.player)
        .filter(Boolean)
    }
  } catch {
    /* noop */
  }
}

async function switchPlayer(name: string): Promise<void> {
  if (!props.task?.id || switching.value || !name) return
  switching.value = true
  try {
    await window.cockpit.command('aidj.continuous-switch', {
      task: props.task.id,
      player: name
    })
    await refresh()
  } finally {
    switching.value = false
  }
}

async function onReorder(songs: PlaylistEntry[]): Promise<void> {
  if (!props.task?.id || reordering.value || !info.value) return
  reordering.value = true
  try {
    const r = (await window.cockpit.command('aidj.continuous-reorder', {
      task: props.task.id,
      songs: JSON.stringify(songs.map((s) => ({ name: s.name, path: s.path })))
    })) as { ok?: boolean; error?: string }
    if (!r?.ok) {
      /* surface via snackbar? bt panel has none — just fall back to poll */
    }
    await refresh()
  } finally {
    reordering.value = false
  }
}

// ---------------------------------------------------------------------------
// Fit-to-container: the whole view scales down (never scrolls) so it always
// fits the bounded detail area. Natural size is measured with the transform
// reset to none; when it fits we leave flex layout alone.
// ---------------------------------------------------------------------------
const rootEl = ref<HTMLElement | null>(null)
const scaleEl = ref<HTMLElement | null>(null)
const scale = ref(1)
const natSize = ref({ w: 0, h: 0 })
let ro: ResizeObserver | null = null
let fitRaf = 0

const scaleStyle = computed<CSSProperties>(() => {
  if (scale.value >= 1 || !natSize.value.w) return {}
  return {
    transform: `scale(${scale.value})`,
    transformOrigin: 'top left',
    width: `${natSize.value.w * scale.value}px`,
    height: `${natSize.value.h * scale.value}px`
  }
})

function applyFit(): void {
  const root = rootEl.value
  const sc = scaleEl.value
  if (!root || !sc) return
  cancelAnimationFrame(fitRaf)
  fitRaf = requestAnimationFrame(() => {
    sc.style.transform = 'none'
    sc.style.width = 'auto'
    sc.style.height = 'auto'
    void nextTick(() => {
      const natW = sc.offsetWidth
      const natH = sc.offsetHeight
      if (!natW || !natH) return
      natSize.value = { w: natW, h: natH }
      const rw = root.clientWidth
      const rh = root.clientHeight
      scale.value = Math.min(1, rw / natW, rh / natH)
    })
  })
}

// ---------------------------------------------------------------------------
// Dice placeholder (right column). Cycles dice.svg → dice-02.svg → dice-06.svg.
// Respects the modern-motion master switch (html.motion-off freezes the roll).
// ---------------------------------------------------------------------------
const diceFaces = ['dice', 'dice-02', 'dice-03', 'dice-04', 'dice-05', 'dice-06']
const diceFace = ref('dice')
let diceTimer: ReturnType<typeof setInterval> | null = null
let diceIdx = 0

function motionOn(): boolean {
  return !document.documentElement.classList.contains('motion-off')
}

function diceTick(): void {
  if (!motionOn()) return
  diceIdx = (diceIdx + 1) % diceFaces.length
  diceFace.value = diceFaces[diceIdx]
}

// ---------------------------------------------------------------------------
// VolBal panel helpers
// ---------------------------------------------------------------------------
function volbalUnit(): string {
  const v = info.value?.volbal
  if (!v) return 'LUFS'
  return v.method === 'lufs' ? 'LUFS' : 'dB'
}

function volbalCurrentLabel(): string {
  const v = info.value?.volbal
  const li = v?.currentLoudness
  if (!li) return '—'
  if (v?.method === 'lufs' && li.integrated_lufs != null) {
    return `${li.integrated_lufs.toFixed(1)} LUFS`
  }
  return `${li.rms_db.toFixed(1)} dB`
}

function volbalTargetLabel(): string {
  const v = info.value?.volbal
  if (!v || v.targetVolume == null) return '—'
  return `${Math.round(v.targetVolume * 100)}%`
}

// ---------------------------------------------------------------------------
onMounted(() => {
  refresh()
  timer = setInterval(refresh, 2000)
  ro = new ResizeObserver(applyFit)
  if (rootEl.value) ro.observe(rootEl.value)
  applyFit()
  diceTimer = setInterval(diceTick, 650)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (diceTimer) clearInterval(diceTimer)
  ro?.disconnect()
  cancelAnimationFrame(fitRaf)
})
</script>

<template>
  <div ref="rootEl" class="cv-root">
    <div ref="scaleEl" class="cv-scale" :style="scaleStyle">
      <div class="d-flex ga-4">
        <!-- LEFT: main control + queue + volbal -->
        <div class="d-flex flex-column flex-grow-1 min-w-0 cv-main">
          <!-- Row 1: [icon] 连续播放 [combo box] -->
          <div class="d-flex align-center ga-2 cv-header">
            <v-icon size="18" color="primary">mdi-send-clock-outline</v-icon>
            <span class="text-body-2 font-weight-medium flex-shrink-0">连续播放</span>
            <v-select
              :model-value="info?.player ?? null"
              :items="playerItems"
              :item-props="(item: any) => ({ disabled: item.raw?.disabled })"
              density="compact"
              variant="outlined"
              hide-details
              :loading="switching"
              placeholder="选择播放器"
              class="cv-player-select flex-grow-1"
              :menu-props="{ contentClass: 'continuous-player-menu' }"
              @update:model-value="switchPlayer"
            >
              <template #append-item>
                <v-divider />
                <div class="text-caption text-medium-emphasis pa-2">
                  已被其他任务绑定的播放器置灰
                </div>
              </template>
            </v-select>
            <v-chip size="small" variant="flat" color="primary" class="flex-shrink-0">
              {{ info?.played ?? 0 }} / {{ info?.total ?? 0 }}
            </v-chip>
          </div>

          <!-- Row 2: now playing / next / queue — wraps when tight -->
          <div class="d-flex flex-wrap ga-2 align-center cv-status">
            <span class="d-flex align-center ga-1">
              <v-icon size="14" color="success">mdi-play</v-icon>
              <span class="text-caption text-medium-emphasis flex-shrink-0">正在播放</span>
              <span class="text-body-2 text-truncate cv-ellipsis">{{ info?.current || '—' }}</span>
            </span>
            <span class="d-flex align-center ga-1">
              <v-icon size="14" color="info">mdi-skip-next</v-icon>
              <span class="text-caption text-medium-emphasis flex-shrink-0">下一首</span>
              <span class="text-body-2 text-truncate cv-ellipsis">{{ info?.next || '—' }}</span>
            </span>
            <span class="d-flex align-center ga-1">
              <v-icon size="14">mdi-queue-music</v-icon>
              <span class="text-caption text-medium-emphasis flex-shrink-0">队列</span>
              <span class="text-body-2">{{ (info?.total ?? 0) - (info?.played ?? 0) }} 首待播</span>
            </span>
          </div>

          <v-divider class="my-2" />

          <!-- Queue grid (3/4 vertical) — shared SongGrid, reorder with animation -->
          <div class="cv-queue flex-grow-1 min-h-0">
            <SongGrid
              :songs="info?.queue ?? []"
              :highlight-path="info?.currentPath ?? ''"
              @reorder="onReorder"
            />
          </div>

          <!-- VolBal status (1/4) — verbose-style telemetry -->
          <div class="cv-volbal mt-2">
            <div class="d-flex align-center ga-2 mb-1">
              <v-icon size="14" color="primary">mdi-format-color-marker</v-icon>
              <span class="text-caption font-weight-medium">VolBal</span>
              <v-chip
                size="x-small"
                variant="flat"
                :color="info?.volbal?.enabled ? 'success' : 'default'"
              >
                {{ info?.volbal?.enabled ? 'ON' : 'OFF' }}
              </v-chip>
              <span class="text-caption text-medium-emphasis">
                {{ info?.volbal?.method ?? 'lufs' }} · curve {{ info?.volbal?.curve ?? 3 }}
              </span>
              <v-spacer />
              <span class="text-caption text-medium-emphasis">
                Anchor {{ info?.volbal?.anchor != null ? info.volbal.anchor.toFixed(1) : '—' }}
                {{ volbalUnit() }} · Base {{ Math.round((info?.volbal?.baseVolume ?? 0.5) * 100) }}%
              </span>
            </div>
            <div class="d-flex flex-wrap ga-2 align-center">
              <v-chip size="x-small" variant="flat" color="primary-container">
                当前 {{ volbalCurrentLabel() }}
              </v-chip>
              <v-chip size="x-small" variant="flat" color="success-container">
                目标音量 {{ volbalTargetLabel() }}
              </v-chip>
              <span class="text-caption text-medium-emphasis cv-ellipsis">
                {{ info?.current || '—' }}
              </span>
            </div>
          </div>
        </div>

        <!-- RIGHT: dice animation placeholder -->
        <div class="cv-side flex-shrink-0 d-flex align-center justify-center">
          <div class="cv-dice">
            <div :key="diceFace" class="cv-dice-face">
              <GameIcon :name="diceFace" :size="72" />
            </div>
            <div class="text-caption text-medium-emphasis text-center mt-2">占位</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cv-root {
  height: 100%;
  overflow: hidden;
  position: relative;
  padding: 12px 16px;
}
.cv-scale {
  will-change: transform;
}
.cv-main {
  gap: 2px;
}
.cv-player-select {
  max-width: 260px;
  min-width: 140px;
}
.cv-player-select :deep(.v-field) {
  font-size: 0.78rem;
  min-height: 30px;
}
.cv-player-select :deep(.v-select__selection) {
  font-size: 0.78rem;
}
.cv-ellipsis {
  max-width: 220px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cv-queue {
  min-height: 0;
}
.cv-volbal {
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.22);
  border-radius: 10px;
  padding: 6px 10px;
  background: rgba(var(--v-theme-surface-variant), 0.28);
}
.cv-side {
  width: 130px;
  border-left: 1px solid rgba(var(--v-theme-surface-bright), 0.14);
}
.cv-dice {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  color: rgba(var(--v-theme-primary), 0.9);
}
.cv-dice-face {
  animation: dice-roll 0.6s ease-out;
}
@keyframes dice-roll {
  0% {
    transform: rotate(0deg) scale(0.6);
    opacity: 0;
  }
  60% {
    transform: rotate(340deg) scale(1.05);
    opacity: 1;
  }
  100% {
    transform: rotate(360deg) scale(1);
  }
}
</style>

<style>
.continuous-player-menu .v-list-item {
  min-height: 30px;
  font-size: 0.8rem;
}
.continuous-player-menu .v-list-item__content {
  padding: 4px 0;
}
</style>
