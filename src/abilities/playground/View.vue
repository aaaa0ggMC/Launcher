<script setup lang="ts">
defineOptions({ name: 'cockpit-playground' })

import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import type { BtOutputMessage, BtTaskInfo } from '@shared/types'
import type { GlobalVar, ParsedVar, RequestTemplate, SendHistoryEntry } from './types'
import {
  extractAllVars,
  interpolate,
  applyTransforms,
  type TransformResult
} from './parser/variableParser'
import { useLocalStorage } from './useLocalStorage'
import { translate, translateTemplate } from '@ui/i18n'
import TemplateList from './components/TemplateList.vue'
import TemplateEditor from './components/TemplateEditor.vue'
import DynamicForm from './components/DynamicForm.vue'
import GlobalVars from './components/GlobalVars.vue'
import ResponseViewer from './components/ResponseViewer.vue'
import FinalResponse from './components/FinalResponse.vue'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const STORAGE = {
  templates: 'rp_templates',
  globals: 'rp_globals',
  values: 'rp_values',
  history: 'rp_history',
  active: 'rp_active'
}

interface ExportData {
  version: number
  exportedAt: string
  data: {
    templates: RequestTemplate[]
    globals: GlobalVar[]
    savedValues: Record<string, Record<string, string>>
    history: SendHistoryEntry[]
  }
}

function makeTemplate(): RequestTemplate {
  return {
    id: crypto.randomUUID(),
    name: 'New Request',
    method: 'POST',
    urlTemplate: '',
    headersTemplate: '',
    bodyTemplate: '',
    respTransforms: [],
    createdAt: Date.now()
  }
}

// --- persisted state ---
const [templates, setTemplates] = useLocalStorage<RequestTemplate[]>(STORAGE.templates, [
  {
    id: crypto.randomUUID(),
    name: 'Example API',
    method: 'POST',
    urlTemplate: 'https://httpbin.org/post',
    headersTemplate: 'Content-Type: application/json\nAuthorization: Bearer {api_key:string}',
    bodyTemplate:
      '{\n  "model": "{model_name:string}",\n  "size": "{width:number:range(256,1024)}x{height:number:range(256,1024)}",\n  "prompt": "{prompt:textarea}"\n}',
    respTransforms: [],
    createdAt: Date.now()
  }
])
const [globalVars, setGlobalVars] = useLocalStorage<GlobalVar[]>(STORAGE.globals, [])
const [savedValues, setSavedValues] = useLocalStorage<Record<string, Record<string, string>>>(
  STORAGE.values,
  {}
)
const [history, setHistory] = useLocalStorage<SendHistoryEntry[]>(STORAGE.history, [])

// --- transient state ---
// Remember the last opened template across sessions. If the remembered one no
// longer exists (deleted/imported over), stay on the empty state instead of
// auto-selecting a random template.
const [activeId, setActiveId] = useLocalStorage<string | null>(STORAGE.active, null)
if (activeId.value && !templates.value.some((t) => t.id === activeId.value)) {
  setActiveId(null)
}
const varValues = ref<Record<string, string>>({})
const loading = ref(false)
const response = ref<{
  status: number | null
  body: string
  duration: number | null
  error: string | null
}>({ status: null, body: '', duration: null, error: null })
const transformed = ref<TransformResult[]>([])
const taskResults = ref<TransformResult[]>([])
const pollingActive = ref(false)
const mergedVars = ref<Record<string, string>>({})
const snackOpen = ref(false)
const snackText = ref('')
// Remember whether the right Provider panel is expanded or collapsed.
const [panelCollapsed, setPanelCollapsed] = useLocalStorage<boolean>('rp_panel_collapsed', false)

/** background tasks subscribed to catch async-task results pushed as data */
const btTaskId = ref<string | null>(null)
/** retry jobs: their data is merged into taskResults by label, not wholesale */
const retryIds = new Set<string>()
let btUnsub: (() => void) | null = null

/** Apply structured results received for a task id (whole replacement). */
function applyTaskResults(id: string, incoming: TransformResult[]): void {
  if (id === btTaskId.value) {
    taskResults.value = incoming
    pollingActive.value = false
  } else if (retryIds.has(id)) {
    // Replace matching results by label; keep the rest.
    const map = new Map(taskResults.value.map((r) => [r.label, r]))
    for (const r of incoming) if (r.label) map.set(r.label, r)
    taskResults.value = [...map.values()]
  }
}

