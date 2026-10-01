<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  inject,
  onBeforeUnmount,
  onActivated,
  onDeactivated,
  ref,
  watch
} from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { ToolDefinition, ToolFile, ToolResult, ToolTask } from '../types'
import JsonTree from './JsonTree.vue'
import { safeSvgPreview } from './svg-preview'
const props = defineProps<{ tool: ToolDefinition }>()
const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)
const english = computed(() => lang.value !== 'zh')
const values = ref<Record<string, unknown>>({})
const result = ref<ToolResult | null>(null)
const busy = ref(false)
const error = ref('')
const snack = ref('')
const snackOpen = computed({
  get: () => !!snack.value,
  set: (value: boolean) => {
    if (!value) snack.value = ''
  }
})
const taskId = ref('')
const resetNonce = ref(0)
let visible = true
let pollGeneration = 0
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
function startClock(): void {
  if (timer || props.tool.view !== 'epoch') return
  now.value = Date.now()
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
}
function stopClock(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
startClock()
onActivated(() => {
  visible = true
  startClock()
  if (taskId.value) void pollTask(taskId.value, revision)
})
onDeactivated(() => {
  visible = false
  pollGeneration++
  stopClock()
})
onBeforeUnmount(() => {
  visible = false
  revision++
  pollGeneration++
  stopClock()
})
const LeisurePanel = defineAsyncComponent(() => import('../tools/leisure/LeisurePanel.vue'))
const currentEpoch = computed(() => ({
  seconds: Math.floor(now.value / 1000),
  milliseconds: now.value,
  UTC: new Date(now.value).toISOString()
}))
let revision = 0
watch(
  () => props.tool.id,
  () => {
    revision++
    busy.value = false
    values.value = Object.fromEntries(
      props.tool.fields.map((f) => [f.key, f.default ?? (f.type === 'boolean' ? false : '')])
    )
    result.value = null
    error.value = ''
    taskId.value = ''
    if (props.tool.category === 'files') void recoverTask(revision)
  },
  { immediate: true }
)
const resultText = computed(
  () =>
    result.value?.text ??
    (result.value?.data !== undefined ? JSON.stringify(result.value.data, null, 2) : '')
)
async function run(): Promise<void> {
  if (busy.value) return
  const current = ++revision
  error.value = ''
  for (const field of props.tool.fields) {
    const value = values.value[field.key]
    if (
      field.required &&
      (value === '' ||
        value === undefined ||
        value === null ||
        (Array.isArray(value) && !value.length))
    ) {
      error.value = `${english.value ? 'Required: ' : '请填写：'}${english.value ? (field.labelEn ?? field.label) : field.label}`
      return
    }
  }
  busy.value = true
  result.value = null
  try {
    if (props.tool.category === 'files') {
      const response = (await window.cockpit.command('toolbox.start', {
        tool: props.tool.id,
        args: JSON.parse(JSON.stringify(values.value))
      })) as { ok: boolean; task?: ToolTask; error?: string }
      if (current !== revision) return
      if (!response.ok || !response.task) {
        error.value = response.error ?? t('toolbox.failed')
        return
      }
      taskId.value = response.task.id
      await pollTask(response.task.id, current)
      return
    }
    const response = (await window.cockpit.command(
      `toolbox.${props.tool.id}`,
      JSON.parse(JSON.stringify(values.value))
    )) as { ok: boolean; payload?: ToolResult | string }
    if (current !== revision) return
    if (!response.payload || typeof response.payload === 'string') {
      error.value = t('toolbox.redacted')
      return
    }
    result.value = response.payload
    if (!response.payload.ok) error.value = response.payload.error ?? t('toolbox.failed')
  } catch {
    if (current === revision) error.value = t('toolbox.failed')
  } finally {
    if (current === revision) busy.value = false
  }
}
async function recoverTask(current: number): Promise<void> {
  try {
    const response = (await window.cockpit.command('toolbox.task', { tool: props.tool.id })) as {
      payload?: ToolTask | string | null
    }
    if (
      current !== revision ||
      !visible ||
      !response.payload ||
      typeof response.payload === 'string'
    )
      return
    taskId.value = response.payload.id
    if (response.payload.status === 'running') await pollTask(response.payload.id, current)
    else if (response.payload.result) {
      result.value = response.payload.result
      if (!result.value.ok) error.value = result.value.error ?? t('toolbox.failed')
    }
  } catch {
    /* No prior job is required to use this tool. */
  }
}
async function pollTask(id: string, current: number): Promise<void> {
  const generation = ++pollGeneration
  busy.value = true
  try {
    while (visible && generation === pollGeneration && current === revision) {
      const response = (await window.cockpit.command('toolbox.task', { id })) as {
        payload?: ToolTask | string | null
      }
      if (!visible || generation !== pollGeneration || current !== revision) return
      if (!response.payload || typeof response.payload === 'string') {
        error.value = t('toolbox.redacted')
        return
      }
      if (response.payload.status !== 'running') {
        result.value = response.payload.result ?? null
        if (result.value && !result.value.ok)
          error.value = result.value.error ?? t('toolbox.failed')
        return
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 700))
    }
  } finally {
    if (generation === pollGeneration && current === revision) busy.value = false
  }
}
async function cancel(): Promise<void> {
  try {
    await window.cockpit.command('toolbox.cancel', { id: taskId.value })
  } catch {
    error.value = t('toolbox.failed')
  }
}
function reset(): void {
  if (busy.value) return
  revision++
  resetNonce.value++
  taskId.value = ''
  values.value = Object.fromEntries(
    props.tool.fields.map((f) => [f.key, f.default ?? (f.type === 'boolean' ? false : '')])
  )
  result.value = null
  error.value = ''
}
async function readFiles(key: string, event: Event, multiple: boolean): Promise<void> {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  if (
    files.reduce((n, f) => n + f.size, 0) > 128 * 1024 * 1024 ||
    files.some((f) => f.size > 64 * 1024 * 1024)
  ) {
    error.value = t('toolbox.fileTooLarge')
    input.value = ''
    return
  }
  const current = revision
  const uploads: ToolFile[] = []
  try {
    for (const file of files) {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(new Error('read failed'))
        reader.readAsDataURL(file)
      })
      uploads.push({ name: file.name, mime: file.type || 'application/octet-stream', base64 })
    }
    if (current === revision) {
      values.value[key] = multiple ? uploads : uploads[0]
      error.value = ''
    }
  } catch {
    if (current === revision) error.value = t('toolbox.fileReadError')
  }
}
function fileNames(key: string): string {
  const data = values.value[key]
  const files = Array.isArray(data) ? data : data ? [data] : []
  return files.map((f: ToolFile) => f.name).join(', ')
}
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(resultText.value)
    snack.value = t('toolbox.copied')
  } catch {
    error.value = t('toolbox.copyFailed')
  }
}
async function save(file?: ToolFile): Promise<void> {
  const defaultPath = file ? file.name.replace(/[/\\]/g, '_') : `${props.tool.id}.txt`
  try {
    const path = await window.cockpit.pickSaveFile({ defaultPath })
    if (!path) return
    const response = (await window.cockpit.command(
      'toolbox.export',
      file ? { path, base64: file.base64 } : { path, text: resultText.value }
    )) as { ok: boolean; error?: string }
    if (!response.ok) error.value = response.error ?? t('toolbox.failed')
    else snack.value = t('toolbox.saved')
  } catch {
    error.value = t('toolbox.failed')
  }
}
function preview(file: ToolFile): string | undefined {
  // SVG is validated as an offline, script-free image; HTML is download-only.
  if (file.mime === 'image/svg+xml') return safeSvgPreview(file.base64)
  return /^image\/(png|jpeg|gif|webp)$/.test(file.mime)
    ? `data:${file.mime};base64,${file.base64}`
    : undefined
}
</script>

