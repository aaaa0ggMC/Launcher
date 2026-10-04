<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { ToolCallItem } from '../types'
import { summarizeArgs } from './turns'

const props = defineProps<{
  call: ToolCallItem
  /** 这条调用正挂起等待用户确认（且 Runner 还活着，按钮可用） */
  awaitingApproval: boolean
}>()

const emit = defineEmits<{
  (e: 'approve', approved: boolean): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const open = ref(false)
const summary = computed(() => summarizeArgs(props.call))
const argsText = computed(() =>
  typeof props.call.args === 'string' ? props.call.args : JSON.stringify(props.call.args, null, 2)
)
const resultText = computed(() => {
  const r = props.call.result
  if (r === undefined || r === null) return ''
  const s = typeof r === 'string' ? r : JSON.stringify(r, null, 2)
  return s.length > 20000 ? `${s.slice(0, 20000)}\n…` : s
})

const statusIcon = computed(() => {
  switch (props.call.status) {
    case 'success':
      return { icon: 'mdi-check-circle-outline', color: 'success' }
    case 'failed':
      return { icon: 'mdi-close-circle-outline', color: 'error' }
    case 'awaiting_approval':
      return { icon: 'mdi-shield-alert-outline', color: 'warning' }
    default:
      return { icon: 'mdi-wrench-outline', color: undefined }
  }
})
const running = computed(() => props.call.status === 'executing')
const duration = computed(() => {
  const ms = props.call.ms
  if (ms === undefined) return ''
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
})
</script>

<template>
  <div class="tool-row" :class="{ 'is-awaiting': awaitingApproval }">
    <button
      type="button"
      class="tool-head"
      :aria-expanded="open"
      :title="open ? t('yaya.tool.collapse', '收起详情') : t('yaya.tool.expand', '展开详情')"
      @click="open = !open"
    >
      <v-progress-circular v-if="running" indeterminate size="16" width="2" color="primary" />
      <v-icon v-else :icon="statusIcon.icon" :color="statusIcon.color" size="18" />
      <span class="tool-name">{{ call.name }}</span>
      <span class="tool-summary text-medium-emphasis">{{ summary }}</span>
      <span v-if="duration" class="tool-ms text-disabled">{{ duration }}</span>
      <v-icon
        :icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'"
        size="18"
        class="flex-shrink-0 text-medium-emphasis"
      />
    </button>

    <div v-if="awaitingApproval" class="approval">
      <div class="text-body-2">
        {{ t('yaya.tool.approval_hint', '这个操作会修改系统状态，确认参数无误后再允许执行。') }}
      </div>
      <pre class="tool-pre approval-pre">{{ argsText }}</pre>
      <div class="d-flex flex-wrap ga-2">
        <v-btn
          color="primary"
          variant="flat"
          prepend-icon="mdi-check"
          @click="emit('approve', true)"
        >
          {{ t('yaya.tool.approve', '允许执行') }}
        </v-btn>
        <v-btn variant="outlined" prepend-icon="mdi-close" @click="emit('approve', false)">
          {{ t('yaya.tool.reject', '拒绝') }}
        </v-btn>
      </div>
    </div>

    <div v-if="open" class="tool-body">
      <div class="tool-label">{{ t('yaya.tool.args', '参数') }}</div>
      <pre class="tool-pre">{{ argsText }}</pre>
      <template v-if="resultText">
        <div class="tool-label">{{ t('yaya.tool.result', '结果') }}</div>
        <pre class="tool-pre">{{ resultText }}</pre>
      </template>
      <template v-if="call.error">
        <div class="tool-label text-error">{{ t('yaya.tool.error', '错误') }}</div>
        <pre class="tool-pre text-error">{{ call.error }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tool-row {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px;
  background: rgba(var(--v-theme-surface-variant), 0.22);
  overflow: hidden;
}
.tool-row.is-awaiting {
  border-color: rgba(var(--v-theme-warning), 0.5);
}
.tool-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 40px;
  padding: 8px 12px;
  background: none;
  border: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.tool-head:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.tool-name {
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
  font-weight: 600;
  flex-shrink: 0;
}
.tool-summary {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-ms {
  font-size: 0.75rem;
  flex-shrink: 0;
}
.approval {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 12px 12px;
}
.tool-body {
  padding: 4px 12px 12px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.tool-label {
  font-size: 0.75rem;
  font-weight: 600;
  opacity: 0.7;
  margin: 10px 0 4px;
}
.tool-pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.05);
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}
.approval-pre {
  max-height: 200px;
}
@media (max-width: 720px) {
  /* 窄屏：参数摘要换到第二行，名称独占首行 */
  .tool-head {
    flex-wrap: wrap;
    row-gap: 2px;
  }
  .tool-summary {
    order: 10;
    flex: 1 1 100%;
    padding-left: 28px;
  }
  .tool-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
