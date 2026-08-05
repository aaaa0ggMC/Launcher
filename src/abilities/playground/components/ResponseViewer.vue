<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import type { Ref } from 'vue'
import FoldingJson from './FoldingJson.vue'
import { translate, translateTemplate } from '@ui/i18n'
import { downloadTextToLocal } from '../../../main/ui/composables/download'
import { fence } from '../markdown'

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

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const rawOpen = ref(!props.defaultCollapsed)
watch(
  () => props.defaultCollapsed,
  (v) => (rawOpen.value = !v)
)

/** response parsed as JSON (null when not JSON) */
const parsed = computed<unknown>(() => {
  if (!props.body) return null
  try {
    return JSON.parse(props.body)
  } catch {
    return null
  }
})
const isJson = computed(() => parsed.value !== null)

/** view mode: 'json' tree | 'raw' text */
const mode = ref<'json' | 'raw'>(isJson.value ? 'json' : 'raw')
watch(isJson, (v) => {
  if (!mode.value || (v && mode.value === 'raw' && !rawOpen.value)) return
  if (v) mode.value = 'json'
})

function downloadBody(): void {
  if (!props.body) return
  const name = isJson.value ? 'response.json' : 'response.txt'
  const content = isJson.value ? JSON.stringify(parsed.value, null, 2) : props.body
  void downloadTextToLocal(content, name, t('pg.saveLocal'))
}

/** Export the raw response + status/duration/error as markdown. */
function toMarkdown(): string {
  const lines: string[] = [translate(uiLang.value, 'pg.mdResponse')]
  if (props.status !== null)
    lines.push(translateTemplate(uiLang.value, 'pg.mdStatus', { status: String(props.status) }))
  if (props.duration !== null)
    lines.push(
      translateTemplate(uiLang.value, 'pg.mdDuration', { duration: String(props.duration) })
    )
  if (props.error) lines.push(translateTemplate(uiLang.value, 'pg.mdError', { error: props.error }))
  if (props.body) {
    const lang = isJson.value ? 'json' : ''
    const body = isJson.value ? JSON.stringify(parsed.value, null, 2) : props.body
    lines.push('', fence(body, lang))
  }
  return lines.join('\n')
}

defineExpose({ toMarkdown })
</script>

<template>
  <div v-if="status !== null || error" class="pg-response mt-3">
    <div class="d-flex align-center ga-2 pa-2 pg-response-header">
      <span class="text-subtitle-2 font-weight-medium">{{ t('pg.response') }}</span>
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
      <v-btn variant="flat" @click="emit('clear')">{{ t('pg.clear') }}</v-btn>
    </div>

    <div v-if="error" class="pa-3 pg-error">{{ error }}</div>

    <div v-if="body && !error" class="pa-2">
      <div class="d-flex align-center ga-2 mb-1">
        <!-- view mode toggle: JSON tree / raw text -->
        <template v-if="isJson">
          <v-btn :variant="mode === 'json' ? 'flat' : 'text'" @click="mode = 'json'">{{
            t('pg.tree')
          }}</v-btn>
          <v-btn :variant="mode === 'raw' ? 'flat' : 'text'" @click="mode = 'raw'">{{
            t('pg.raw')
          }}</v-btn>
        </template>
        <template v-else>
          <v-btn variant="text" @click="rawOpen = !rawOpen">
            {{ rawOpen ? '▼' : '▶' }} {{ t('pg.raw') }}
          </v-btn>
        </template>
        <v-spacer />
        <v-btn variant="flat" @click="emit('copyRaw')">{{ t('pg.copy') }}</v-btn>
        <v-btn variant="flat" @click="downloadBody">{{ t('pg.download') }}</v-btn>
      </div>

      <!-- JSON tree view -->
      <div v-if="isJson && mode === 'json'" class="pg-jsontree">
        <FoldingJson :data="parsed" :depth="0" />
      </div>

      <!-- raw text view -->
      <pre v-if="(isJson && mode === 'raw') || (!isJson && rawOpen)" class="pg-rawbody">{{
        body
      }}</pre>
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
.pg-jsontree {
  max-height: 320px;
  overflow: auto;
  background: rgba(var(--v-theme-surface), 0.35);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.16);
  border-radius: 8px;
  padding: 8px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 0.75rem;
  line-height: 1.5;
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