<template>
  <LeisurePanel v-if="tool.view === 'pomodoro'" :tool="tool" />
  <div v-else class="runner">
    <v-card v-if="tool.view === 'epoch'" variant="tonal" class="pa-5 clock-card">
      <div class="text-overline">{{ t('toolbox.currentEpoch') }}</div>
      <div class="clock-values">
        <div>
          <span class="text-body-2">{{ t('toolbox.seconds') }}</span
          ><strong>{{ currentEpoch.seconds }}</strong>
        </div>
        <div>
          <span class="text-body-2">{{ t('toolbox.milliseconds') }}</span
          ><strong>{{ currentEpoch.milliseconds }}</strong>
        </div>
        <div>
          <span class="text-body-2">UTC</span
          ><strong class="text-body-1">{{ currentEpoch.UTC }}</strong>
        </div>
      </div>
    </v-card>
    <v-alert
      v-if="tool.dependency"
      type="info"
      variant="tonal"
      :text="`${t('toolbox.dependency')}: ${tool.dependency}`"
    />
    <v-card variant="outlined" class="pa-6">
      <h2 class="text-h6 mb-5">{{ t('toolbox.input') }}</h2>
      <v-form v-privacy="'toolbox.content'" @submit.prevent="run">
        <div class="tool-fields">
          <div
            v-for="field in tool.fields"
            :key="field.key"
            :class="{ 'wide-field': ['textarea', 'file', 'files'].includes(field.type) }"
          >
            <v-textarea
              v-if="field.type === 'textarea'"
              v-model="values[field.key]"
              :label="english ? (field.labelEn ?? field.label) : field.label"
              :placeholder="field.placeholder"
              :hint="field.hint"
              persistent-hint
              variant="outlined"
              rows="6"
              auto-grow
            />
            <v-select
              v-else-if="field.type === 'select'"
              v-model="values[field.key]"
              :label="english ? (field.labelEn ?? field.label) : field.label"
              :items="field.options"
              variant="outlined"
              :hint="field.hint"
              persistent-hint
            />
            <v-switch
              v-else-if="field.type === 'boolean'"
              v-model="values[field.key]"
              :label="english ? (field.labelEn ?? field.label) : field.label"
              color="primary"
              hide-details
            />
            <div v-else-if="field.type === 'file' || field.type === 'files'" class="file-field">
              <label :for="`toolbox-${tool.id}-${field.key}`" class="text-body-1">{{
                english ? (field.labelEn ?? field.label) : field.label
              }}</label>
              <input
                :id="`toolbox-${tool.id}-${field.key}`"
                :key="resetNonce"
                type="file"
                :multiple="field.type === 'files'"
                :accept="field.accept"
                @change="readFiles(field.key, $event, field.type === 'files')"
              />
              <div class="text-caption text-medium-emphasis">
                {{ fileNames(field.key) || t('toolbox.fileHint') }}
              </div>
            </div>
            <v-text-field
              v-else-if="field.type === 'password'"
              v-model="values[field.key]"
              v-agent-forbidden
              type="password"
              autocomplete="off"
              :label="english ? (field.labelEn ?? field.label) : field.label"
              variant="outlined"
            />
            <v-text-field
              v-else
              v-model="values[field.key]"
              :type="field.type === 'number' ? 'number' : field.type === 'color' ? 'color' : 'text'"
              :label="english ? (field.labelEn ?? field.label) : field.label"
              :min="field.min"
              :max="field.max"
              :placeholder="field.placeholder"
              :hint="field.hint"
              persistent-hint
              variant="outlined"
            />
          </div>
        </div>
        <div class="d-flex ga-3 flex-wrap pt-4">
          <v-btn
            density="default"
            type="submit"
            color="primary"
            prepend-icon="mdi-play"
            :loading="busy"
            >{{ t('toolbox.run') }}</v-btn
          >
          <v-btn
            v-if="busy && taskId"
            density="default"
            variant="text"
            prepend-icon="mdi-stop"
            @click="cancel"
            >{{ t('toolbox.stop') }}</v-btn
          >
          <v-btn
            density="default"
            variant="text"
            prepend-icon="mdi-restore"
            :disabled="busy"
            @click="reset"
            >{{ t('toolbox.reset') }}</v-btn
          >
        </div>
      </v-form>
    </v-card>
    <v-alert
      v-if="error"
      v-privacy="'toolbox.content'"
      type="error"
      variant="tonal"
      :text="error"
    />
    <v-card
      v-if="result?.ok"
      v-privacy="tool.id === 'password-generator' ? 'secret' : 'toolbox.content'"
      variant="outlined"
      class="pa-6"
    >
      <div class="d-flex align-center flex-wrap ga-3 mb-5">
        <h2 class="text-h6">{{ t('toolbox.result') }}</h2>
        <v-spacer />
        <v-btn
          v-if="resultText"
          density="default"
          variant="text"
          prepend-icon="mdi-content-copy"
          @click="copy"
          >{{ t('toolbox.copy') }}</v-btn
        >
        <v-btn
          v-if="resultText"
          density="default"
          variant="text"
          prepend-icon="mdi-download"
          @click="save()"
          >{{ t('toolbox.saveText') }}</v-btn
        >
      </div>
      <v-alert v-if="result.note" type="info" variant="tonal" :text="result.note" class="mb-4" />
      <JsonTree
        v-if="tool.id === 'json-tree' && result.data !== undefined"
        :value="result.data"
        class="mb-5"
      />
      <pre v-if="resultText" class="result-text">{{ resultText }}</pre>
      <div v-if="result.files?.length" class="result-files mt-5">
        <v-card v-for="(file, i) in result.files" :key="i" variant="tonal" class="pa-4">
          <img v-if="preview(file)" :src="preview(file)" :alt="file.name" class="result-image" />
          <div class="text-body-2 text-break my-3">{{ file.name }}</div>
          <v-btn density="default" variant="text" prepend-icon="mdi-download" @click="save(file)">{{
            t('toolbox.download')
          }}</v-btn>
        </v-card>
      </div>
    </v-card>
    <v-snackbar v-model="snackOpen" :timeout="2200">{{ snack }}</v-snackbar>
  </div>
</template>

<style scoped>
.runner {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.tool-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px 24px;
}
.wide-field {
  grid-column: 1 / -1;
}
.file-field {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border: 1px dashed rgba(var(--v-theme-on-surface), 0.3);
  padding: 20px;
  border-radius: 12px;
}
.file-field input {
  max-width: 100%;
  font: inherit;
}
.result-text {
  font-family: monospace;
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 540px;
  overflow: auto;
  padding: 20px;
  border-radius: 12px;
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.result-files {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}
.result-image {
  width: 100%;
  max-height: 280px;
  object-fit: contain;
  background-image: repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%);
  background-size: 20px 20px;
  border-radius: 8px;
}
.clock-values {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
}
.clock-values > div {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.clock-values strong {
  font-size: 24px;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 800px) {
  .tool-fields {
    grid-template-columns: 1fr;
  }
}
</style>