/** Backfill results from the task's ring buffer — covers the race where a
 *  fast task finishes before btJob's IPC response sets btTaskId (its output
 *  would otherwise be dropped). The main process keeps the buffer, so the
 *  data message is always retrievable here. */
async function backfillTaskResults(id: string): Promise<void> {
  const res = (await window.cockpit.btOutput(id)) as {
    ok?: boolean
    messages?: BtOutputMessage[]
  } | null
  if (!res?.ok || !res.messages) return
  for (const m of res.messages) {
    if (m.data === undefined || !Array.isArray(m.data)) continue
    applyTaskResults(id, m.data as TransformResult[])
  }
}

/** Receive async-task results: the main-process pg-task job pushes
 *  { data: TransformResult[] } when done. */
function onBtEvent(raw: unknown): void {
  try {
    const evt = raw as
      | { type: 'changed'; tasks: BtTaskInfo[] }
      | { type: 'output'; id: string; messages: BtOutputMessage[] }
      | { type: 'exit'; id: string; code: number | null }
    if (!evt) return
    if (evt.type === 'changed') {
      if (btTaskId.value && !evt.tasks.some((t) => t.id === btTaskId.value)) btTaskId.value = null
      for (const id of retryIds) {
        if (!evt.tasks.some((t) => t.id === id)) retryIds.delete(id)
      }
      return
    }
    if (evt.type === 'output') {
      for (const m of evt.messages) {
        if (m.data === undefined || !Array.isArray(m.data)) continue
        applyTaskResults(evt.id, m.data as TransformResult[])
      }
    }
  } catch {
    // never let display logic break the event loop
  }
}

const active = computed(() => templates.value.find((t) => t.id === activeId.value) ?? null)
const globalVarNames = computed(() => new Set(globalVars.value.map((g) => g.key).filter(Boolean)))
const globalVarMap = computed(() => {
  const m: Record<string, string> = {}
  for (const g of globalVars.value) {
    if (g.key) m[g.key] = g.value
  }
  return m
})
const allVars = computed(() =>
  active.value
    ? extractAllVars(
        [active.value.urlTemplate, active.value.headersTemplate, active.value.bodyTemplate],
        globalVarNames.value
      )
    : []
)
const templateHistory = computed(() =>
  activeId.value
    ? history.value
        .filter((h) => h.templateId === activeId.value)
        .sort((a, b) => b.timestamp - a.timestamp)
    : []
)
const nonTaskTransforms = computed(() =>
  Array.isArray(active.value?.respTransforms)
    ? active.value.respTransforms.filter((x) => x.type !== 'task')
    : []
)
const allResults = computed(() => [...transformed.value, ...taskResults.value])

