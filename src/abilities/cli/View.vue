<script setup lang="ts">
defineOptions({ name: 'CockpitCli' })

import { ref, shallowRef, nextTick, onMounted, onActivated, inject } from 'vue'
import type { Ref } from 'vue'
import type { AppEntry } from '../apps/types'
import { translate } from '@ui/i18n'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

interface Line {
  kind: 'in' | 'out' | 'err'
  text: string
}

const history = shallowRef<Line[]>([])
const input = ref('')
const historyStack = ref<string[]>([])
const histIndex = ref(-1)
const busy = ref(false)

const suggestions = shallowRef<string[]>([])
const appsCache = shallowRef<Record<string, AppEntry>>({})

async function refreshAliases(): Promise<void> {
  const res = await window.cockpit.listApps()
  appsCache.value = res.apps
}

function completeCandidates(): string[] {
  const cmds = ['help', 'list', 'info', 'launch']
  const aliases: string[] = []
  for (const [id, e] of Object.entries(appsCache.value)) {
    aliases.push(e.alias ?? id)
    aliases.push(id)
  }
  return [...cmds, ...aliases]
}

async function run(): Promise<void> {
  const cmd = input.value.trim()
  if (!cmd) return
  history.value.push({ kind: 'in', text: cmd })
  historyStack.value.push(cmd)
  histIndex.value = -1
  input.value = ''
  suggestions.value = []
  busy.value = true
  try {
    const out = await window.cockpit.cliExec(cmd)
    for (const line of out.split('\n')) {
      history.value.push({ kind: 'out', text: line })
    }
  } catch (e) {
    history.value.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) })
  } finally {
    busy.value = false
    await nextTick()
    scrollToBottom()
    focusInput()
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Tab') {
    e.preventDefault()
    complete()
  } else if (e.key === 'Enter') {
    run()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (historyStack.value.length === 0) return
    histIndex.value = Math.min(histIndex.value + 1, historyStack.value.length - 1)
    input.value = historyStack.value[historyStack.value.length - 1 - histIndex.value]
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (histIndex.value > 0) {
      histIndex.value--
      input.value = historyStack.value[historyStack.value.length - 1 - histIndex.value]
    } else {
      histIndex.value = -1
      input.value = ''
    }
  }
}

function complete(): void {
  const q = input.value.trim()
  const candidates = completeCandidates().filter((c) => c.toLowerCase().startsWith(q.toLowerCase()))
  if (candidates.length === 0) return
  if (candidates.length === 1) {
    input.value = candidates[0]
    suggestions.value = []
    return
  }
  // find longest common prefix
  let prefix = candidates[0]
  for (const c of candidates.slice(1)) {
    let i = 0
    while (i < prefix.length && i < c.length && prefix[i] === c[i]) i++
    prefix = prefix.slice(0, i)
  }
  if (prefix.length > q.length) {
    input.value = prefix
  } else {
    suggestions.value = candidates
  }
}

function pickSuggestion(s: string): void {
  input.value = s
  suggestions.value = []
}

const outputEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

function scrollToBottom(): void {
  // The ref is bound to a <v-card> (Vuetify component), so outputEl.value is
  // the component instance — resolve the native element via $el when present.
  const inst = outputEl.value as (HTMLElement & { $el?: HTMLElement }) | null
  const el = inst?.$el ?? inst
  el?.scrollTo({ top: el.scrollHeight })
}

function focusInput(): void {
  inputEl.value?.focus()
}

onMounted(async () => {
  await refreshAliases()
  history.value.push({ kind: 'out', text: translate(uiLang.value, 'cli.welcome') })
  await nextTick()
  focusInput()
})

onActivated(async () => {
  await nextTick()
  focusInput()
})

/** Export the CLI transcript as markdown (prompts bold, output verbatim). */
function toMarkdown(): string {
  const lines: string[] = [translate(uiLang.value, 'cli.mdHeading')]
  for (const l of history.value) {
    const text = l.text.replace(/\r?\n/g, '\n')
    if (l.kind === 'in') {
      lines.push(`- **❯ ${text.replace(/\n/g, ' ')}**`)
    } else {
      for (const seg of text.split('\n')) lines.push(seg)
    }
  }
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <div class="d-flex flex-column fill-height">
    <div class="text-h6 font-weight-medium mb-1">{{ translate(uiLang, 'cli.heading') }}</div>
    <div
      class="text-caption on-surface-variant mb-3"
      v-html="translate(uiLang, 'cli.subtitle')"
    ></div>

    <v-card
      ref="outputEl"
      rounded="lg"
      variant="tonal"
      flat
      class="cli-output pa-4 overflow-y-auto"
    >
      <div
        v-for="(l, i) in history"
        :key="i"
        :class="[
          'font-family-mono text-body-2 mb-1',
          l.kind === 'in' ? 'text-primary font-weight-medium' : l.kind === 'err' ? 'text-error' : ''
        ]"
      >
        <template v-if="l.kind === 'in'"><span class="cli-prompt">❯</span> {{ l.text }}</template>
        <template v-else>{{ l.text }}</template>
      </div>
      <div v-if="busy" class="text-caption on-surface-variant mb-1">
        {{ translate(uiLang, 'cli.busy') }}
      </div>

      <div v-if="suggestions.length" class="mb-1 d-flex flex-wrap gap-1">
        <v-chip
          v-for="s in suggestions"
          :key="s"
          size="x-small"
          variant="tonal"
          @click="pickSuggestion(s)"
        >
          {{ s }}
        </v-chip>
      </div>

      <div class="cli-input-line">
        <span class="cli-prompt">❯</span>
        <input
          ref="inputEl"
          v-model="input"
          class="cli-input"
          :placeholder="translate(uiLang, 'cli.placeholder')"
          @keydown="onKey"
        />
      </div>
    </v-card>
  </div>
</template>

<style scoped>
.gap-1 {
  gap: 4px;
}
.cli-output {
  flex: 1 1 auto;
  min-height: 0;
  background: rgba(var(--v-theme-background), 0.6);
}
.cli-input-line {
  display: flex;
  align-items: center;
  gap: 0.4em;
}
.cli-input {
  flex: 1 1 auto;
  background: transparent;
  border: none;
  outline: none;
  color: rgba(var(--v-theme-on-surface), 1);
  font-family: 'Noto Sans Mono CJK SC', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.875rem;
  caret-color: rgb(var(--v-theme-primary));
}
.cli-input::placeholder {
  color: rgba(var(--v-theme-on-surface-variant), 0.6);
}
.cli-prompt {
  color: rgb(var(--v-theme-primary));
  font-weight: 700;
  font-family: 'Noto Sans Mono CJK SC', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}
</style>
