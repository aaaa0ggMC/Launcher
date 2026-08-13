<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, inject } from 'vue'
import type { Ref } from 'vue'
import type { BtTaskInfo, BtOutputMessage } from '@shared/types'
import { translate, translateTemplate } from '../../../main/ui/i18n'
import SongGrid from './SongGrid.vue'
import type { PlaylistEntry } from '../types'

defineOptions({ name: 'AidjContinuousView' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tt = (key: string, vars: Record<string, string | number>, fallback?: string): string =>
  translateTemplate(
    uiLang.value,
    key,
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])) as Record<
      string,
      string
    >,
    fallback
  )

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
    peak_db: number | null
    rms_db: number | null
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
  recordFreq: boolean
} | null>(null)
const volume = ref<number | null>(null)
const tmpVolume = ref(50)
const takenByOthers = ref<string[]>([])
const switching = ref(false)
const reordering = ref(false)
const volumeMenu = ref(false)
const memoryConfirm = ref(false)
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
        recordFreq: boolean
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
            volbal: myTask.volbal ?? null,
            recordFreq: myTask.recordFreq ?? false
          }
        : null
      takenByOthers.value = list.tasks
        .filter((t) => t.taskId !== props.task?.id)
        .map((t) => t.player)
        .filter(Boolean)
      if (myTask) {
        const vr = (await window.cockpit
          .command('aidj.continuous-volume', { task: myTask.taskId })
          .catch(() => null)) as { ok?: boolean; volume?: number | null } | null
        if (vr?.ok && typeof vr.volume === 'number') volume.value = vr.volume
      }
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
// Status bar actions — live switches on THIS running task (no restart).
// Mirrors the main chat's status bar, plus a special volume state.
// ---------------------------------------------------------------------------

async function cycleVolbal(): Promise<void> {
  if (!props.task?.id) return
  const v = info.value?.volbal
  const enabled = v?.enabled ?? false
  const method = v?.method ?? 'lufs'
  // Cycle: off → lufs → linear → off
  let nextEnabled: boolean
  let nextMethod: string
  if (!enabled) {
    nextEnabled = true
    nextMethod = 'lufs'
  } else if (method === 'lufs') {
    nextEnabled = true
    nextMethod = 'linear'
  } else {
    nextEnabled = false
    nextMethod = 'lufs'
  }
  await window.cockpit.command('aidj.continuous-volbal', {
    task: props.task.id,
    enabled: nextEnabled,
    method: nextMethod
  })
  await refresh()
}

async function toggleRecordFreq(): Promise<void> {
  if (!props.task?.id) return
  await window.cockpit.command('aidj.continuous-recordfreq', {
    task: props.task.id,
    enabled: !(info.value?.recordFreq ?? false)
  })
  await refresh()
}

async function clearMemory(): Promise<void> {
  if (!props.task?.id) return
  memoryConfirm.value = false
  await window.cockpit.command('aidj.continuous-clear-memory', { task: props.task.id })
  await refresh()
}

// -- Volume slider: live on drag, commit + rebase on release -----------------
let volumeDebounce: ReturnType<typeof setTimeout> | null = null

function onVolumeChanging(pct: number): void {
  tmpVolume.value = pct
  if (volumeDebounce) clearTimeout(volumeDebounce)
  const v = pct / 100
  volumeDebounce = setTimeout(() => {
    if (!props.task?.id) return
    window.cockpit
      .command('aidj.continuous-volume', { task: props.task.id, set: v })
      .catch(() => {})
  }, 50)
}

async function commitVolume(pct: number): Promise<void> {
  if (volumeDebounce) {
    clearTimeout(volumeDebounce)
    volumeDebounce = null
  }
  if (!props.task?.id) return
  const v = pct / 100
  await window.cockpit.command('aidj.continuous-volume', { task: props.task.id, set: v })
  // Recalibrate the anchor: the user's chosen level becomes the new volbal
  // base — subsequent songs balance around this comfortable level.
  await window.cockpit.command('aidj.continuous-rebase', { task: props.task.id, base: v })
  volume.value = v
  volumeMenu.value = false
}

watch(volumeMenu, (open) => {
  if (open) tmpVolume.value = Math.round((volume.value ?? 0.5) * 100)
})

function volbalLabel(): string {
  const v = info.value?.volbal
  if (!v?.enabled) return 'off'
  return v.method
}

