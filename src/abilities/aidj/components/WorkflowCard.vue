<script setup lang="ts">
/**
 * One agent batch as a card: header (playbook, status, step, time), a timeline
 * of every tool the workflow went through (which agent ran it + a one-line
 * summary, expandable to raw args / result), and the batch outcome.
 * Expanded while running; collapses to a one-line summary when done.
 */
import { ref, computed, watch, onUnmounted, inject } from 'vue'
import type { Ref } from 'vue'
import { translate, translateTemplate } from '../../../main/ui/i18n'
import { formatMs, formatTokens, type WfView, type WfText, type WfAgent } from './workflow-view'

const props = defineProps<{ wf: WfView }>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback: string): string => translate(uiLang.value, key, fallback)
const tv = (key: string, vars: Record<string, string | number>, fallback: string): string =>
  translateTemplate(
    uiLang.value,
    key,
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])),
    fallback
  )
const tt = (x: WfText): string => tv(x.key, x.vars, x.fallback)

const running = computed(() => props.wf.status === 'running')
const open = ref(running.value)
watch(running, (r) => {
  // Collapse automatically once the batch finishes; reopen if a new run starts.
  open.value = r
})

const expanded = ref<Set<string>>(new Set())
function toggleStep(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

// Live elapsed time while running.
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
watch(
  running,
  (r) => {
    if (r && !timer) timer = setInterval(() => (now.value = Date.now()), 500)
    if (!r && timer) {
      clearInterval(timer)
      timer = null
    }
  },
  { immediate: true }
)
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const batchTokens = computed(() => props.wf.usage.prompt + props.wf.usage.completion)

const elapsed = computed(() => {
  if (props.wf.end) return props.wf.end.ms
  return props.wf.startedAt ? Math.max(0, now.value - props.wf.startedAt) : 0
})

const AGENT_NAME: Record<WfAgent, string> = {
  loop: 'LoopAgent',
  dream: 'DreamAgent',
  lib: 'LibAgent',
  rank: 'RankAgent'
}

const statusIcon = computed(() =>
  running.value
    ? 'mdi-progress-clock'
    : props.wf.status === 'error'
      ? 'mdi-alert-circle-outline'
      : 'mdi-check-circle-outline'
)
const statusColor = computed(() =>
  running.value ? 'primary' : props.wf.status === 'error' ? 'error' : 'success'
)

const headerSummary = computed(() => {
  const w = props.wf
  if (running.value) {
    if (w.stage === 'rank') return t('aidj.wf.ranking', 'RankAgent 排序中')
    const step = w.maxSteps
      ? tv('aidj.wf.step', { n: w.step, max: w.maxSteps }, '第 {n} 轮 · 上限 {max}')
      : ''
    return [t('aidj.wf.running', '运行中'), step].filter(Boolean).join(' · ')
  }
  if (w.end && w.status === 'error') {
    return tv('aidj.wf.failed', { error: w.end.error ?? '' }, '失败：{error}')
  }
  if (w.end?.noMusic) {
    return tv(
      'aidj.wf.result_chat',
      { rounds: w.end.steps, tools: w.steps.length },
      '仅对话 · {rounds} 轮 · {tools} 次调用'
    )
  }
  if (w.end) {
    return tv(
      'aidj.wf.result',
      {
        rounds: w.end.steps,
        tools: w.steps.length,
        c: w.end.candidates,
        q: w.end.queued,
        d: w.end.dropped
      },
      '{rounds} 轮 · {tools} 次调用 · 候选 {c} → 入选 {q} · 剔除 {d}'
    )
  }
  return ''
})

function pretty(v: unknown): string {
  if (typeof v === 'string') {
    try {
      return JSON.stringify(JSON.parse(v), null, 2)
    } catch {
      return v
    }
  }
  return JSON.stringify(v ?? null, null, 2)
}
</script>

<template>
  <div class="wf-card" :class="`wf-${wf.status}`">
    <button
      type="button"
      class="wf-head d-flex align-center ga-2 px-3 py-2"
      :title="t('aidj.wf.toggle', '展开 / 收起 workflow')"
      :aria-label="`${t('aidj.wf.title', 'Workflow')}: ${headerSummary}`"
      :aria-expanded="open"
      @click="open = !open"
    >
      <v-progress-circular v-if="running" indeterminate size="16" width="2" color="primary" />
      <v-icon v-else size="18" :color="statusColor">{{ statusIcon }}</v-icon>
      <span class="text-body-2 font-weight-medium">{{ t('aidj.wf.title', 'Workflow') }}</span>
      <span v-if="wf.playbook" class="wf-badge wf-badge-playbook">{{ wf.playbook }}</span>
      <span class="text-caption text-medium-emphasis wf-head-summary">{{ headerSummary }}</span>
      <v-spacer />
      <span
        v-if="batchTokens"
        class="text-caption text-medium-emphasis"
        :title="t('aidj.wf.tokens_title', '这一批所有 LLM 调用的 tokens（含子 Agent）')"
        >{{ formatTokens(batchTokens) }} tokens</span
      >
      <span class="text-caption text-medium-emphasis">{{ formatMs(elapsed) }}</span>
      <v-icon size="18" class="text-medium-emphasis">
        {{ open ? 'mdi-chevron-up' : 'mdi-chevron-down' }}
      </v-icon>
    </button>

    <div v-if="open" class="wf-body px-3 pb-3">
      <div v-if="wf.goal" class="text-caption text-medium-emphasis pt-1 pb-2 wf-goal">
        {{ t('aidj.wf.goal', '目标') }}：{{ wf.goal }}
      </div>
      <div v-if="!wf.steps.length && running" class="text-caption text-medium-emphasis py-2">
        {{ t('aidj.wf.thinking', 'LoopAgent 思考中…') }}
      </div>
      <ol class="wf-steps">
        <li v-for="s in wf.steps" :key="s.id" class="wf-step">
          <button
            type="button"
            class="wf-step-row d-flex align-center ga-2 py-1"
            :title="t('aidj.wf.step_toggle', '展开 / 收起参数与结果')"
            :aria-label="`${AGENT_NAME[s.agent]} ${tt(s.label)}`"
            :aria-expanded="expanded.has(s.id)"
            @click="toggleStep(s.id)"
          >
            <span class="wf-dot" :class="`wf-dot-${s.status}`" />
            <span class="wf-badge" :class="`wf-agent-${s.agent}`">{{ AGENT_NAME[s.agent] }}</span>
            <span class="text-body-2 wf-label">{{ tt(s.label) }}</span>
            <span v-if="s.summary" class="text-caption text-medium-emphasis wf-summary">
              {{ tt(s.summary) }}
            </span>
            <v-progress-circular
              v-else-if="s.status === 'running'"
              indeterminate
              size="12"
              width="2"
              color="primary"
            />
            <v-spacer />
            <span v-if="s.ms != null" class="text-caption text-medium-emphasis wf-ms">
              {{ formatMs(s.ms) }}
            </span>
          </button>
          <div v-if="expanded.has(s.id)" class="wf-detail pa-3 mb-2">
            <div class="text-caption text-medium-emphasis mb-1">
              {{ t('aidj.btchat.tool_args', '参数') }}
            </div>
            <pre class="wf-pre">{{ pretty(s.args) }}</pre>
            <template v-if="s.result != null">
              <div class="text-caption text-medium-emphasis mt-3 mb-1">
                {{ t('aidj.btchat.tool_result', '结果') }}
              </div>
              <pre class="wf-pre">{{ pretty(s.result) }}</pre>
            </template>
          </div>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.wf-card {
  width: 100%;
  max-width: 680px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  background: rgba(var(--v-theme-surface-variant), 0.3);
  overflow: hidden;
}
.wf-card.wf-error {
  border-color: rgba(var(--v-theme-error), 0.45);
}
.wf-head {
  width: 100%;
  min-height: 40px;
  flex-wrap: wrap;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  text-align: left;
  cursor: pointer;
}
.wf-head:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.wf-head-summary {
  min-width: 0;
}
/* 窄屏：头部一行元素（状态点 + 标题 + playbook + 摘要 + tokens + 耗时 + 箭头）放不下，
   让「摘要」单独占一整行，避免被 flex-shrink 挤成一条缝。 */
@media (max-width: 720px) {
  .wf-head-summary {
    flex: 1 1 100%;
    min-width: 0;
  }
}
.wf-goal {
  word-break: break-word;
}
.wf-steps {
  list-style: none;
  margin: 0;
  padding: 0 0 0 6px;
  border-left: 2px solid rgba(var(--v-theme-on-surface), 0.1);
}
.wf-step {
  position: relative;
}
.wf-step-row {
  width: 100%;
  min-height: 32px;
  flex-wrap: wrap;
  padding-left: 10px;
  padding-right: 4px;
  border-radius: 8px;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  text-align: left;
  cursor: pointer;
}
.wf-step-row:hover {
  background: rgba(var(--v-theme-on-surface), 0.05);
}
.wf-dot {
  position: absolute;
  left: -12px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid rgb(var(--v-theme-surface));
  background: rgba(var(--v-theme-on-surface), 0.35);
}
.wf-dot-ok {
  background: rgb(var(--v-theme-success));
}
.wf-dot-error {
  background: rgb(var(--v-theme-error));
}
.wf-dot-running {
  background: rgb(var(--v-theme-primary));
}
.wf-badge {
  display: inline-flex;
  align-items: center;
  min-height: 22px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  flex-shrink: 0;
}
.wf-badge-playbook {
  font-family: ui-monospace, monospace;
  background: rgba(var(--v-theme-primary), 0.14);
  color: rgb(var(--v-theme-primary));
}
.wf-agent-loop {
  background: rgba(var(--v-theme-on-surface), 0.08);
  color: rgba(var(--v-theme-on-surface), 0.8);
}
.wf-agent-dream {
  background: rgba(var(--v-theme-secondary), 0.16);
  color: rgb(var(--v-theme-secondary));
}
.wf-agent-lib {
  background: rgba(var(--v-theme-info), 0.16);
  color: rgb(var(--v-theme-info));
}
.wf-agent-rank {
  background: rgba(var(--v-theme-success), 0.16);
  color: rgb(var(--v-theme-success));
}
.wf-label {
  flex-shrink: 0;
}
.wf-summary {
  min-width: 0;
  word-break: break-word;
}
.wf-ms {
  flex-shrink: 0;
}
.wf-detail {
  margin-left: 10px;
  border-radius: 10px;
  background: rgba(var(--v-theme-surface-variant), 0.35);
}
.wf-pre {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
