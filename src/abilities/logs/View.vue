<script setup lang="ts">
defineOptions({ name: 'cockpit-logs' })

import { ref, shallowRef, computed, watch, inject, onMounted, onBeforeUnmount, nextTick } from 'vue'
import type { Ref } from 'vue'
import type { LogEntry, LogLevel, LogQueryResult } from './types'
import { translate, translateTemplate } from '@ui/i18n'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const te = (key: string, vars: Record<string, string>, fallback?: string): string =>
  translateTemplate(uiLang.value, key, vars, fallback)

const level = ref<'' | LogLevel>('')
const ignoreSelf = ref(true) // hide the logs ability's own log entries by default

const PAGE = 300
const entries = shallowRef<LogEntry[]>([])
const total = ref(0)
const busy = ref(false)
const scrolledToBottom = ref(true)

const hasOlder = computed(() => entries.value.length < total.value)
const queryParams = computed(() => ({
  level: level.value || undefined,
  excludeSelf: ignoreSelf.value || undefined
}))
const levelOptions = computed(() => [
  { title: t('logs.levelAll'), value: '' },
  { title: 'DEBUG', value: 'debug' },
  { title: 'INFO', value: 'info' },
  { title: 'WARN', value: 'warn' },
  { title: 'ERROR', value: 'error' }
])

// ---------------------------------------------------------------------------
// Sliding-window loading: last page first, page backward on scroll-to-top,
// live entries appended at the tail.
// ---------------------------------------------------------------------------
function matchesLevel(e: LogEntry): boolean {
  if (!level.value) return true
  return e.level === level.value
}

/** Display-only filter: hide the logs ability's own entries when toggled.
 *  (The on-disk log always keeps them for audit.) */
function isLogsSelf(e: LogEntry): boolean {
  return e.scope === 'logs' || (e.scope === 'ipc' && e.message.startsWith('logs.'))
}

function matchesFilter(e: LogEntry): boolean {
  if (!matchesLevel(e)) return false
  if (ignoreSelf.value && isLogsSelf(e)) return false
  return true
}

async function loadInitial(): Promise<void> {
  const res = (await window.cockpit.command('logs.query', {
    ...queryParams.value,
    limit: PAGE
  })) as LogQueryResult | null
  entries.value = res?.entries ?? []
  total.value = res?.total ?? entries.value.length
  scrolledToBottom.value = true
  await nextTick()
  await new Promise((r) => requestAnimationFrame(r))
  scrollToBottom()
}

async function loadOlder(): Promise<void> {
  if (busy.value || entries.value.length === 0) return
  busy.value = true
  try {
    const res = (await window.cockpit.command('logs.query', {
      ...queryParams.value,
      before: entries.value[0].id,
      limit: PAGE
    })) as LogQueryResult | null
    const older = res?.entries ?? []
    if (older.length) entries.value = [...older, ...entries.value]
    else total.value = entries.value.length
  } finally {
    busy.value = false
  }
}

function onLog(raw: unknown): void {
  // Never let a display bug propagate to console.error — that would re-enter
  // the renderer→main→broadcast loop.
  try {
    const e = raw as LogEntry
    if (!e || typeof e.id !== 'number' || !matchesFilter(e)) return
    const list = entries.value
    // a merged duplicate re-broadcasts the same id → update its count in place
    const hit = list.find((x) => x.id === e.id)
    if (hit) {
      entries.value = list.map((x) => (x.id === e.id ? { ...x, count: e.count } : x))
      return
    }
    if (list.length && list[list.length - 1].id >= e.id) return
    entries.value = [...list, e]
    if (scrolledToBottom.value) {
      void nextTick(() => scrollToBottom())
    }
  } catch {
    // swallow — the log viewer must not feed its own errors back into the log
  }
}

// ---------------------------------------------------------------------------
// Virtual-scroll container plumbing — the scroll area takes exactly the space
// left over by the toolbar (measured via ResizeObserver), so the page itself
// never needs its own scrollbar.
// ---------------------------------------------------------------------------
const scrollEl = ref<{ $el: HTMLElement } | null>(null)
const scrollWrapRef = ref<HTMLElement | null>(null)
const scrollHeight = ref(300)

function scrollToBottom(): void {
  const el = scrollEl.value?.$el
  if (el) el.scrollTop = el.scrollHeight
}

function onScroll(): void {
  const el = scrollEl.value?.$el
  if (!el) return
  scrolledToBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
  if (el.scrollTop <= 8) void loadOlder()
}

let unsub: (() => void) | null = null
let scrollCleanup: (() => void) | null = null
let ro: ResizeObserver | null = null

const SELF_HIDDEN_KEY = 'cockpit-logs-ignore-self'

onMounted(async () => {
  // restore the persisted display preference
  const saved = localStorage.getItem(SELF_HIDDEN_KEY)
  if (saved === 'false') ignoreSelf.value = false
  const el = scrollEl.value?.$el
  if (el) {
    el.addEventListener('scroll', onScroll)
    scrollCleanup = () => el.removeEventListener('scroll', onScroll)
  }
  unsub = window.cockpit.on('cockpit:log', onLog)
  if (scrollWrapRef.value) {
    scrollHeight.value = Math.max(120, scrollWrapRef.value.clientHeight)
  }
  ro = new ResizeObserver(() => {
    if (scrollWrapRef.value) scrollHeight.value = Math.max(120, scrollWrapRef.value.clientHeight)
  })
  if (scrollWrapRef.value) ro.observe(scrollWrapRef.value)
  await loadInitial()
})

onBeforeUnmount(() => {
  scrollCleanup?.()
  unsub?.()
  ro?.disconnect()
})