/** Build a map of variable → default value for the given vars (if any). */
function defaultsForVars(vars: ParsedVar[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (const v of vars) {
    if (v.defaultValue !== undefined) m[v.name] = v.defaultValue
  }
  return m
}

/** Effective values for the active template: defaults first, then saved. */
function effectiveValuesFor(id: string): Record<string, string> {
  const a = templates.value.find((t) => t.id === id)
  if (!a) return {}
  const vars = extractAllVars(
    [a.urlTemplate, a.headersTemplate, a.bodyTemplate],
    globalVarNames.value
  )
  return { ...defaultsForVars(vars), ...(savedValues.value[id] ?? {}) }
}

// --- template ops ---
function updateTemplate(t: RequestTemplate): void {
  setTemplates(templates.value.map((x) => (x.id === t.id ? t : x)))
}
function deleteTemplate(): void {
  const a = active.value
  if (!a) return
  setTemplates(templates.value.filter((x) => x.id !== a.id))
  setHistory(history.value.filter((h) => h.templateId !== a.id))
  setActiveId(null)
}
function newTemplate(): void {
  const t = makeTemplate()
  setTemplates([t, ...templates.value])
  setActiveId(t.id)
  varValues.value = {}
  response.value = { status: null, body: '', duration: null, error: null }
}
function selectTemplate(id: string): void {
  if (activeId.value) {
    setSavedValues({ ...savedValues.value, [activeId.value]: varValues.value })
  }
  setActiveId(id)
  // Restore that template's saved values merged over its declared defaults.
  varValues.value = effectiveValuesFor(id)
  response.value = { status: null, body: '', duration: null, error: null }
}
function setVar(name: string, value: string): void {
  varValues.value = { ...varValues.value, [name]: value }
}
function fillValues(vals: Record<string, string>): void {
  varValues.value = vals
}
function clearHistory(): void {
  if (!activeId.value) return
  setHistory(history.value.filter((h) => h.templateId !== activeId.value))
}

// --- send request ---
async function sendRequest(): Promise<void> {
  const a = active.value
  if (!a) return
  loading.value = true
  response.value = { status: null, body: '', duration: null, error: null }
  transformed.value = []
  taskResults.value = []
  pollingActive.value = a.respTransforms.some((x) => x.type === 'task' && x.taskAddr)
  if (activeId.value) {
    setSavedValues({ ...savedValues.value, [activeId.value]: varValues.value })
  }
  const t0 = performance.now()
  let respStatus: number | null = null
  let respBody = ''
  let respError: string | null = null

  try {
    // Fall back to declared defaults for any variable the user left empty, so
    // a `{x:...:default(2048)}` never reaches the server as raw template text.
    const merged = { ...defaultsForVars(allVars.value), ...globalVarMap.value, ...varValues.value }
    mergedVars.value = merged
    const url = interpolate(a.urlTemplate, merged)
    const headersRaw = interpolate(a.headersTemplate, merged)

    // JSON-escape textarea/string values for body interpolation
    const bodyVars = extractAllVars([a.bodyTemplate])
    const varTypeMap: Record<string, string> = {}
    for (const v of bodyVars) varTypeMap[v.name] = v.type
    const bodyValues: Record<string, string> = {}
    for (const [k, v] of Object.entries(merged)) {
      const ty = varTypeMap[k]
      bodyValues[k] =
        ty === 'textarea' || ty === 'string'
          ? v
              .replace(/\\/g, '\\\\')
              .replace(/"/g, '\\"')
              .replace(/\n/g, '\\n')
              .replace(/\r/g, '\\r')
              .replace(/\t/g, '\\t')
          : v
    }
    const bodyRaw = interpolate(a.bodyTemplate, bodyValues)

    const headers: Record<string, string> = {}
    if (headersRaw.trim()) {
      for (const line of headersRaw.split('\n')) {
        const idx = line.indexOf(':')
        if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
      }
    }

    const resp = await fetch(url, {
      method: a.method,
      headers: { ...headers },
      body: a.method !== 'GET' && bodyRaw.trim() ? bodyRaw : undefined
    })
    respStatus = resp.status
    respBody = await resp.text()
  } catch (err) {
    respError = err instanceof Error ? err.message : String(err)
  }

  const duration = Math.round(performance.now() - t0)
  response.value = { status: respStatus, body: respBody, duration, error: respError }

  // history (dedup by identical values)
  const entryValues = JSON.stringify(varValues.value)
  const dup = history.value.find(
    (h) => h.templateId === a.id && JSON.stringify(h.values) === entryValues
  )
  if (dup) {
    setHistory(history.value.map((h) => (h.id === dup.id ? { ...h, timestamp: Date.now() } : h)))
  } else {
    setHistory([
      {
        id: crypto.randomUUID(),
        templateId: a.id,
        values: { ...varValues.value },
        duration,
        error: respError,
        timestamp: Date.now()
      },
      ...history.value
    ])
  }
  loading.value = false

  // Async task transforms → run the poll as a main-process background job
  // (view 'response'). The result arrives via cockpit:bt and updates taskResults.
  // Any task transform (even with an empty poll URL) creates a visible task so
  // the poll is tracked cross-page; the handler reports missing fields.
  const taskTransforms = a.respTransforms.filter((t) => t.type === 'task')
  if (respError === null && taskTransforms.length > 0) {
    // Deep-clone to plain JSON before crossing the IPC boundary: the template
    // objects are Vue reactive proxies, which structured-clone cannot copy.
    const res = (await window.cockpit.btJob('pg-task', {
      name: a.name || 'Task',
      description: a.urlTemplate,
      view: 'response',
      transforms: JSON.parse(JSON.stringify(taskTransforms)),
      initialResponse: respBody,
      variables: JSON.parse(JSON.stringify(mergedVars.value)),
      pollMs: taskTransforms[0].taskPollMs || 2000
    })) as { ok?: boolean; task?: BtTaskInfo; error?: string } | null
    if (res?.ok && res.task) {
      btTaskId.value = res.task.id
      pollingActive.value = true
      // Task may already have finished by the time btJob resolves (its output
      // event raced ahead of this IPC response) — fetch the results now.
      await backfillTaskResults(res.task.id)
    } else {
      pollingActive.value = false
    }
  }
}

function clearResponse(): void {
  response.value = { status: null, body: '', duration: null, error: null }
  transformed.value = []
  taskResults.value = []
  pollingActive.value = false
}

// apply transforms (debounced) on body / transform / globals change
watch(
  () => [active.value?.id, response.value.body, nonTaskTransforms.value, globalVarMap.value],
  ([, body]) => {
    if (!active.value || !body || nonTaskTransforms.value.length === 0) {
      transformed.value = []
      return
    }
    const handle = setTimeout(() => {
      void applyTransforms(body as string, nonTaskTransforms.value, globalVarMap.value).then(
        (r) => (transformed.value = r)
      )
    }, 200)
    return () => clearTimeout(handle)
  },
  { deep: false }
)

function handleCopyRaw(): void {
  if (response.value.body) void navigator.clipboard.writeText(response.value.body).catch(() => {})
}

async function handleRetryTask(label: string): Promise<void> {
  const a = active.value
  if (!a) return
  const tf = a.respTransforms.find((x) => x.type === 'task' && x.label === label)
  if (!tf) return
  const res = (await window.cockpit.btJob('pg-task', {
    name: `${a.name || 'Task'} · ${label}`,
    description: a.urlTemplate,
    view: 'response',
    transforms: JSON.parse(JSON.stringify([tf])),
    initialResponse: response.value.body,
    variables: JSON.parse(JSON.stringify(mergedVars.value)),
    pollMs: tf.taskPollMs || 2000
  })) as { ok?: boolean; task?: BtTaskInfo; error?: string } | null
  if (res?.ok && res.task) {
    retryIds.add(res.task.id)
    await backfillTaskResults(res.task.id)
  }
}

// --- import / export (backend commands) ---
async function handleExport(): Promise<void> {
  const data: ExportData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      templates: templates.value,
      globals: globalVars.value,
      savedValues: savedValues.value,
      history: history.value
    }
  }
  const path = await window.cockpit.pickSaveFile({
    title: '导出配置',
    defaultPath: `playground-${Date.now()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!path) return
  const res = (await window.cockpit.command('playground.export', { path, data })) as {
    ok?: boolean
    error?: string
  } | null
  if (res?.ok) {
    snackText.value = translateTemplate(uiLang.value, 'pg.exported', {
      n: String(templates.value.length)
    })
    snackOpen.value = true
  } else {
    snackText.value = res?.error ?? '导出失败'
    snackOpen.value = true
  }
}

async function handleImport(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: '导入配置',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!path) return
  const res = (await window.cockpit.command('playground.import', { path })) as {
    ok?: boolean
    templates?: RequestTemplate[]
    globals?: GlobalVar[]
    savedValues?: Record<string, Record<string, string>>
    history?: SendHistoryEntry[]
    error?: string
  } | null
  if (!res?.ok) {
    snackText.value = translateTemplate(uiLang.value, 'pg.importFailed', {
      err: res?.error ?? '未知错误'
    })
    snackOpen.value = true
    return
  }
  if (res.templates) setTemplates(res.templates)
  if (res.globals) setGlobalVars(res.globals)
  if (res.savedValues) setSavedValues(res.savedValues)
  if (res.history) setHistory(res.history)
  snackText.value = translateTemplate(uiLang.value, 'pg.imported', {
    n: String(res.templates?.length ?? 0)
  })
  snackOpen.value = true
}

onMounted(() => {
  btUnsub = window.cockpit.on('cockpit:bt', onBtEvent)
  // Initialize the active template's values (defaults + last saved).
  if (activeId.value) {
    varValues.value = effectiveValuesFor(activeId.value)
  }
})

onBeforeUnmount(() => {
  // persist current values on leave
  if (activeId.value) {
    setSavedValues({ ...savedValues.value, [activeId.value]: varValues.value })
  }
  btUnsub?.()
})
</script>

<template>
  <div class="pg-root">
    <!-- header -->
    <div class="d-flex align-center ga-2 mb-3 flex-wrap">
      <div>
        <div class="text-h6 font-weight-medium">{{ t('pg.title') }}</div>
        <div class="text-caption on-surface-variant mt-1">API 请求模板 · 变量插值 · 响应变换</div>
      </div>
      <v-spacer />
      <v-btn variant="tonal" prepend-icon="mdi-export" @click="handleExport">导出</v-btn>
      <v-btn variant="tonal" prepend-icon="mdi-import" @click="handleImport">导入</v-btn>
    </div>

    <!-- main area: editor + form + response fills the page -->
    <div class="pg-main">
      <template v-if="active">
        <TemplateEditor
          :template="active"
          :global-var-names="globalVarNames"
          :templates="templates"
          @change="updateTemplate"
          @delete="deleteTemplate"
        />
        <v-divider class="my-3" />
        <DynamicForm
          :vars="allVars"
          :values="varValues"
          :loading="loading"
          :history="templateHistory"
          @change="setVar"
          @send="sendRequest"
          @fill="fillValues"
          @clear-history="clearHistory"
        />
        <v-divider class="my-3" />
        <FinalResponse :results="allResults" @retry="handleRetryTask" />
        <ResponseViewer
          :status="response.status"
          :body="response.body"
          :duration="response.duration"
          :error="response.error"
          :default-collapsed="allResults.length > 0"
          @clear="clearResponse"
          @copy-raw="handleCopyRaw"
        />
      </template>
      <div v-else class="text-caption on-surface-variant pa-3">请选择或新建一个请求模板</div>
    </div>

    <!-- right floating collapsible sidebar: templates + globals -->
    <aside class="pg-panel" :class="{ 'pg-panel--collapsed': panelCollapsed }">
      <div class="pg-panel__head">
        <span v-if="!panelCollapsed" class="text-subtitle-2">Provider</span>
        <v-btn
          :icon="panelCollapsed ? 'mdi-chevron-left' : 'mdi-chevron-right'"
          size="small"
          variant="tonal"
          :title="panelCollapsed ? '展开' : '折叠'"
          @click="setPanelCollapsed(!panelCollapsed)"
        />
      </div>

      <div v-if="!panelCollapsed" class="pg-panel__body">
        <GlobalVars :vars="globalVars" @change="setGlobalVars" />
        <v-divider class="my-2" />
        <TemplateList
          :templates="templates"
          :active-id="activeId"
          @select="selectTemplate"
          @new="newTemplate"
        />
      </div>
    </aside>

    <v-snackbar v-model="snackOpen" :timeout="2500" color="success" location="top">
      {{ snackText }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.pg-root {
  position: relative;
  min-height: 100%;
}

/* main content fills the whole page; the floating panel overlays the right */
.pg-main {
  max-width: 1100px;
}

/* right floating panel — mirrors ft's docked-aside pattern, with smooth
   expand/collapse animation. Expanded = full-height sidebar; collapsed = a
   fan-shaped FAB tucked into the canvas top-right corner. */
.pg-panel {
  position: fixed;
  top: 76px;
  right: 16px;
  bottom: 16px;
  width: 320px;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  background: rgba(var(--v-theme-surface-variant), 0.42);
  backdrop-filter: blur(14px);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  z-index: 5;
  overflow: hidden;
  transition:
    width 0.22s cubic-bezier(0.4, 0, 0.2, 1),
    top 0.22s cubic-bezier(0.4, 0, 0.2, 1),
    bottom 0.22s cubic-bezier(0.4, 0, 0.2, 1),
    border-radius 0.22s cubic-bezier(0.4, 0, 0.2, 1),
    clip-path 0.22s cubic-bezier(0.4, 0, 0.2, 1),
    background-color 0.22s ease;
}

/* collapsed: fan-shaped FAB tucked into the canvas top-right, right below the
   header toolbar. Its straight edges hug the header (top) and the right
   border; the arc faces inward, so nothing underneath is covered. Fully
   transparent so only the tonal chevron button shows. */
.pg-panel--collapsed {
  width: 56px;
  height: 56px;
  top: 76px;
  right: 0;
  bottom: auto;
  border-radius: 14px 0 0 14px;
  background: transparent;
  backdrop-filter: none;
  border: none;
  clip-path: ellipse(100% 100% at 100% 0);
}

.pg-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  flex-shrink: 0;
}

.pg-panel--collapsed .pg-panel__head {
  justify-content: center;
  align-items: flex-end;
  padding: 0 6px 12px 0;
  height: 100%;
}

.pg-panel__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0 10px 12px;
  opacity: 1;
  transition: opacity 0.15s ease 0.08s;
}

.pg-panel--collapsed .pg-panel__body {
  opacity: 0;
  pointer-events: none;
}
</style>