// ---------------------------------------------------------------------------
onMounted(() => {
  refresh()
  timer = setInterval(refresh, 2000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (volumeDebounce) clearTimeout(volumeDebounce)
})
</script>

<template>
  <div class="cv-root">
    <div class="d-flex flex-column h-100 cv-main">
      <!-- Row 1: [icon] 连续播放 [combo box right-aligned] -->
      <div class="d-flex align-center ga-2 cv-header">
        <v-icon size="18" color="primary">mdi-send-clock-outline</v-icon>
        <span class="text-body-2 font-weight-medium flex-shrink-0">{{
          t('aidj.continuous.title', '连续播放')
        }}</span>
        <v-spacer />
        <v-select
          :model-value="info?.player ?? null"
          :items="playerItems"
          :item-props="(item: any) => ({ disabled: item.raw?.disabled })"
          density="compact"
          variant="outlined"
          hide-details
          :loading="switching"
          :placeholder="t('aidj.continuous.player_placeholder', '选择播放器')"
          class="cv-player-select"
          :menu-props="{ contentClass: 'continuous-player-menu' }"
          @update:model-value="switchPlayer"
        >
          <template #append-item>
            <v-divider />
            <div class="text-caption text-medium-emphasis pa-2">
              {{ t('aidj.continuous.player_hint', '已被其他任务绑定的播放器置灰') }}
            </div>
          </template>
        </v-select>
        <v-chip size="small" variant="flat" color="primary" class="flex-shrink-0">
          {{ info?.played ?? 0 }} / {{ info?.total ?? 0 }}
        </v-chip>
      </div>

      <!-- Row 2: now playing / next on the left, queue count right-aligned -->
      <div class="d-flex flex-wrap ga-2 align-center cv-status">
        <span class="d-flex align-center ga-1">
          <v-icon size="14" color="success">mdi-play</v-icon>
          <span class="text-caption text-medium-emphasis flex-shrink-0">{{
            t('aidj.continuous.now_playing', '正在播放')
          }}</span>
          <span class="text-body-2 text-truncate cv-ellipsis">{{ info?.current || '—' }}</span>
        </span>
        <span class="d-flex align-center ga-1">
          <v-icon size="14" color="info">mdi-skip-next</v-icon>
          <span class="text-caption text-medium-emphasis flex-shrink-0">{{
            t('aidj.continuous.next', '下一首')
          }}</span>
          <span class="text-body-2 text-truncate cv-ellipsis">{{ info?.next || '—' }}</span>
        </span>
        <v-spacer />
        <span class="d-flex align-center ga-1">
          <v-icon size="14">mdi-queue-music</v-icon>
          <span class="text-caption text-medium-emphasis flex-shrink-0">{{
            t('aidj.continuous.queue', '队列')
          }}</span>
          <span class="text-body-2">{{
            tt(
              'aidj.continuous.pending',
              { n: (info?.total ?? 0) - (info?.played ?? 0) },
              '{n} 首待播'
            )
          }}</span>
        </span>
      </div>

      <v-divider class="my-2" />

      <!-- Queue grid — shared SongGrid with covers, reorder with animation.
           Fills all remaining width; scrolls internally when too many songs. -->
      <div class="cv-queue">
        <SongGrid
          :songs="info?.queue ?? []"
          :highlight-path="info?.currentPath ?? ''"
          show-covers
          @reorder="onReorder"
        />
      </div>

      <!-- Status bar — mirrors the main chat's status bar: clickable chips that
           switch live settings on THIS task. Volume is the special extra state. -->
      <div class="cv-statusbar d-flex flex-wrap ga-2 align-center mt-2">
        <span class="cv-status-label">
          <v-icon size="13" color="primary">mdi-tune</v-icon>
          <span class="ml-1">{{ t('aidj.continuous.session_settings', '会话设置') }}</span>
        </span>

        <v-chip
          variant="flat"
          size="small"
          class="status-chip clickable"
          :class="{ 'is-on': info?.volbal?.enabled }"
          :title="
            info?.volbal?.enabled
              ? t('aidj.continuous.volbal_off', '点击关闭响度平衡')
              : t('aidj.continuous.volbal_on', '点击开启响度平衡 (lufs)')
          "
          @click="cycleVolbal"
        >
          <span class="status-label">Volbal</span
          ><span class="status-value">{{ volbalLabel() }}</span>
        </v-chip>

        <v-chip
          variant="flat"
          size="small"
          class="status-chip clickable"
          :title="t('aidj.continuous.memory_reset', '点击重置已播记忆（从头重播）')"
          @click="memoryConfirm = true"
        >
          <span class="status-label">Memory</span
          ><span class="status-value">{{ info?.played ?? 0 }}</span>
        </v-chip>

        <v-chip
          variant="flat"
          size="small"
          class="status-chip clickable"
          :class="{ 'is-on': info?.recordFreq }"
          :title="
            info?.recordFreq
              ? t('aidj.continuous.freq_off', '点击关闭频率记录')
              : t('aidj.continuous.freq_on', '点击开启频率记录')
          "
          @click="toggleRecordFreq"
        >
          <span class="status-label">RecordFreq</span
          ><span class="status-value">{{ info?.recordFreq ? 'on' : 'off' }}</span>
        </v-chip>

        <v-spacer />

        <v-menu v-model="volumeMenu" :close-on-content-click="false" offset="6">
          <template #activator="{ props: mp }">
            <v-chip
              v-bind="mp"
              variant="flat"
              size="small"
              class="status-chip clickable"
              :prepend-icon="volume != null && volume < 0.01 ? 'mdi-volume-off' : 'mdi-volume-high'"
              :title="t('aidj.continuous.volume', '点击调整音量')"
            >
              <span class="status-label">Vol</span
              ><span class="status-value"
                >{{ volume != null ? Math.round(volume * 100) : '—' }}%</span
              >
            </v-chip>
          </template>
          <v-card width="220" rounded="lg">
            <v-card-text class="pa-3">
              <div class="text-caption text-medium-emphasis mb-1">
                {{ t('aidj.continuous.volume_hint', '音量（松手后重新校准响度基准）') }}
              </div>
              <v-slider
                :model-value="tmpVolume"
                :min="0"
                :max="100"
                :step="1"
                color="primary"
                thumb-label
                @update:model-value="onVolumeChanging($event as number)"
                @end="commitVolume(tmpVolume)"
              />
            </v-card-text>
          </v-card>
        </v-menu>
      </div>
    </div>

    <v-dialog v-model="memoryConfirm" width="420">
      <v-card rounded="lg">
        <v-card-title class="text-subtitle-1">
          <v-icon start>mdi-delete-sweep</v-icon>
          {{ t('aidj.continuous.reset_title', '重置已播记忆') }}
        </v-card-title>
        <v-card-text class="text-body-2">
          {{
            t(
              'aidj.continuous.reset_text',
              '确定要重置该会话的已播记忆吗？队列将从头（第 1 首）重新播放。'
            )
          }}
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="memoryConfirm = false">{{
            t('aidj.cancel', '取消')
          }}</v-btn>
          <v-btn color="primary" @click="clearMemory">{{
            t('aidj.continuous.reset', '重置')
          }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.cv-root {
  height: 100%;
  overflow: hidden;
  padding: 12px 16px;
}
.cv-main {
  gap: 2px;
  height: 100%;
  min-width: 0;
}
.cv-header {
  min-height: 32px;
}
.cv-player-select {
  width: 200px;
  max-width: 240px;
  flex-shrink: 0;
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
/* Queue fills all remaining height, scrolls internally when too many songs.
   overflow-x hidden kills the horizontal scrollbar; the song grid truncates
   long names so columns never outgrow the container. */
.cv-queue {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 4px;
}
.cv-queue::-webkit-scrollbar {
  width: 6px;
}
.cv-queue::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.45);
  border-radius: 3px;
}
.cv-statusbar {
  flex-shrink: 0;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.22);
  border-radius: 10px;
  padding: 6px 10px;
  background: rgba(var(--v-theme-surface-variant), 0.28);
}
.cv-status-label {
  display: inline-flex;
  align-items: center;
  font-size: 0.72rem;
  color: rgba(var(--v-theme-on-surface-variant), 0.85);
  margin-right: 2px;
}
.status-chip {
  padding-block: 4px;
  min-height: 24px;
}
.status-chip.clickable {
  cursor: pointer;
}
.status-chip.clickable:hover {
  filter: brightness(1.15);
}
.status-chip.is-on {
  background: rgba(var(--v-theme-success-container), 0.9);
  color: rgb(var(--v-theme-on-success-container));
}
.status-chip .status-label {
  opacity: 0.6;
  margin-right: 5px;
}
.status-chip .status-value {
  font-family: monospace;
  font-weight: 600;
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
