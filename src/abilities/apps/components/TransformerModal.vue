<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { AppEntry, ProcOutputEvent } from '../types'
import UiNode from './UiNode.vue'
import { createUi, type UiNode as UiNodeDesc, type UiApi } from './transformer'
import { ansiToHtml } from '@ui/ansi'

const props = defineProps<{
  modelValue: boolean
  entry: AppEntry | null
  pid: number | null
}>()

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const buffer = ref<UiNodeDesc[]>([])
const rawLines = ref<{ text: string; stream: 'stdout' | 'stderr' }[]>([])
const showRaw = ref(false)
const error = ref('')
const exited = ref(false)
const exitCode = ref<number | null>(null)
const autoScroll = ref(true)
const bodyEl = ref<HTMLElement | null>(null)

const MAX_NODES = 2000
const MAX_EVENTS = 4000

const visible = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

let ui: UiApi | null = null
let transformer: { onNewLine?: (e: string, ui: UiApi) => unknown } | null = null
/** Buffer every streamed event since app start (modal is mounted from the start,
 *  so nothing is missed even across the launch→dialog-open race). */
let localEvents: ProcOutputEvent[] = []

/** Evaluate the transformer source into a constructor instance. */
function buildTransformer(src: string): void {
  error.value = ''
  try {
    const make = new Function(`${src};return Transformer;`) as () => unknown
    const ctor = make()
    if (typeof ctor !== 'function') throw new Error('transformer 未导出构造函数')
    transformer = new (ctor as new () => { onNewLine?: (e: string, ui: UiApi) => unknown })()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    transformer = null
  }
}

function cap(): void {
  if (buffer.value.length > MAX_NODES) buffer.value.splice(0, buffer.value.length - MAX_NODES)
}

function processEvent(evt: ProcOutputEvent): void {
  if (props.pid == null || evt.pid !== props.pid) return
  if (evt.type === 'exit') {
    exited.value = true
    exitCode.value = evt.code
    return
  }
  rawLines.value.push({ text: evt.line, stream: evt.stream })
  if (rawLines.value.length > MAX_NODES) rawLines.value.splice(0, rawLines.value.length - MAX_NODES)
  if (!transformer?.onNewLine) {
    ui?.add(ui.NewText(evt.line, { mono: true, size: 'sm' }))
    cap()
    return
  }
  try {
    const ret = transformer.onNewLine(evt.line, ui!)
    if (ret == null) return
    if (Array.isArray(ret)) buffer.value.push(...ret)
    else buffer.value.push(ret as UiNodeDesc)
    cap()
  } catch (e) {
    ui?.add({ t: 'error', v: `transformer 错误: ${e instanceof Error ? e.message : String(e)}` })
    cap()
  }
}

function onEvent(evt: ProcOutputEvent): void {
  localEvents.push(evt)
  if (localEvents.length > MAX_EVENTS) localEvents.splice(0, localEvents.length - MAX_EVENTS)
  if (props.modelValue) processEvent(evt)
}

function clearOutput(): void {
  ui?.clear()
  rawLines.value = []
}

function scrollBottom(): void {
  if (autoScroll.value && bodyEl.value) {
    bodyEl.value.scrollTop = bodyEl.value.scrollHeight
  }
}

/** Reset on open: rebuild ui + transformer and replay buffered events. */
function reset(): void {
  buffer.value = []
  rawLines.value = []
  showRaw.value = false
  error.value = ''
  exited.value = false
  exitCode.value = null
  ui = createUi(buffer.value)
  if (props.entry) {
    if (props.entry.transformer) buildTransformer(props.entry.transformer)
    for (const evt of localEvents) processEvent(evt)
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) reset()
    else {
      exited.value = false
      exitCode.value = null
    }
  }
)

watch(
  () => buffer.value.length,
  async () => {
    await nextTick()
    scrollBottom()
  }
)

let unsub: (() => void) | null = null

onMounted(() => {
  unsub = window.cockpit.on('cockpit:proc-output', (...args: unknown[]) => {
    if (args[0]) onEvent(args[0] as ProcOutputEvent)
  })
})

