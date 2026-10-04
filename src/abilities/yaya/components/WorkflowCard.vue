<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { AssistantTurn, ProcessItem } from './turns'
import { processItems } from './turns'
import { renderMarkdown } from './markdown'
import ToolCallRow from './ToolCallRow.vue'

/**
 * 过程块：一段连续的思考 / 工具调用 / 子 Agent 步骤（AI 说的话在块外，见 turns.ts `turnSegments`）。
 * 一轮回答可能有多块；`first` 块显示工作流名，`last` 块在运行中显示「当前在做什么」。
 */
const props = withDefaults(
  defineProps<{
    turn: AssistantTurn
    assistantName: string
    live: boolean
    pendingApprovalId: string | null
    /** 这一块包含的条目（缺省 = 整轮） */
    items?: ProcessItem[]
    first?: boolean
    last?: boolean
  }>(),
  { items: undefined, first: true, last: true }
)

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const open = ref(false)
const openDetails = ref<Record<string, boolean>>({})

const items = computed<ProcessItem[]>(() => props.items ?? processItems(props.turn))
/** 本块在运行（整轮在运行且是最后一块） */
const blockLive = computed(() => props.live && props.last)

const toolCount = computed(() =>
  items.value.reduce(
    (n, it) =>
      it.kind === 'llm' && !it.answer && it.part !== 'reasoning'
        ? n + (it.node.toolCalls?.length ?? 0)
        : n,
    0
  )
)
const tokens = computed(() => {
  const seen = new Set<string>()
  let n = 0
  for (const it of items.value) {
    const r = it.rec
    if (!r?.tokens || seen.has(r.id)) continue
    seen.add(r.id)
    n += r.tokens
  }
  return n
})

