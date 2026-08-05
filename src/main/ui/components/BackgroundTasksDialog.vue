<script setup lang="ts">
import { ref, shallowRef, computed, inject, nextTick, watch, onMounted, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import type { BtTaskInfo, BtStats } from '@shared/types'
import { translate, translateTemplate } from '@ui/i18n'
import { scoreFields } from '@ui/composables/search'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const uiLang = inject<Ref<string>>('cockpit:lang', ref('zh'))
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const te = (key: string, vars: Record<string, string>, fallback?: string): string =>
  translateTemplate(uiLang.value, key, vars, fallback)

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

// ---------------------------------------------------------------------------
// Task list state
// ---------------------------------------------------------------------------
const tasks = shallowRef<BtTaskInfo[]>([])
const selectedId = ref<string | null>(null)
const lines = shallowRef<Record<string, { stream: 'stdout' | 'stderr'; line: string }[]>>({})
const MAX_LINES = 2000
const searchText = ref('')
const statusFilter = ref<'' | BtTaskInfo['status']>('')

const selected = computed(() => tasks.value.find((x) => x.id === selectedId.value) ?? null)
const runningCount = computed(() => tasks.value.filter((x) => x.status === 'running').length)
const finishedCount = computed(() => tasks.value.filter((x) => x.status !== 'running').length)
const clearing = ref(false)

/** Status filter options, matching the logs ability's level-select style. */
const statusOptions = computed(() => [
  { title: t('bt.filterAll'), value: '' },
  { title: t('bt.status.running'), value: 'running' },
  { title: t('bt.status.exited'), value: 'exited' },
  { title: t('bt.status.stopped'), value: 'stopped' },
  { title: t('bt.status.error'), value: 'error' },
  { title: t('bt.status.cancelled'), value: 'cancelled' }
])

/**
 * Display order: running tasks first, then by name (case-insensitive).
 * A secondary sort by status keeps stopped/exited/error grouped cleanly.
 * Search is the shared weighted AND mechanism (name > description > command
 * > kind/pid); the status dropdown further narrows the set.
 */
const sortedTasks = computed<BtTaskInfo[]>(() => {
  const filter = statusFilter.value
  return [...tasks.value]
    .filter(
      (t) =>
        scoreFields(searchText.value, [
          { text: t.name.toLowerCase(), weight: 3 },
          { text: (t.description ?? '').toLowerCase(), weight: 2 },
          { text: (t.command ?? '').toLowerCase(), weight: 2 },
          { text: t.kind.toLowerCase(), weight: 1 },
          { text: t.pid ? String(t.pid) : '', weight: 1 }
        ]) > 0 &&
        (!filter || t.status === filter)
    )
    .sort((a, b) => {
      const aRun = a.status === 'running' ? 0 : 1
      const bRun = b.status === 'running' ? 0 : 1
      if (aRun !== bRun) return aRun - bRun
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      if (byName !== 0) return byName
      return a.status.localeCompare(b.status)
    })
})

/** Remove every stopped/finished task from the list at once. */
async function clearFinished(): Promise<void> {
  if (!finishedCount.value) return
  clearing.value = true
  try {
    const res = (await window.cockpit.btClearFinished()) as {
      ok?: boolean
      removed?: number
      error?: string
    } | null
    if (res && res.ok) {
      const removedIds = new Set(tasks.value.filter((x) => x.status !== 'running').map((x) => x.id))
      if (selectedId.value && removedIds.has(selectedId.value)) selectedId.value = null
    }
  } finally {
    clearing.value = false
  }
}

function pushLine(id: string, stream: 'stdout' | 'stderr', line: string): void {
  pushLines(id, [{ stream, line }])
}

/** Append a batch of lines to a task's console buffer (rendered together). */
function pushLines(id: string, batch: { stream: 'stdout' | 'stderr'; line: string }[]): void {
  if (!batch.length) return
  const cur = lines.value[id] ?? []
  cur.push(...batch)
  if (cur.length > MAX_LINES) cur.splice(0, cur.length - MAX_LINES)
  lines.value = { ...lines.value, [id]: cur }
}

// ---------------------------------------------------------------------------
// Events from the framework service (cockpit:bt)
// ---------------------------------------------------------------------------
function onBtEvent(raw: unknown): void {
  try {
    const evt = raw as
      | { type: 'changed'; tasks: BtTaskInfo[] }
      | { type: 'output'; id: string; lines: { stream: 'stdout' | 'stderr'; line: string }[] }
      | { type: 'exit'; id: string; code: number | null }
    if (!evt || typeof evt.type !== 'string') return
    if (evt.type === 'changed') {
      tasks.value = evt.tasks
      // drop line buffers for tasks that no longer exist
      const alive = new Set(evt.tasks.map((x) => x.id))
      const stale = Object.keys(lines.value).filter((id) => !alive.has(id))
      if (stale.length) {
        const next = { ...lines.value }
        for (const id of stale) delete next[id]
        lines.value = next
      }
      if (selectedId.value && !evt.tasks.some((x) => x.id === selectedId.value)) {
        selectedId.value = null
      }
      return
    }
    if (evt.type === 'output') {
      // batched: main process coalesces per-line output into 100ms chunks
      if (evt.lines?.length) pushLines(evt.id, evt.lines)
      return
    }
    if (evt.type === 'exit') {
      // the 'changed' event right after updates status; nothing extra needed
    }
  } catch {
    // never let a display bug re-enter the pipeline
  }
}

// ---------------------------------------------------------------------------
// Detail / console
// ---------------------------------------------------------------------------
const consoleEl = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const inputText = ref('')
const busy = ref(false)

const selectedLines = computed(() => lines.value[selectedId.value ?? ''] ?? [])

async function selectTask(id: string): Promise<void> {
  selectedId.value = id
  await nextTick()
  scrollConsole()
  // Backfill from the service ring buffer (covers lines emitted while the
  // panel was closed / before mount). Replace only when it's strictly longer,
  // so live lines that raced in are never lost.
  const res = (await window.cockpit.btOutput(id)) as {
    ok?: boolean
    lines?: { stream: 'stdout' | 'stderr'; line: string }[]
  } | null
  if (!res?.ok || !res.lines) return
  if ((res.lines.length ?? 0) >= (lines.value[id]?.length ?? 0)) {
    lines.value = { ...lines.value, [id]: [...res.lines] }
    await nextTick()
    scrollConsole()
  }
}

function scrollConsole(): void {
  if (autoScroll.value && consoleEl.value) {
    consoleEl.value.scrollTop = consoleEl.value.scrollHeight
  }
}

function onConsoleScroll(): void {
  const el = consoleEl.value
  if (!el) return
  autoScroll.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
}

function clearConsole(): void {
  lines.value = { ...lines.value, [selectedId.value ?? '']: [] }
}

const exporting = ref(false)
const exportSnackOpen = ref(false)
const exportSnackText = ref('')

/** Export the selected task's full output to a text file via the native dialog. */
async function exportConsole(): Promise<void> {
  const id = selectedId.value
  if (!id) return
  exporting.value = true
  try {
    const defaultName = `${(selected.value?.name ?? 'task').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')}-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, '-')}.log`
    const path = await window.cockpit.pickSaveFile({
      title: t('bt.exportTitle'),
      defaultPath: defaultName,
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }]
    })
    if (!path) return
    // CLI-first: export through the registered command (main process writes the
    // authoritative buffered output), like ft.export / logs.export.
    const res = (await window.cockpit.btExport(id, path)) as {
      ok?: boolean
      lines?: number
      error?: string
    } | null
    if (!res?.ok) throw new Error(res?.error ?? t('bt.exportFailed'))
    exportSnackText.value = te('bt.exported', { name: selected.value?.name ?? '' })
    exportSnackOpen.value = true
  } catch (e) {
    exportSnackText.value = e instanceof Error ? e.message : String(e)
    exportSnackOpen.value = true
  } finally {
    exporting.value = false
  }
}

