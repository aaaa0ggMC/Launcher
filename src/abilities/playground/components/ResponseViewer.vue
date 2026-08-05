<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{
  status: number | null
  body: string
  duration: number | null
  error: string | null
  defaultCollapsed: boolean
}>()

const emit = defineEmits<{
  clear: []
  copyRaw: []
}>()

const rawOpen = ref(!props.defaultCollapsed)
watch(
  () => props.defaultCollapsed,
  (v) => (rawOpen.value = !v)
)

function downloadBody(): void {
  if (!props.body) return
  let ext = 'txt'
  let content = props.body
  try {
    const parsed = JSON.parse(props.body)
    ext = 'json'
    content = JSON.stringify(parsed, null, 2)
  } catch {
    // keep raw
  }
  const blob = new Blob([content], { type: ext === 'json' ? 'application/json' : 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `response.${ext}`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div v-if="status !== null || error" class="pg-response mt-3">
    <div class="d-flex align-center ga-2 pa-2 pg-response-header">
      <span class="text-subtitle-2 font-weight-medium">响应</span>
      <v-chip
        v-if="status !== null"
        size="small"
        variant="tonal"
        :color="status < 400 ? 'success' : 'error'"
      >
        {{ status }}
      </v-chip>
      <span v-if="duration !== null" class="text-caption on-surface-variant">{{ duration }}ms</span>
      <v-spacer />
      <v-btn size="small" variant="flat" @click="emit('clear')">清空</v-btn>
    </div>

    <div v-if="error" class="pa-3 pg-error">{{ error }}</div>

    <div v-if="body && !error" class="pa-2">
      <div class="d-flex align-center ga-2 mb-1">
        <v-btn size="small" variant="text" @click="rawOpen = !rawOpen">
          {{ rawOpen ? '▼' : '▶' }} 原始
        </v-btn>
        <v-spacer />
        <v-btn size="small" variant="flat" @click="emit('copyRaw')">复制</v-btn>
        <v-btn size="small" variant="flat" @click="downloadBody">下载</v-btn>
      </div>
      <pre v-if="rawOpen" class="pg-rawbody">{{ body }}</pre>
    </div>
  </div>
</template>

<style scoped>
.pg-response-header {
  border-bottom: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
}
.pg-error {
  color: rgb(var(--v-theme-error));
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.8rem;
  white-space: pre-wrap;
  word-break: break-all;
}
.pg-rawbody {
  max-height: 300px;
  overflow-y: auto;
  background: rgba(var(--v-theme-surface), 0.35);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
  border-radius: 8px;
  padding: 8px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.75rem;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