// 运行中实时计时
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
watch(
  () => props.live,
  (live) => {
    if (live && !timer) timer = setInterval(() => (now.value = Date.now()), 500)
    if (!live && timer) {
      clearInterval(timer)
      timer = null
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => timer && clearInterval(timer))

/** 本块耗时：各步骤耗时之和；运行中的步骤按开始时间实时计 */
const elapsed = computed(() => {
  const seen = new Set<string>()
  let ms = 0
  for (const it of items.value) {
    const r = it.rec
    if (!r || seen.has(r.id)) continue
    seen.add(r.id)
    if (r.ms !== undefined) ms += r.ms
    else if (r.status === 'running' && props.live) ms += now.value - r.startedAt
  }
  return ms
})

/** 收起时的标题：这一块做了什么 */
const summary = computed(() => {
  if (toolCount.value)
    return te('yaya.wf.tool_count', { n: String(toolCount.value) }, '{n} 次工具调用')
  if (items.value.some((it) => it.kind !== 'llm')) return t('yaya.wf.process', '过程')
  return t('yaya.wf.thinking', '思考过程')
})

/** 运行中标题：当前在做什么 */
const activity = computed(() => {
  for (const s of props.turn.steps) {
    for (const c of s.toolCalls ?? []) {
      if (c.id === props.pendingApprovalId)
        return te('yaya.wf.awaiting', { name: c.name }, '等待你确认 {name}')
      if (c.status === 'executing')
        return te('yaya.wf.running_tool', { name: c.name }, '正在执行 {name}')
    }
  }
  const running = props.turn.workflow?.steps.find((s) => s.status === 'running')
  if (running && running.kind !== 'llm') return `${running.label}…`
  const last = props.turn.steps[props.turn.steps.length - 1]
  if (last?.reasoningContent && !last.content) return t('yaya.thinking_live', '思考中…')
  return t('yaya.wf.working', '处理中…')
})

const status = computed(() => {
  const w = props.turn.workflow
  if (blockLive.value) return 'running'
  if (props.live) return 'ok'
  if (w?.status === 'error' || props.turn.status === 'error') return 'error'
  if (w?.status === 'stopped') return 'stopped'
  return 'ok'
})

function agentName(agent: string): string {
  if (agent === 'main') return props.assistantName
  return t(`yaya.agent.${agent}`, agent)
}

function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const labels = computed(() => ({ copy: t('yaya.copy', '复制') }))
const md = (text: string): string => renderMarkdown(text, labels.value)
</script>

<template>
  <div class="wf" :class="`is-${status}`">
    <button
      type="button"
      class="wf-head"
      :aria-expanded="open"
      :title="open ? t('yaya.wf.collapse', '收起过程') : t('yaya.wf.expand', '展开过程')"
      @click="open = !open"
    >
      <v-progress-circular v-if="blockLive" indeterminate size="16" width="2" color="primary" />
      <v-icon
        v-else
        size="20"
        :icon="
          status === 'error'
            ? 'mdi-alert-circle-outline'
            : status === 'stopped'
              ? 'mdi-stop-circle-outline'
              : 'mdi-check-circle-outline'
        "
        :color="status === 'error' ? 'error' : status === 'stopped' ? undefined : 'success'"
      />
      <span class="wf-title">
        {{ blockLive ? activity : summary }}
      </span>
      <span v-if="first && turn.workflow" class="wf-badge">{{ turn.workflow.label }}</span>
      <span class="wf-spacer" />
      <span v-if="tokens" class="wf-meta wf-hide-narrow">{{ fmtTokens(tokens) }} tokens</span>
      <span v-if="elapsed" class="wf-meta">{{ fmtMs(elapsed) }}</span>
      <v-icon :icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'" size="18" class="wf-chevron" />
    </button>

    <div v-if="open" class="wf-body">
      <ol class="wf-timeline">
        <li v-for="item in items" :key="item.key" class="wf-item">
          <span class="wf-dot" :class="`is-${item.rec?.status ?? 'ok'}`" />

          <template v-if="item.kind === 'llm'">
            <div v-if="item.part !== 'tools' || !item.node.reasoningContent" class="wf-row">
              <span class="wf-agent">{{ agentName(item.rec?.agent ?? 'main') }}</span>
              <span class="wf-label">{{
                item.rec?.label ??
                (item.node.toolCalls?.length
                  ? t('yaya.wf.step.think', '思考与调用工具')
                  : t('yaya.wf.step.answer', '生成回答'))
              }}</span>
              <span class="wf-spacer" />
              <span v-if="item.rec?.tokens" class="wf-meta wf-hide-narrow">
                {{ fmtTokens(item.rec.tokens) }} tokens
              </span>
              <span v-if="item.rec?.ms !== undefined" class="wf-meta">{{
                fmtMs(item.rec.ms)
              }}</span>
            </div>
            <div v-if="item.part !== 'tools' && item.node.reasoningContent" class="wf-reasoning">
              {{ item.node.reasoningContent }}
            </div>
            <div
              v-if="item.part !== 'reasoning' && !item.answer && item.node.toolCalls?.length"
              class="wf-tools"
            >
              <ToolCallRow
                v-for="call in item.node.toolCalls"
                :key="call.id"
                :call="call"
                :awaiting-approval="false"
              />
            </div>
          </template>

          <template v-else>
            <button
              type="button"
              class="wf-row wf-row-btn"
              :disabled="!item.rec.detail"
              :aria-expanded="!!openDetails[item.key]"
              @click="openDetails[item.key] = !openDetails[item.key]"
            >
              <span class="wf-agent is-sub">{{ agentName(item.rec.agent) }}</span>
              <span class="wf-label">{{ item.rec.label }}</span>
              <v-progress-circular
                v-if="item.rec.status === 'running'"
                indeterminate
                size="12"
                width="2"
                color="primary"
              />
              <span class="wf-spacer" />
              <span v-if="item.rec.tokens" class="wf-meta wf-hide-narrow">
                {{ fmtTokens(item.rec.tokens) }} tokens
              </span>
              <span v-if="item.rec.ms !== undefined" class="wf-meta">{{ fmtMs(item.rec.ms) }}</span>
              <v-icon
                v-if="item.rec.detail"
                :icon="openDetails[item.key] ? 'mdi-chevron-up' : 'mdi-chevron-down'"
                size="16"
                class="wf-chevron"
              />
            </button>
            <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义原始 HTML -->
            <div
              v-if="openDetails[item.key] && item.rec.detail"
              class="wf-text"
              v-html="md(item.rec.detail)"
            />
          </template>
        </li>
        <li v-if="items.length === 0" class="wf-item wf-empty">
          {{ t('yaya.wf.no_steps', '还没有过程步骤') }}
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.wf {
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-on-surface), 0.025);
  overflow: hidden;
}
.wf.is-error {
  border-color: rgba(var(--v-theme-error), 0.35);
}
.wf-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 46px;
  padding: 8px 12px;
  border: none;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.wf-head:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.wf-title {
  font-size: 0.875rem;
  font-weight: 500;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  min-height: 20px;
  line-height: 16px;
  border-radius: 999px;
  font-size: 0.72rem;
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}
.wf-meta {
  flex-shrink: 0;
  font-size: 0.8rem;
  color: rgba(var(--v-theme-on-surface), 0.6);
  font-variant-numeric: tabular-nums;
}
.wf-spacer {
  flex: 1 1 auto;
}
.wf-chevron {
  flex-shrink: 0;
  opacity: 0.6;
}
.wf-body {
  padding: 4px 12px 12px;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.wf-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
}
.wf-item {
  position: relative;
  padding: 10px 0 10px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
/* 竖向时间线 */
.wf-item::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(var(--v-theme-on-surface), 0.12);
}
.wf-item:first-child::before {
  top: 18px;
}
.wf-item:last-child::before {
  bottom: calc(100% - 18px);
}
.wf-dot {
  position: absolute;
  left: 0;
  top: 14px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgb(var(--v-theme-success));
  box-shadow: 0 0 0 3px rgb(var(--v-theme-surface));
}
.wf-dot.is-running {
  background: rgb(var(--v-theme-primary));
  animation: wf-pulse 1.2s ease-in-out infinite;
}
.wf-dot.is-error {
  background: rgb(var(--v-theme-error));
}
@keyframes wf-pulse {
  50% {
    opacity: 0.35;
  }
}
.wf-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  min-width: 0;
}
.wf-row-btn {
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.wf-row-btn:disabled {
  cursor: default;
}
.wf-agent {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 0.72rem;
  font-weight: 600;
  background: rgba(var(--v-theme-on-surface), 0.07);
}
.wf-agent.is-sub {
  background: rgba(var(--v-theme-secondary), 0.16);
  color: rgb(var(--v-theme-secondary));
}
.wf-label {
  font-size: 0.85rem;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-reasoning {
  padding-left: 12px;
  border-left: 2px solid rgba(var(--v-theme-on-surface), 0.15);
  color: rgba(var(--v-theme-on-surface), 0.7);
  font-size: 0.85rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}
.wf-text {
  font-size: 0.875rem;
  line-height: 1.6;
  color: rgba(var(--v-theme-on-surface), 0.85);
  word-break: break-word;
}
.wf-text :deep(p) {
  margin: 0 0 0.5em;
}
.wf-text :deep(p:last-child) {
  margin-bottom: 0;
}
.wf-text :deep(pre) {
  overflow-x: auto;
  font-size: 0.8rem;
}
.wf-text :deep(.md-math-display) {
  display: block;
  overflow-x: auto;
  overflow-y: hidden;
}
.wf-text :deep(.md-code-head) {
  display: none;
}
.wf-tools {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wf-empty {
  color: rgba(var(--v-theme-on-surface), 0.6);
  font-size: 0.85rem;
}
@media (max-width: 720px) {
  .wf-hide-narrow {
    display: none;
  }
  .wf-head {
    padding: 8px 10px;
    gap: 8px;
  }
}

@container yaya (max-width: 600px) {
  .wf-head {
    min-height: 40px;
    padding: 6px 10px;
    gap: 8px;
  }
  .wf-title {
    font-size: 0.82rem;
  }
  .wf-meta {
    font-size: 0.72rem;
  }
  .wf-hide-narrow {
    display: none;
  }
  .wf-body {
    padding: 2px 10px 10px;
  }
  .wf-item {
    padding: 8px 0 8px 18px;
    gap: 6px;
  }
  .wf-label,
  .wf-text {
    font-size: 0.82rem;
  }
  .wf-reasoning {
    font-size: 0.8rem;
  }
}
</style>