// ---------------------------------------------------------------------------
// Interaction: stdin writes + signals (Ctrl+C → SIGINT, Ctrl+D → EOF)
// ---------------------------------------------------------------------------
async function sendInput(text: string): Promise<void> {
  if (!selectedId.value || !text) return
  await window.cockpit.btInput(selectedId.value, text)
}

function onInputEnter(): void {
  if (!selectedId.value) return
  const data = inputText.value + '\n'
  void sendInput(data)
  // mirror the sent line into the console as a prompt echo
  pushLine(selectedId.value, 'stdout', `> ${inputText.value}`)
  inputText.value = ''
  void nextTick(() => scrollConsole())
}

function onInputCtrlC(): void {
  if (!selectedId.value) return
  void window.cockpit.btSignal(selectedId.value, 'SIGINT')
  pushLine(selectedId.value, 'stdout', '^C')
  void nextTick(() => scrollConsole())
}

function onInputCtrlD(): void {
  if (!selectedId.value) return
  // 0x04 = EOF on a tty; node's readline treats it as line-end/close signal.
  void window.cockpit.btInput(selectedId.value, '\u0004')
}

async function stopSelected(): Promise<void> {
  if (!selectedId.value) return
  busy.value = true
  try {
    await window.cockpit.btStop(selectedId.value)
  } finally {
    busy.value = false
  }
}