watch(level, () => void loadInitial())
watch(ignoreSelf, () => {
  localStorage.setItem(SELF_HIDDEN_KEY, String(ignoreSelf.value))
  void loadInitial()
})

// ---------------------------------------------------------------------------
// Export current session
// ---------------------------------------------------------------------------
const exporting = ref(false)
const snackOpen = ref(false)
const snackText = ref('')

async function doExport(): Promise<void> {
  const path = await window.cockpit.pickSaveFile({
    title: t('logs.exportTitle'),
    defaultPath: `cockpit-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`,
    filters: [{ name: 'Log', extensions: ['log'] }]
  })
  if (!path) return
  exporting.value = true
  try {
    const res = (await window.cockpit.command('logs.export', { path })) as {
      ok?: boolean
      count?: number
      error?: string
    } | null
    if (!res || res.ok === false) throw new Error(res?.error ?? t('logs.exportFailed'))
    snackText.value = te('logs.exported', { n: String(res.count ?? 0) })
    snackOpen.value = true
  } catch (e) {
    snackText.value = e instanceof Error ? e.message : String(e)
    snackOpen.value = true
  } finally {
    exporting.value = false
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number, l = 2): string => String(n).padStart(l, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
</script>

<template>
  <div class="logs-root">
    <div class="d-flex align-center ga-3 mb-2 flex-wrap">
      <div>
        <div class="text-h6 font-weight-medium">{{ t('logs.heading') }}</div>
        <div class="text-caption on-surface-variant mt-1">
          {{ translateTemplate(uiLang, 'logs.caption', {}) }}
        </div>
      </div>
      <v-spacer />
      <span class="text-caption on-surface-variant font-family-mono">
        {{ translateTemplate(uiLang, 'logs.total', { n: String(total) }) }}
      </span>
      <v-switch
        v-model="ignoreSelf"
        density="compact"
        hide-details
        color="primary"
        :label="t('logs.ignoreSelf')"
      />
      <v-select
        v-model="level"
        :items="levelOptions"
        density="compact"
        variant="solo-filled"
        flat
        hide-details
        attach
        :label="t('logs.levelFilter')"
        class="logs-level"
      />
      <v-btn variant="tonal" prepend-icon="mdi-export" :loading="exporting" @click="doExport">
        {{ t('logs.export') }}
      </v-btn>
    </div>

    <div v-if="hasOlder" class="d-flex justify-center mb-1">
      <v-btn size="small" variant="tonal" :loading="busy" @click="loadOlder">
        {{ t('logs.loadOlder') }}
      </v-btn>
    </div>

    <div ref="scrollWrapRef" class="logs-scroll-wrap">
      <v-virtual-scroll
        ref="scrollEl"
        :items="entries"
        :height="scrollHeight"
        :item-height="28"
        class="logs-scroll"
      >
        <template #default="{ item }">
          <div class="log-row" :class="'log-row--' + item.level" :title="item.message">
            <span class="log-row__time">{{ fmtTime(item.ts) }}</span>
            <span class="log-row__level">{{ item.level }}</span>
            <span class="log-row__scope">{{ item.scope }}</span>
            <span class="log-row__msg">
              {{ item.message }}
              <span v-if="item.count && item.count > 1" class="log-row__count"
                >*{{ item.count }}</span
              >
            </span>
          </div>
        </template>
      </v-virtual-scroll>
    </div>

    <v-empty-state
      v-if="entries.length === 0"
      icon="mdi-text-box-outline"
      :title="t('logs.empty')"
      class="align-self-center mt-8"
    />

    <v-snackbar v-model="snackOpen" :timeout="2500" color="success" location="top">
      {{ snackText }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.logs-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 240px;
}

.logs-level {
  width: 130px;
  flex-shrink: 0;
}

.logs-level :deep(.v-field__input) {
  justify-content: flex-end;
  align-items: center;
  text-align: right;
  /* kill the floating-label top/bottom padding so the value is truly centered */
  padding-top: 0;
  padding-bottom: 0;
}

.logs-level :deep(.v-list-item__content) {
  text-align: right;
}

.logs-scroll-wrap {
  flex: 1 1 auto;
  min-height: 0;
  position: relative;
}

.logs-scroll {
  height: 100%;
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
  border-radius: 12px;
  background: rgba(var(--v-theme-surface), 0.35);
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--v-theme-primary), 0.45) transparent;
}

.logs-scroll::-webkit-scrollbar {
  width: 8px;
}

.logs-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.logs-scroll::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-primary), 0.45);
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

.logs-scroll::-webkit-scrollbar-button {
  display: none;
}

.log-row {
  display: grid;
  grid-template-columns: 88px 52px 96px 1fr;
  gap: 8px;
  align-items: center;
  height: 28px;
  padding: 0 10px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.78rem;
  color: rgb(var(--v-theme-on-surface));
  border-bottom: 1px solid rgba(var(--v-theme-surface-bright), 0.06);
}

.log-row--warn {
  background: rgba(var(--v-theme-warning), 0.06);
}

.log-row--error {
  background: rgba(var(--v-theme-error), 0.08);
}

.log-row__time {
  color: rgba(var(--v-theme-on-surface-variant), 0.7);
}

.log-row__level {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.log-row--debug .log-row__level {
  color: rgba(var(--v-theme-on-surface-variant), 0.8);
}

.log-row--info .log-row__level {
  color: rgb(var(--v-theme-info));
}

.log-row--warn .log-row__level {
  color: rgb(var(--v-theme-warning));
}

.log-row--error .log-row__level {
  color: rgb(var(--v-theme-error));
}

.log-row__scope {
  color: rgba(var(--v-theme-on-surface-variant), 0.85);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-row__msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-row__count {
  color: rgba(var(--v-theme-primary), 0.9);
  font-weight: 600;
  margin-left: 4px;
}
</style>
