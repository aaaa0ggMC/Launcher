<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import type { BtTaskInfo, BtOutputMessage } from '@shared/types'

defineOptions({ name: 'AidjContinuousView' })

const props = defineProps<{
  task?: BtTaskInfo | null
  messages?: BtOutputMessage[]
}>()

const players = ref<string[]>([])
const info = ref<{
  player: string
  current: string | null
  next: string | null
  played: number
  total: number
} | null>(null)
const takenByOthers = ref<string[]>([])
const switching = ref(false)
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
        next: string | null
        played: number
        total: number
      }[]
    } | null
    if (pl?.ok && Array.isArray(pl.players)) players.value = pl.players
    if (list?.ok && Array.isArray(list.tasks)) {
      const myTask = list.tasks.find((t) => t.taskId === props.task?.id)
      info.value = myTask
        ? {
            player: myTask.player,
            current: myTask.current,
            next: myTask.next,
            played: myTask.played,
            total: myTask.total
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
  if (!props.task?.id || switching.value) return
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

onMounted(() => {
  refresh()
  timer = setInterval(refresh, 2000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="d-flex flex-column ga-2 pa-3" style="height: 100%">
    <div class="d-flex align-center ga-2">
      <v-icon size="18" color="primary">mdi-send-clock-outline</v-icon>
      <span class="text-body-2 font-weight-medium">连续播放</span>
      <v-spacer />
      <v-chip size="small" variant="flat" color="primary">
        {{ info?.played ?? 0 }} / {{ info?.total ?? 0 }}
      </v-chip>
    </div>

    <v-select
      :model-value="info?.player ?? null"
      :items="playerItems"
      :item-props="(item: any) => ({ disabled: item.raw?.disabled })"
      density="compact"
      variant="outlined"
      hide-details
      :loading="switching"
      placeholder="选择播放器"
      label="播放器"
      class="continuous-player-select"
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

    <v-divider />

    <div class="d-flex flex-column ga-2">
      <div class="d-flex align-center ga-2">
        <v-icon size="16" color="success">mdi-play</v-icon>
        <span class="text-caption text-medium-emphasis" style="width: 5em">正在播放</span>
        <span class="text-body-2 text-truncate">{{ info?.current || '—' }}</span>
      </div>
      <div class="d-flex align-center ga-2">
        <v-icon size="16" color="info">mdi-skip-next</v-icon>
        <span class="text-caption text-medium-emphasis" style="width: 5em">下一首</span>
        <span class="text-body-2 text-truncate">{{ info?.next || '—' }}</span>
      </div>
      <div class="d-flex align-center ga-2">
        <v-icon size="16">mdi-queue-music</v-icon>
        <span class="text-caption text-medium-emphasis" style="width: 5em">队列</span>
        <span class="text-body-2">{{ (info?.total ?? 0) - (info?.played ?? 0) }} 首待播</span>
      </div>
    </div>

    <div class="text-caption text-medium-emphasis mt-auto">
      停止任务后从后台面板操作
    </div>
  </div>
</template>

<style scoped>
.continuous-player-select {
  max-width: 220px;
}
.continuous-player-select :deep(.v-field) {
  font-size: 0.8rem;
  min-height: 32px;
}
.continuous-player-select :deep(.v-select__selection) {
  font-size: 0.8rem;
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
