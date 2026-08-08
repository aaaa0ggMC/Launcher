<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue'
import type { BtOutputMessage, BtTaskInfo } from '@shared/types'
import { inject } from 'vue'
import type { Ref } from 'vue'
import { translate } from '@ui/i18n'
import { ansiToHtml } from '@ui/ansi'

/**
 * Default background-task view — a live console with an interactive input row.
 * Uses a sliding window so large outputs don't render every row at once:
 * only the tail is shown initially; scrolling to the top loads older messages.
 */
const props = defineProps<{
  task: BtTaskInfo
  messages: BtOutputMessage[]
}>()

const uiLang = inject<Ref<string>>('cockpit:lang', ref('zh'))
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const consoleEl = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
const inputText = ref('')

/** how many messages are rendered at once (older pages load on scroll-up) */
const PAGE = 300
/** start index of the visible window inside props.messages */
const windowStart = ref(0)
const loadingOlder = ref(false)

/** The slice we actually render: tail window by default, expands upward on demand. */
const visible = computed(() => {
  const list = props.messages
  const start = Math.max(0, Math.min(windowStart.value, Math.max(0, list.length - 1)))
  return list.slice(start)
})

// When new messages arrive: follow the tail only while the user is anchored
// at the bottom (autoScroll). The window may be pinned (windowStart > 0) even
// when following — the tail always includes the newest messages.
let hasInited = false
watch(
  () => props.messages,
  (list) => {
    // First load (or switching tasks): pin to the newest PAGE messages.
    if (!hasInited) {
      hasInited = true
      if (list.length > PAGE) windowStart.value = list.length - PAGE
      // Defer until after mount — consoleEl is still null during the
      // immediate pre-mount invocation.
      nextTick(scrollBottom)
      return
    }
    if (autoScroll.value) scrollBottom()
  },
  { immediate: true }
)

function scrollBottom(): void {
  if (!autoScroll.value || !consoleEl.value) return
  requestAnimationFrame(() => {
    const el = consoleEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function onScroll(): void {
  const el = consoleEl.value
  if (!el) return
  const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
  autoScroll.value = atBottom
  // Scroll-to-top → load an older page. Preserve the visible position by
  // compensating for the rows inserted above.
  if (el.scrollTop <= 8) {
    void loadOlder(el)
  }
}

async function loadOlder(el: HTMLElement): Promise<void> {
  if (loadingOlder.value || windowStart.value <= 0) return
  loadingOlder.value = true
  const before = el.scrollHeight
  const nextStart = Math.max(0, windowStart.value - PAGE)
  windowStart.value = nextStart
  // Wait a frame so the inserted rows are laid out, then keep the anchor point.
  requestAnimationFrame(() => {
    el.scrollTop = el.scrollHeight - before
    loadingOlder.value = false
  })
}

async function sendInput(data: string): Promise<void> {
  if (!data) return
  await window.cockpit.btInput(props.task.id, data)
}
function onEnter(): void {
  if (!inputText.value.trim()) return
  void sendInput(inputText.value + '\n')
  inputText.value = ''
}
function onCtrlC(): void {
  void window.cockpit.btSignal(props.task.id, 'SIGINT')
}
function onCtrlD(): void {
  void window.cockpit.btInput(props.task.id, '\u0004')
}
</script>

<template>
  <div class="btl-root d-flex flex-column" style="height: 100%">
    <div class="bt-console-wrap flex-grow-1" style="min-height: 0; position: relative">
      <div ref="consoleEl" class="bt-console" @scroll.passive="onScroll">
        <div
          v-if="windowStart > 0"
          class="bt-older"
          :class="{ 'bt-older--loading': loadingOlder }"
          @click="loadOlder(consoleEl!)"
        >
          {{ loadingOlder ? t('bt.loadingOlder') : t('bt.loadOlder') }}
        </div>
        <!-- eslint-disable vue/no-v-html -- content escaped by ansiToHtml -->
        <template v-for="(m, i) in visible" :key="i">
          <div
            v-if="m.line !== undefined"
            class="bt-line"
            :class="m.stream === 'stderr' ? 'bt-line--err' : ''"
            v-html="ansiToHtml(m.line)"
          ></div>
          <div v-else-if="m.data !== undefined" class="bt-data">
            <span v-if="m.label" class="bt-data__label">{{ m.label }}</span>
            <pre class="bt-data__pre">{{
              typeof m.data === 'string' ? m.data : JSON.stringify(m.data, null, 2)
            }}</pre>
          </div>
        </template>
        <!-- eslint-enable vue/no-v-html -->
        <div v-if="props.messages.length === 0" class="on-surface-variant text-caption pa-2">
          {{ t('bt.noOutput') }}
        </div>
        <div v-if="task.kind === 'job' && task.progress !== undefined" class="bt-console-progress">
          <v-progress-linear :model-value="task.progress" color="primary" height="6" rounded />
        </div>
      </div>
    </div>

    <!-- interactive input for running process tasks -->
    <div
      v-if="task.kind === 'process' && task.status === 'running'"
      class="d-flex align-center ga-2 px-4 py-4 bt-input-row"
    >
      <v-btn
        variant="tonal"
        color="warning"
        prepend-icon="mdi-console"
        :title="t('bt.ctrlC')"
        @click="onCtrlC"
      >
        ^C
      </v-btn>
      <v-btn variant="tonal" :title="t('bt.ctrlD')" @click="onCtrlD"> ^D </v-btn>
      <v-text-field
        v-model="inputText"
        :placeholder="t('bt.inputPlaceholder')"
        density="compact"
        variant="solo-filled"
        flat
        hide-details
        clearable
        @click:clear="inputText = ''"
        class="flex-grow-1"
        @keydown.enter.prevent="onEnter"
        @keydown.ctrl.c.prevent="onCtrlC"
        @keydown.ctrl.d.prevent="onCtrlD"
      />
      <v-btn
        variant="tonal"
        color="primary"
        prepend-icon="mdi-send"
        :disabled="!inputText.trim()"
        @click="onEnter"
      >
        {{ t('bt.send') }}
      </v-btn>
    </div>
  </div>
</template>

<style scoped>
.bt-console-wrap {
  margin: 0 16px;
}
.bt-older {
  text-align: center;
  padding: 4px 8px;
  margin-bottom: 4px;
  border-radius: 6px;
  color: rgba(var(--v-theme-primary), 0.9);
  font-size: 0.72rem;
  cursor: pointer;
  user-select: none;
}
.bt-older:hover {
  background: rgba(var(--v-theme-surface-bright), 0.12);
}
.bt-older--loading {
  cursor: default;
  opacity: 0.7;
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
.bt-console-progress {
  margin: 8px 0 4px;
  padding: 0 4px;
}
.bt-line {
  color: rgba(var(--v-theme-on-surface), 0.92);
  white-space: pre-wrap;
  word-break: break-all;
}
.bt-line--err {
  color: rgb(var(--v-theme-error));
}
.bt-data {
  margin-block: 6px;
}
.bt-data__label {
  display: block;
  font-size: 0.7rem;
  color: rgba(var(--v-theme-primary), 0.9);
  margin-bottom: 2px;
}
.bt-data__pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: rgba(var(--v-theme-on-surface), 0.92);
}
.bt-input-row {
  border-top: 1px solid rgba(var(--v-theme-surface-bright), 0.12);
}
</style>