onBeforeUnmount(() => unsub?.())
</script>

<template>
  <v-dialog v-model="visible" width="80%" :max-width="1400" scrollable>
    <v-card class="transform-dialog" rounded="lg">
      <v-card-title class="d-flex align-center ga-3 text-subtitle-1 px-4 py-2">
        <v-icon color="primary">mdi-radar</v-icon>
        <span class="text-truncate">{{ entry?.name ?? '输出' }}</span>
        <v-chip size="x-small" variant="tonal">pid {{ pid ?? '—' }}</v-chip>
        <v-chip
          v-if="exited"
          size="x-small"
          variant="tonal"
          :color="exitCode === 0 ? 'success' : 'error'"
        >
          已退出 ({{ exitCode ?? '?' }})
        </v-chip>
        <v-chip v-else size="x-small" variant="tonal" color="primary">运行中</v-chip>
        <v-spacer />

        <div class="d-flex align-center ga-1">
          <v-tooltip text="组件视图" location="bottom">
            <template #activator="{ props: tp }">
              <v-btn
                v-bind="tp"
                size="small"
                variant="flat"
                :color="!showRaw ? 'primary' : ''"
                icon
                @click="showRaw = false"
              >
                <v-icon size="small">mdi-view-dashboard</v-icon>
              </v-btn>
            </template>
          </v-tooltip>
          <v-tooltip text="原始输出" location="bottom">
            <template #activator="{ props: tp }">
              <v-btn
                v-bind="tp"
                size="small"
                variant="flat"
                :color="showRaw ? 'primary' : ''"
                icon
                @click="showRaw = true"
              >
                <v-icon size="small">mdi-code-tags</v-icon>
              </v-btn>
            </template>
          </v-tooltip>
          <v-tooltip text="自动滚动" location="bottom">
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
          <v-tooltip text="清空" location="bottom">
            <template #activator="{ props: tp }">
              <v-btn v-bind="tp" size="small" variant="flat" icon @click="clearOutput">
                <v-icon size="small">mdi-broom</v-icon>
              </v-btn>
            </template>
          </v-tooltip>
          <v-tooltip text="关闭" location="bottom">
            <template #activator="{ props: tp }">
              <v-btn v-bind="tp" size="small" variant="text" icon @click="visible = false">
                <v-icon size="small">mdi-close</v-icon>
              </v-btn>
            </template>
          </v-tooltip>
        </div>
      </v-card-title>

      <v-divider />

      <v-card-text ref="bodyEl" class="transform-body">
        <v-alert
          v-if="error"
          type="error"
          variant="tonal"
          class="mb-3"
          title="transformer 加载失败"
          :text="error"
        />
        <div
          v-if="!showRaw && buffer.length === 0 && !error"
          class="d-flex align-center ga-2 on-surface-variant"
        >
          <v-progress-circular indeterminate size="18" />
          <span class="text-caption">等待程序输出…</span>
        </div>
        <!-- eslint-disable vue/no-v-html -- content escaped by ansiToHtml -->
        <template v-if="showRaw">
          <div
            v-for="(l, i) in rawLines"
            :key="i"
            class="raw-line"
            :class="l.stream === 'stderr' ? 'raw-err' : ''"
            v-html="ansiToHtml(l.text)"
          ></div>
          <div v-if="rawLines.length === 0 && !error" class="on-surface-variant text-caption">
            暂无原始输出
          </div>
        </template>
        <!-- eslint-enable vue/no-v-html -->
        <div v-else class="d-flex flex-column ga-2">
          <UiNode v-for="(n, i) in buffer" :key="i" :node="n" />
        </div>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<style scoped>
.transform-dialog {
  height: 80vh;
  display: flex;
  flex-direction: column;
}
.transform-body {
  flex: 1;
  overflow-y: auto;
}
.raw-line {
  font-family: var(--v-font-family-mono, monospace);
  font-size: 0.82rem;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
  color: rgba(var(--v-theme-on-surface), 0.92);
}
.raw-err {
  color: rgb(var(--v-theme-error));
}
</style>
