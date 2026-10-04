<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import { highlightCode } from '../../components/markdown'
import type { ToolViewProps } from '../../components/plugin-ui'

defineOptions({ name: 'cockpit-yaya-tool-command-run' })

const props = defineProps<ToolViewProps>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t } = useI18n(lang)

/** 单个 JSON 块的最大长度，避免一条超长响应把卡片撑爆 */
const MAX_JSON_CHARS = 20_000

const commandName = computed<string>(() => {
  const a = props.call.args as { name?: unknown } | string | undefined
  if (typeof a === 'string') return a
  const name = a && typeof a === 'object' ? a.name : undefined
  return typeof name === 'string' ? name : ''
})

const failed = computed<boolean>(() => props.call.status === 'failed' || Boolean(props.call.error))

interface ScalarField {
  key: string
  value: string
  danger: boolean
}
interface JsonBlock {
  key: string
  json: string
  danger: boolean
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}
function scalarText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v)
}
function clip(s: string): string {
  return s.length > MAX_JSON_CHARS ? `${s.slice(0, MAX_JSON_CHARS)}\n…` : s
}

/** 标量 → 「键: 值」；复杂值 → 折叠的高亮 JSON 块 */
const scalars = computed<ScalarField[]>(() => {
  const res = props.call.result
  if (isScalar(res)) {
    return res === null || res === undefined
      ? []
      : [{ key: '', value: scalarText(res), danger: false }]
  }
  if (!res || typeof res !== 'object' || Array.isArray(res)) return []
  return Object.entries(res as Record<string, unknown>)
    .filter(([, v]) => isScalar(v))
    .map(([k, v]) => ({
      key: k,
      value: scalarText(v),
      danger: k === 'error' || k === 'stderr'
    }))
})

const blocks = computed<JsonBlock[]>(() => {
  const res = props.call.result
  if (isScalar(res)) return []
  if (!res || typeof res !== 'object') return []
  if (Array.isArray(res)) {
    return [{ key: '', json: clip(JSON.stringify(res, null, 2)), danger: false }]
  }
  return Object.entries(res as Record<string, unknown>)
    .filter(([, v]) => !isScalar(v))
    .map(([k, v]) => ({
      key: k,
      json: clip(JSON.stringify(v ?? null, null, 2)),
      danger: k === 'error' || k === 'stderr'
    }))
})

const opened = ref<Record<string, boolean>>({})
function toggle(key: string): void {
  opened.value = { ...opened.value, [key]: !opened.value[key] }
}
/** 高亮后的 HTML（highlightCode 内部已转义，highlight.js 未加载时回落转义纯文本） */
function blockHtml(json: string): string {
  return highlightCode(json, 'json')
}
</script>

<template>
  <div class="run">
    <div class="run-head">
      <v-icon
        :icon="failed ? 'mdi-close-circle-outline' : 'mdi-check-circle-outline'"
        :color="failed ? 'error' : 'success'"
        size="18"
      />
      <span class="run-name">{{ commandName }}</span>
      <v-chip variant="tonal" :color="failed ? 'error' : 'success'" class="chip-pad flex-shrink-0">
        {{
          failed
            ? t('yaya.plugin.cockpit.run_failed', '失败')
            : t('yaya.plugin.cockpit.run_ok', '成功')
        }}
      </v-chip>
    </div>

    <div v-if="scalars.length" class="run-fields">
      <div v-for="f in scalars" :key="f.key" class="run-inline">
        <span v-if="f.key" class="run-key">{{ f.key }}</span>
        <span class="run-value" :class="{ 'text-error': f.danger }">{{ f.value }}</span>
      </div>
    </div>

    <div v-for="b in blocks" :key="b.key" class="run-block">
      <button
        type="button"
        class="run-block-head"
        :aria-expanded="!!opened[b.key]"
        :title="t('yaya.plugin.cockpit.run_toggle', '展开 / 收起 JSON')"
        @click="toggle(b.key)"
      >
        <v-icon
          :icon="opened[b.key] ? 'mdi-chevron-down' : 'mdi-chevron-right'"
          size="16"
          class="text-medium-emphasis"
        />
        <span v-if="b.key" class="run-key">{{ b.key }}</span>
        <span v-else class="text-caption text-medium-emphasis">JSON</span>
      </button>
      <!-- eslint-disable-next-line vue/no-v-html -- highlightCode 输出已转义 -->
      <pre
        v-if="opened[b.key]"
        class="run-pre hl"
        :class="{ 'text-error': b.danger }"
        v-html="blockHtml(b.json)"
      />
    </div>

    <div v-if="call.error" class="run-block">
      <div class="run-key text-error">{{ t('yaya.tool.error', '错误') }}</div>
      <pre class="run-pre text-error">{{ call.error }}</pre>
    </div>
  </div>
</template>

<style scoped>
.run {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* chip：默认密度 + 显式内边距，label 不贴边框 */
.chip-pad {
  padding-block: 4px;
  min-height: 24px;
}
.run-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 0;
}
.run-name {
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
  font-weight: 600;
  min-width: 0;
  overflow-wrap: anywhere;
}
.run-fields {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.run-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  font-size: 0.8rem;
  min-width: 0;
}
.run-key {
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.run-value {
  font-family: ui-monospace, monospace;
  min-width: 0;
  overflow-wrap: anywhere;
}
.run-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.run-block-head {
  display: flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  padding: 2px 4px;
  border: none;
  border-radius: 6px;
  background: none;
  color: inherit;
  cursor: pointer;
}
.run-block-head:hover {
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.run-pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.05);
  font-family: ui-monospace, monospace;
  font-size: 0.78rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}
/* 高亮配色跟主题（与正文代码块一致） */
.hl :deep(.hljs-keyword),
.hl :deep(.hljs-built_in) {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
.hl :deep(.hljs-string) {
  color: rgb(var(--v-theme-success));
}
.hl :deep(.hljs-number),
.hl :deep(.hljs-literal) {
  color: rgb(var(--v-theme-warning));
}
.hl :deep(.hljs-attr),
.hl :deep(.hljs-variable),
.hl :deep(.hljs-template-variable) {
  color: rgb(var(--v-theme-info));
}
.hl :deep(.hljs-comment) {
  color: rgba(var(--v-theme-on-surface), 0.5);
  font-style: italic;
}
.hl :deep(.hljs-meta),
.hl :deep(.hljs-punctuation) {
  color: rgba(var(--v-theme-on-surface), 0.6);
}
@media (max-width: 720px) {
  .run-pre {
    font-size: 0.74rem;
  }
}
</style>