async function killSelected(): Promise<void> {
  if (!selectedId.value) return
  await window.cockpit.btKill(selectedId.value)
}

async function removeSelected(): Promise<void> {
  if (!selectedId.value) return
  await window.cockpit.btRemove(selectedId.value)
  selectedId.value = null
}

// ---------------------------------------------------------------------------
// Status / stats helpers
// ---------------------------------------------------------------------------
function statusColor(s: BtTaskInfo['status']): string {
  switch (s) {
    case 'running':
      return 'primary'
    case 'exited':
      return 'success'
    case 'error':
      return 'error'
    case 'cancelled':
    case 'stopped':
      return 'warning'
    default:
      return 'default'
  }
}

function statusLabel(s: BtTaskInfo['status']): string {
  switch (s) {
    case 'running':
      return t('bt.status.running')
    case 'exited':
      return t('bt.status.exited')
    case 'error':
      return t('bt.status.error')
    case 'cancelled':
      return t('bt.status.cancelled')
    case 'stopped':
      return t('bt.status.stopped')
    default:
      return s
  }
}

function kindLabel(k: BtTaskInfo['kind']): string {
  return k === 'process' ? t('bt.kind.process') : t('bt.kind.job')
}

function fmtMem(mb?: number): string {
  if (mb === undefined) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

/** Elapsed time: frozen at endedAt for finished tasks, ticking for running ones. */
function fmtElapsed(startedAt: number, endedAt: number | undefined, nowVal: number): string {
  const end = endedAt ?? nowVal
  const s = Math.max(0, Math.floor((end - startedAt) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function statsChips(s: BtStats): { icon: string; text: string }[] {
  return [
    { icon: 'mdi-speedometer', text: s.cpu !== undefined ? `${s.cpu}%` : '—' },
    { icon: 'mdi-memory', text: fmtMem(s.mem) },
    { icon: 'mdi-video-input-component', text: s.gpu !== undefined ? `${s.gpu} MB` : '—' }
  ]
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let unsub: (() => void) | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
const now = ref(Date.now())

async function refresh(): Promise<void> {
  tasks.value = await window.cockpit.btList()
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      void refresh()
      clockTimer = setInterval(() => (now.value = Date.now()), 1000)
    } else if (clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
)

// subscribe once at mount so live output is never missed even while closed
onMounted(() => {
  unsub = window.cockpit.on('cockpit:bt', onBtEvent)
  void refresh()
})
onBeforeUnmount(() => {
  unsub?.()
  if (clockTimer) clearInterval(clockTimer)
})
</script>

<template>
  <v-dialog v-model="visible" content-class="bt-overlay" scrim="rgba(13, 17, 23, 0.45)">
    <v-card class="bt-dialog" rounded="xl">
      <v-card-title class="d-flex align-center ga-3 text-subtitle-1 px-5 pt-4 pb-3">
        <v-icon color="primary">mdi-tray-full</v-icon>
        <span class="text-body-1 font-weight-medium">{{ t('bt.dialogTitle') }}</span>
        <v-chip v-if="runningCount" variant="tonal" color="primary" class="bt-title-chip">
          {{ te('bt.runningCount', { n: String(runningCount) }) }}
        </v-chip>
        <v-spacer />
        <v-tooltip v-if="finishedCount > 0" :text="t('bt.clearFinishedTip')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn
              v-bind="tp"
              variant="tonal"
              color="secondary"
              prepend-icon="mdi-archive-off-outline"
              :disabled="clearing"
              @click="clearFinished"
            >
              {{ te('bt.clearFinished', { n: String(finishedCount) }) }}
            </v-btn>
          </template>
        </v-tooltip>
        <v-tooltip :text="t('bt.tooltip')" location="bottom">
          <template #activator="{ props: tp }">
            <v-btn v-bind="tp" variant="text" icon @click="visible = false">
              <v-icon>mdi-close</v-icon>
            </v-btn>
          </template>
        </v-tooltip>
      </v-card-title>

      <v-divider />

      <div class="bt-body">
        <!-- Task list -->
        <div class="bt-list">
          <div class="px-3 pt-3 d-flex align-center ga-2">
            <v-text-field
              v-model="searchText"
              prepend-inner-icon="mdi-magnify"
              :placeholder="t('bt.searchPlaceholder')"
              density="compact"
              variant="solo-filled"
              flat
              hide-details
              clearable
              rounded="lg"
              class="flex-grow-1"
            />
            <v-select
              v-model="statusFilter"
              :items="statusOptions"
              density="compact"
              variant="solo-filled"
              flat
              hide-details
              attach
              :menu-props="{ maxHeight: 200, contentClass: 'bt-filter-menu' }"
              class="bt-filter"
            />
          </div>
          <v-list v-if="sortedTasks.length" density="compact" class="pa-2">
            <v-list-item
              v-for="task in sortedTasks"
              :key="task.id"
              :active="selectedId === task.id"
              rounded="lg"
              class="mb-1 px-1"
              @click="selectTask(task.id)"
            >
              <v-list-item-title class="d-flex align-center ga-2">
                <span class="text-truncate">{{ task.name }}</span>
                <v-chip
                  variant="tonal"
                  :color="statusColor(task.status)"
                  class="ml-auto bt-status-chip"
                >
                  {{ statusLabel(task.status) }}
                </v-chip>
              </v-list-item-title>
              <v-list-item-subtitle v-if="task.description" class="text-truncate mt-1">
                {{ task.description }}
              </v-list-item-subtitle>
              <v-list-item-subtitle class="d-flex align-center ga-2 mt-1">
                <span class="text-caption on-surface-variant">{{ kindLabel(task.kind) }}</span>
                <span v-if="task.pid" class="text-caption on-surface-variant font-family-mono">
                  pid {{ task.pid }}
                </span>
                <span class="text-caption on-surface-variant ml-auto">{{
                  fmtElapsed(task.startedAt, task.endedAt, now)
                }}</span>
              </v-list-item-subtitle>
              <template v-if="task.status === 'running'" #append>
                <div class="d-flex flex-column align-end ga-1 mr-1">
                  <v-chip
                    v-for="c in statsChips(task.stats)"
                    :key="c.icon"
                    variant="flat"
                    color="secondary-container"
                    :prepend-icon="c.icon"
                    class="bt-stat-chip"
                  >
                    {{ c.text }}
                  </v-chip>
                </div>
              </template>
            </v-list-item>
          </v-list>
          <v-empty-state
            v-if="tasks.length === 0"
            icon="mdi-tray-full"
            :title="t('bt.empty')"
            :text="t('bt.emptyText')"
            class="mt-8"
          />
          <v-empty-state
            v-else-if="sortedTasks.length === 0"
            icon="mdi-magnify-close"
            :title="t('bt.noMatch')"
            :text="t('bt.noMatchText')"
            class="mt-8"
          />
        </div>

        <v-divider vertical />

        <!-- Detail: console + interaction -->
        <div class="bt-detail">
          <template v-if="selected">
            <div class="d-flex align-center ga-2 px-4 pt-3 pb-3 flex-wrap">
              <span class="text-subtitle-2 font-weight-medium">{{ selected.name }}</span>
              <v-chip variant="tonal" :color="statusColor(selected.status)">
                {{ statusLabel(selected.status) }}
              </v-chip>
              <template v-if="selected.kind === 'job' && selected.progress !== undefined">
                <v-progress-linear
                  :model-value="selected.progress"
                  color="primary"
                  height="6"
                  rounded
                  class="bt-progress"
                />
              </template>
              <v-spacer />

              <!-- view tools (icon-only, compact) -->
              <div class="d-flex align-center ga-1">
                <v-tooltip :text="t('bt.autoscroll')" location="bottom">
                  <template #activator="{ props: tp }">
                    <v-btn
                      v-bind="tp"
                      size="small"
                      variant="flat"
                      :color="autoScroll ? 'primary' : ''"
                      icon
                      @click="autoScroll = !autoScroll"
                    >
                      <v-icon size="small">mdi-arrow-down-bold-box-outline</v-icon>
                    </v-btn>
                  </template>
                </v-tooltip>
                <v-tooltip :text="t('bt.clear')" location="bottom">
                  <template #activator="{ props: tp }">
                    <v-btn v-bind="tp" size="small" variant="flat" icon @click="clearConsole">
                      <v-icon size="small">mdi-broom</v-icon>
                    </v-btn>
                  </template>
                </v-tooltip>
                <v-tooltip :text="t('bt.export')" location="bottom">
                  <template #activator="{ props: tp }">
                    <v-btn
                      v-bind="tp"
                      size="small"
                      variant="flat"
                      :loading="exporting"
                      icon
                      @click="exportConsole"
                    >
                      <v-icon size="small">mdi-export</v-icon>
                    </v-btn>
                  </template>
                </v-tooltip>
              </div>

              <!-- lifecycle actions (text buttons, separated) -->
              <div class="d-flex align-center ga-2">
                <v-btn
                  v-if="selected.kind === 'process' && selected.status === 'running'"
                  variant="tonal"
                  color="warning"
                  prepend-icon="mdi-stop-circle-outline"
                  :loading="busy"
                  @click="stopSelected"
                >
                  {{ t('bt.stop') }}
                </v-btn>
                <v-btn
                  v-if="selected.kind === 'process' && selected.status === 'running'"
                  variant="tonal"
                  color="error"
                  prepend-icon="mdi-close-octagon-outline"
                  @click="killSelected"
                >
                  {{ t('bt.kill') }}
                </v-btn>
                <v-btn
                  v-if="selected.status !== 'running'"
                  variant="tonal"
                  prepend-icon="mdi-archive-arrow-up-outline"
                  @click="removeSelected"
                >
                  {{ t('bt.remove') }}
                </v-btn>
              </div>
            </div>

            <div v-if="selected.command" class="px-4 pb-3">
              <span class="text-caption on-surface-variant font-family-mono bt-cmd">{{
                selected.command
              }}</span>
            </div>

            <v-divider />

            <div class="bt-console-wrap">
              <div ref="consoleEl" class="bt-console" @scroll.passive="onConsoleScroll">
                <div
                  v-for="(l, i) in selectedLines"
                  :key="i"
                  class="bt-line"
                  :class="l.stream === 'stderr' ? 'bt-line--err' : ''"
                >
                  {{ l.line }}
                </div>
                <div v-if="selectedLines.length === 0" class="on-surface-variant text-caption pa-2">
                  {{ t('bt.noOutput') }}
                </div>
              </div>
            </div>

            <!-- interactive input for running process tasks -->
            <div
              v-if="selected.kind === 'process' && selected.status === 'running'"
              class="d-flex align-center ga-2 px-4 py-4 bt-input-row"
            >
              <v-tooltip :text="t('bt.ctrlC')" location="top">
                <template #activator="{ props: tp }">
                  <v-btn
                    v-bind="tp"
                    variant="tonal"
                    color="warning"
                    prepend-icon="mdi-console"
                    @click="onInputCtrlC"
                  >
                    ^C
                  </v-btn>
                </template>
              </v-tooltip>
              <v-btn variant="tonal" :title="t('bt.ctrlD')" @click="onInputCtrlD"> ^D </v-btn>
              <v-text-field
                v-model="inputText"
                :placeholder="t('bt.inputPlaceholder')"
                density="compact"
                variant="solo-filled"
                flat
                hide-details
                clearable
                class="flex-grow-1"
                @keydown.enter.prevent="onInputEnter"
                @keydown.ctrl.c.prevent="onInputCtrlC"
                @keydown.ctrl.d.prevent="onInputCtrlD"
              />
              <v-btn
                variant="tonal"
                color="primary"
                prepend-icon="mdi-send"
                :disabled="!inputText.trim()"
                @click="onInputEnter"
              >
                {{ t('bt.send') }}
              </v-btn>
            </div>
          </template>

          <div v-else class="d-flex flex-column align-center justify-center h-100 ga-2">
            <v-icon size="48" class="on-surface-variant">mdi-tray-full</v-icon>
            <span class="text-caption on-surface-variant">{{ t('bt.noSelect') }}</span>
          </div>
        </div>
      </div>

      <v-snackbar v-model="exportSnackOpen" :timeout="2500" color="success" location="top">
        {{ exportSnackText }}
      </v-snackbar>
    </v-card>
  </v-dialog>
</template>

<style scoped>
/* Fuse-color translucency: panels follow the app's translucent chrome
   (surface at low alpha + backdrop blur) so the background/fuse shows through. */
.bt-dialog {
  height: 100%;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  background: rgba(var(--v-theme-surface), 0.55) !important;
  backdrop-filter: blur(18px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.32);
}
.bt-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.bt-list {
  width: 320px;
  flex-shrink: 0;
  overflow-y: auto;
  border-right: 1px solid rgba(var(--v-theme-surface-bright), 0.12);
}
.bt-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.bt-progress {
  width: 140px;
}
.bt-cmd {
  word-break: break-all;
}
.bt-console-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  margin: 0 16px 0 16px;
}
.bt-console {
  height: 100%;
  overflow-y: auto;
  background: rgba(var(--v-theme-surface), 0.35);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
  border-radius: 12px;
  padding: 8px 10px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.8rem;
  line-height: 1.5;
}
.bt-line {
  color: rgba(var(--v-theme-on-surface), 0.92);
  white-space: pre-wrap;
  word-break: break-all;
}
.bt-line--err {
  color: rgb(var(--v-theme-error));
}
.bt-input-row {
  border-top: 1px solid rgba(var(--v-theme-surface-bright), 0.12);
}
.bt-stat-chip {
  max-width: 130px;
}
/* Chips in this panel get comfortable vertical padding — the default x-small
   density crams the label against the chip top/bottom. */
.bt-status-chip,
.bt-stat-chip,
.bt-title-chip {
  padding-block: 4px;
  min-height: 24px;
}
.bt-stat-chip {
  padding-inline: 8px;
}
.bt-filter {
  width: 96px;
  min-width: 96px;
  max-width: 96px;
  flex-shrink: 0;
}
.bt-filter :deep(.v-field) {
  min-height: 32px;
}
.bt-filter :deep(.v-field__field) {
  min-height: 32px;
}
.bt-filter :deep(.v-field__input) {
  justify-content: center;
  align-items: center;
  text-align: center;
  font-size: 0.85rem;
  line-height: 1;
}
.bt-filter :deep(.v-field__input input) {
  font-size: 0.85rem;
}
.bt-filter :deep(.v-field__append-inner .v-icon) {
  font-size: 0.85rem;
  opacity: 0.6;
}
.bt-filter :deep(.v-list-item__content) {
  text-align: center;
}

/* Custom WebKit scrollbars matching the app chrome (global.css) — do NOT use
   scrollbar-width/scrollbar-color, they switch to the native GTK model and
   ignore ::-webkit-scrollbar entirely. */
.bt-list::-webkit-scrollbar,
.bt-console::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.bt-list::-webkit-scrollbar-track,
.bt-console::-webkit-scrollbar-track {
  background: transparent;
}
.bt-list::-webkit-scrollbar-button,
.bt-console::-webkit-scrollbar-button {
  display: none;
  width: 0;
  height: 0;
}
.bt-list::-webkit-scrollbar-thumb,
.bt-console::-webkit-scrollbar-thumb {
  background-color: rgba(var(--v-theme-surface-bright), 0.55);
  background-clip: padding-box;
  border: 2px solid transparent;
  border-radius: 6px;
}
.bt-list::-webkit-scrollbar-thumb:hover,
.bt-console::-webkit-scrollbar-thumb:hover {
  background-color: rgba(var(--v-theme-on-surface-variant), 0.4);
}
</style>

<!-- Global styles: the filter dropdown menu teleports to body (attach), so its
     item sizing must live outside the scoped scope. Compact so it never
     dominates the panel. -->
<style>
.bt-filter-menu {
  max-width: 120px;
  min-width: 96px;
}
.bt-filter-menu .v-list-item {
  min-height: 28px;
}
.bt-filter-menu .v-list-item-title {
  font-size: 0.78rem;
}
</style>

<!-- Global styles: v-dialog content teleports to <body>, so its overlay slot
     must be sized outside the scoped scope. The panel fills ~92% of the page.
     !important beats Vuetify's `.v-dialog > .v-overlay__content` max-height. -->
<style>
.v-dialog > .bt-overlay {
  width: 90% !important;
  max-width: 1600px !important;
  height: 92vh !important;
  max-height: 92vh !important;
}
</style>
