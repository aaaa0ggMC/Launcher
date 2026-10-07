<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import type { Ref } from 'vue'
import { useI18n } from '@ui/i18n'
import type { ToolViewProps } from '../../components/plugin-ui'
import { renderMarkdown } from '../../components/markdown'

defineOptions({ name: 'yaya-tool-deputy-result' })

const props = defineProps<ToolViewProps>()

const lang = inject('cockpit:lang', ref('zh')) as Ref<string>
const { t, te } = useI18n(lang)

interface Row {
  name: string
  task: string
  status: string
  report: string
  error: string
  calls: number
  failedCalls: number
  rounds: number
  exhausted: boolean
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const rows = computed<Row[]>(() => {
  const list = (props.call.result as { deputies?: unknown } | undefined)?.deputies
  if (!Array.isArray(list)) return []
  return list.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>
    return {
      name: str(o.name),
      task: str(o.task),
      status: str(o.status) || 'ok',
      report: str(o.report),
      error: str(o.error),
      calls: int(o.calls),
      failedCalls: int(o.failedCalls),
      rounds: int(o.rounds),
      exhausted: o.exhausted === true
    }
  })
})

/** 失败时 display 兜底成 { text } */
const errorText = computed(() =>
  rows.value.length ? '' : str((props.call.result as { text?: unknown } | undefined)?.text)
)

const open = ref<Record<number, boolean>>({})
const labels = computed(() => ({ copy: t('yaya.copy', '复制') }))
const md = (text: string): string => renderMarkdown(text, labels.value)

function icon(r: Row): { icon: string; color?: string } {
  if (r.status === 'error') return { icon: 'mdi-close-circle-outline', color: 'error' }
  if (r.status === 'stopped') return { icon: 'mdi-stop-circle-outline' }
  return { icon: 'mdi-check-circle-outline', color: 'success' }
}
</script>

<template>
  <div class="deputies">
    <p v-if="errorText" class="dp-error text-error">{{ errorText }}</p>
    <div v-for="(r, i) in rows" :key="i" class="dp">
      <button type="button" class="dp-head" :aria-expanded="!!open[i]" @click="open[i] = !open[i]">
        <v-icon :icon="icon(r).icon" :color="icon(r).color" size="18" />
        <span class="dp-name">{{ r.name }}</span>
        <span class="dp-meta">
          <span>{{ te('yaya.deputy.view.calls', { n: String(r.calls) }, '{n} 次工具调用') }}</span>
          <span v-if="r.failedCalls" class="text-error">{{
            te('yaya.deputy.view.failed', { n: String(r.failedCalls) }, '{n} 次失败')
          }}</span>
          <span class="dp-hide-narrow">{{
            te('yaya.deputy.view.rounds', { n: String(r.rounds) }, '{n} 轮')
          }}</span>
          <span v-if="r.exhausted" class="text-warning">{{
            t('yaya.deputy.view.exhausted', '轮数用完')
          }}</span>
        </span>
        <v-icon
          icon="mdi-chevron-down"
          size="18"
          class="dp-chevron"
          :class="{ 'is-open': open[i] }"
        />
      </button>
      <v-expand-transition>
        <div v-if="open[i]" class="dp-body">
          <div class="dp-label">{{ t('yaya.deputy.view.task', '任务') }}</div>
          <p class="dp-task">{{ r.task }}</p>
          <div class="dp-label">{{ t('yaya.deputy.view.report', '报告') }}</div>
          <p v-if="r.status === 'error'" class="dp-task text-error">{{ r.error }}</p>
          <p v-else-if="r.status === 'stopped'" class="dp-task text-medium-emphasis">
            {{ t('yaya.deputy.view.stopped', '已停止') }}
          </p>
          <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义原始 HTML -->
          <div v-else-if="r.report" class="md-body dp-report" v-html="md(r.report)" />
          <p v-else class="dp-task text-medium-emphasis">
            {{ t('yaya.deputy.view.empty', '（没有报告）') }}
          </p>
        </div>
      </v-expand-transition>
    </div>
  </div>
</template>

<style scoped>
.deputies {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dp {
  border-radius: 10px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  overflow: hidden;
}
.dp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 8px 12px;
  border: none;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.dp-head:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.dp-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.875rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dp-meta {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  font-size: 0.8rem;
  color: rgba(var(--v-theme-on-surface), 0.6);
  font-variant-numeric: tabular-nums;
}
.dp-chevron {
  flex-shrink: 0;
  opacity: 0.6;
  transition: transform 0.2s ease;
}
.dp-chevron.is-open {
  transform: rotate(180deg);
}
.dp-body {
  padding: 4px 14px 14px;
}
.dp-label {
  margin: 8px 0 4px;
  font-size: 0.75rem;
  font-weight: 500;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.dp-task {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.dp-report {
  font-size: 0.875rem;
}
.dp-error {
  margin: 0;
  font-size: 0.875rem;
}
@media (max-width: 480px) {
  .dp-hide-narrow {
    display: none;
  }
}
</style>
