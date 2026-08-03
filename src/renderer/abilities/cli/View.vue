<script setup lang="ts">
defineOptions({ name: 'cockpit-cli' })

import { ref, shallowRef, nextTick, onMounted } from 'vue'
import type { AppEntry } from '@shared/types'

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

const outputEl = ref<HTMLElement | null>(null)

function scrollToBottom(): void {
  outputEl.value?.scrollTo({ top: outputEl.value.scrollHeight })
}

onMounted(async () => {
  await refreshAliases()
  history.value.push({ kind: 'out', text: 'Linux Cockpit CLI — 输入 help 查看命令, Tab 补全' })
})
</script>

<template>
  <div class="d-flex flex-column fill-height">
    <div class="text-h6 font-weight-medium mb-1">命令行</div>
    <div class="text-caption on-surface-variant mb-3">
      别名启动 · 标签补全 · <code>info &lt;alias&gt;</code>
    </div>

    <v-card ref="outputEl" rounded="lg" variant="tonal" flat class="flex-grow-1 cli-output mb-3 pa-3 overflow-y-auto">
      <div
        v-for="(l, i) in history"
        :key="i"
        :class="[
          'font-family-mono text-body-2 mb-1',
          l.kind === 'in' ? 'text-primary' : l.kind === 'err' ? 'text-error' : ''
        ]"
      >
        <template v-if="l.kind === 'in'"><span class="on-surface-variant">❯ </span>{{ l.text }}</template>
        <template v-else>{{ l.text }}</template>
      </div>
      <div v-if="busy" class="text-caption on-surface-variant">运行中…</div>
    </v-card>

    <div v-if="suggestions.length" class="mb-1 d-flex flex-wrap gap-1">
      <v-chip v-for="s in suggestions" :key="s" size="x-small" variant="tonal" @click="input = s; suggestions = []">
        {{ s }}
      </v-chip>
    </div>

    <v-text-field
      v-model="input"
      @keydown="onKey"
      prepend-inner-icon="mdi-console-line"
      placeholder="输入命令，Tab 补全，↑↓ 历史"
      variant="solo-filled"
      density="compact"
      hide-details
      :loading="busy"
    />
  </div>
</template>

<style scoped>
.gap-1 {
  gap: 4px;
}
.cli-output {
  min-height: 240px;
  max-height: calc(100vh - 340px);
}
</style>
