<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import { vLongPress, type LongPressPoint } from '../../../main/ui/directives/long-press'
import type { ApprovalScope, ToolCallItem } from '../types'
import type { AssistantTurn } from './turns'
import { answerStep, hasProcess, turnSegments, turnText } from './turns'
import { renderSegments, handleMarkdownClick } from './markdown'
import { fenceLangs, fenceViewFor } from './plugin-ui-registry'
import type { MessageMenuRequest } from './message-menu'
import ToolCallRow from './ToolCallRow.vue'
import BranchSwitcher from './BranchSwitcher.vue'
import WorkflowCard from './WorkflowCard.vue'

const props = defineProps<{
  turn: AssistantTurn
  assistantName: string
  /** 本轮正在运行（流式 / 工具执行 / 等待确认） */
  live: boolean
  /** 正挂起等待确认的工具调用 id（Runner 活着时才有） */
  pendingApprovalId: string | null
  /** 是否为当前分支的最后一轮（决定操作栏是否常显） */
  isLast: boolean
  /** 过程卡片收起时预览的步数（设置项「收起时显示最近几步」） */
  previewSteps?: number
}>()

const emit = defineEmits<{
  (e: 'switchBranch', messageId: string): void
  (e: 'approve', approved: boolean, reason?: string, scope?: ApprovalScope): void
  (e: 'regenerate', fromMessageId: string): void
  (e: 'menu', req: MessageMenuRequest): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const copied = ref(false)
const answer = computed(() => answerStep(props.turn))
const showProcess = computed(() => hasProcess(props.turn))
const labels = computed(() => ({ copy: t('yaya.copy', '复制') }))
/** 回答切段：插件接管的代码块（```mermaid 等）渲染成组件，其余是 Markdown HTML */
const answerSegments = computed(() =>
  answer.value?.content ? renderSegments(answer.value.content, fenceLangs.value, labels.value) : []
)

/**
 * 过程块与 AI 中途说的话交错显示（说的话不再藏进过程卡片，只有思考 / 工具调用收起）。
 * 说的话与最终回答用同一套 Markdown 分段（插件代码块照样接管）。
 */
const segments = computed(() =>
  showProcess.value
    ? turnSegments(props.turn).map((seg) =>
        seg.kind === 'text'
          ? { ...seg, parts: renderSegments(seg.node.content, fenceLangs.value, labels.value) }
          : seg
      )
    : []
)
const lastProcessKey = computed(() => {
  for (let i = segments.value.length - 1; i >= 0; i--)
    if (segments.value[i].kind === 'process') return segments.value[i].key
  return ''
})
const firstProcessKey = computed(() => segments.value.find((s) => s.kind === 'process')?.key ?? '')
/** 运行中：最后一块过程之后已经有 AI 在说的话 → 这些话才是「当前」，过程块不再转圈 */
const textAfterLastProcess = computed(() => {
  const i = segments.value.findIndex((s) => s.key === lastProcessKey.value)
  return i >= 0 && i < segments.value.length - 1
})

/** 挂起等待确认的工具调用：固定显示在过程卡片外面，避免被折叠藏起来 */
const pendingCall = computed<ToolCallItem | null>(() => {
  if (!props.pendingApprovalId) return null
  for (const s of props.turn.steps)
    for (const c of s.toolCalls ?? []) if (c.id === props.pendingApprovalId) return c
  return null
})

/** 还没有任何可见内容：显示打字点 */
const waiting = computed(() => {
  if (!props.live) return false
  if (answer.value?.content) return false
  return !showProcess.value
})

/** 最后一个出错 / 中断的步骤 */
const problem = computed(() => {
  for (let i = props.turn.steps.length - 1; i >= 0; i--) {
    const s = props.turn.steps[i]
    if (s.status === 'error' || s.status === 'interrupted') return s
  }
  return null
})
const stoppedByUser = computed(
  () => problem.value?.status === 'interrupted' && problem.value.error === 'aborted'
)

/** 实际生成本轮回答的模型（取最后一步；中途换过模型时以最后一步为准） */
const modelUsed = computed(() => {
  for (let i = props.turn.steps.length - 1; i >= 0; i--) {
    const m = props.turn.steps[i].meta?.model
    if (m) return m
  }
  return ''
})
const providerUsed = computed(
  () => props.turn.steps.find((s) => s.meta?.provider)?.meta?.provider ?? ''
)

const usage = computed(() => {
  if (props.turn.workflow?.tokens) return props.turn.workflow.tokens
  return props.turn.steps.reduce((n, s) => n + (s.usage?.total ?? 0), 0)
})

function onContentClick(ev: MouseEvent): void {
  if (handleMarkdownClick(ev, t('yaya.copied', '已复制'))) ev.preventDefault()
}

function openMenu(x: number, y: number): void {
  emit('menu', {
    x,
    y,
    kind: 'assistant',
    messageId: props.turn.firstId,
    text: turnText(props.turn),
    selection: window.getSelection()?.toString() ?? ''
  })
}
function onContextMenu(ev: MouseEvent): void {
  ev.preventDefault()
  openMenu(ev.clientX, ev.clientY)
}
function onLongPress(p: LongPressPoint): void {
  openMenu(p.clientX, p.clientY)
}

async function copyTurn(): Promise<void> {
  await window.cockpit.copyText(turnText(props.turn))
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <div class="assistant-turn">
    <div class="avatar" aria-hidden="true">
      <v-icon icon="mdi-robot-happy-outline" size="22" />
    </div>

    <div class="turn-col">
      <div class="turn-head">
        <span class="turn-name">{{ assistantName }}</span>
        <BranchSwitcher
          v-if="turn.siblingIds && turn.siblingIds.length > 1"
          :ids="turn.siblingIds"
          :current="turn.firstId"
          @switch="(id) => emit('switchBranch', id)"
        />
      </div>

      <div
        v-long-press="onLongPress"
        class="bubble"
        @contextmenu="onContextMenu"
        @click="onContentClick"
      >
        <template v-for="seg in segments" :key="seg.key">
          <WorkflowCard
            v-if="seg.kind === 'process'"
            :turn="turn"
            :items="seg.items"
            :first="seg.key === firstProcessKey"
            :last="seg.key === lastProcessKey && !textAfterLastProcess && !answer?.content"
            :assistant-name="assistantName"
            :live="live"
            :pending-approval-id="pendingApprovalId"
            :preview-steps="previewSteps"
          />
          <div v-else-if="'parts' in seg" class="narration">
            <template v-for="(part, i) in seg.parts" :key="i">
              <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义原始 HTML -->
              <div v-if="part.kind === 'html'" class="md-body" v-html="part.html" />
              <component
                :is="fenceViewFor(part.lang)"
                v-else
                :lang="part.lang"
                :source="part.source"
                :streaming="live && !part.closed"
              />
            </template>
          </div>
        </template>

        <ToolCallRow
          v-if="pendingCall"
          :call="pendingCall"
          :awaiting-approval="true"
          @approve="
            (ok: boolean, reason?: string, scope?: ApprovalScope) =>
              emit('approve', ok, reason, scope)
          "
        />

        <template v-for="(seg, i) in answerSegments" :key="i">
          <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义原始 HTML -->

          <div v-if="seg.kind === 'html'" class="md-body" v-html="seg.html" />

          <component
            :is="fenceViewFor(seg.lang)"
            v-else
            :lang="seg.lang"
            :source="seg.source"
            :streaming="live && !seg.closed"
          />
        </template>

        <div v-if="waiting" class="typing" :aria-label="t('yaya.generating', '生成中')">
          <span /><span /><span />
        </div>

        <div v-for="r in turn.orphanResults" :key="r.id" class="orphan text-medium-emphasis">
          <span class="tool-name-inline">{{ r.name || 'tool' }}</span>
          <pre>{{ r.content }}</pre>
        </div>

        <div v-if="stoppedByUser" class="stopped text-medium-emphasis">
          <v-icon icon="mdi-stop-circle-outline" size="16" />
          {{ t('yaya.stopped', '已停止生成') }}
        </div>
        <div
          v-else-if="problem"
          class="notice"
          :class="problem.status === 'error' ? 'is-error' : 'is-info'"
        >
          <v-icon
            :icon="
              problem.status === 'error' ? 'mdi-alert-circle-outline' : 'mdi-pause-circle-outline'
            "
            size="20"
            class="flex-shrink-0"
          />
          <div class="notice-text">
            <div class="font-weight-medium">
              {{
                problem.status === 'error'
                  ? t('yaya.error_title', '生成失败')
                  : t('yaya.interrupted_title', '工作流已中断')
              }}
            </div>
            <div class="text-medium-emphasis notice-detail">{{ problem.error }}</div>
          </div>
        </div>
      </div>

      <div v-if="!live" class="turn-actions" :class="{ 'is-pinned': isLast }">
        <v-btn
          icon
          variant="text"
          density="comfortable"
          :title="copied ? t('yaya.copied', '已复制') : t('yaya.copy', '复制')"
          :aria-label="t('yaya.copy', '复制')"
          @click="copyTurn"
        >
          <v-icon :icon="copied ? 'mdi-check' : 'mdi-content-copy'" size="20" />
        </v-btn>
        <v-btn
          icon
          variant="text"
          density="comfortable"
          :title="t('yaya.regenerate', '重新生成')"
          :aria-label="t('yaya.regenerate', '重新生成')"
          @click="emit('regenerate', turn.firstId)"
        >
          <v-icon icon="mdi-refresh" size="20" />
        </v-btn>
        <v-btn
          icon
          variant="text"
          density="comfortable"
          :title="t('yaya.more', '更多')"
          :aria-label="t('yaya.more', '更多')"
          @click="(e: MouseEvent) => openMenu(e.clientX, e.clientY)"
        >
          <v-icon icon="mdi-dots-horizontal" size="20" />
        </v-btn>
        <span v-if="modelUsed || usage" class="usage text-medium-emphasis" :title="providerUsed">
          <span v-if="modelUsed" class="usage-model">{{ modelUsed }}</span>
          <span v-if="modelUsed && usage"> · </span>
          <span v-if="usage">{{
            te('yaya.tokens', { n: usage.toLocaleString() }, '{n} tokens')
          }}</span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.assistant-turn {
  display: flex;
  gap: 12px;
  min-width: 0;
}
.avatar {
  width: 38px;
  height: 38px;
  margin-top: 0;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(var(--v-theme-primary), 0.16);
  color: rgb(var(--v-theme-primary));
  flex-shrink: 0;
}
.turn-col {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.turn-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 38px;
}
.turn-name {
  font-weight: 600;
  font-size: 0.95rem;
}
/* 助手气泡：玻璃底 + 细边框，压在背景图上也读得清；左上角收成小圆角指向头像 */
.bubble {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 14px 18px;
  border-radius: 6px 18px 18px 18px;
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.78));
  backdrop-filter: blur(16px) saturate(1.15);
  -webkit-backdrop-filter: blur(16px) saturate(1.15);
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.6));
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.06);
}
.narration {
  min-width: 0;
}
.typing {
  display: flex;
  gap: 6px;
  padding: 6px 0;
}
.typing span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgb(var(--v-theme-primary));
  animation: yaya-dot 1.1s infinite ease-in-out;
}
.typing span:nth-child(2) {
  animation-delay: 0.15s;
}
.typing span:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes yaya-dot {
  0%,
  60%,
  100% {
    opacity: 0.3;
    transform: translateY(0);
  }
  30% {
    opacity: 1;
    transform: translateY(-4px);
  }
}
.stopped {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
}
.notice {
  display: flex;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 10px;
  font-size: 0.875rem;
}
.notice.is-error {
  background: rgba(var(--v-theme-error), 0.08);
  border: 1px solid rgba(var(--v-theme-error), 0.25);
  color: rgb(var(--v-theme-error));
}
.notice.is-info {
  background: rgba(var(--v-theme-info), 0.08);
  border: 1px solid rgba(var(--v-theme-info), 0.25);
  color: rgb(var(--v-theme-info));
}
.notice-text {
  min-width: 0;
  color: rgb(var(--v-theme-on-surface));
}
.notice-detail {
  word-break: break-word;
  margin-top: 2px;
}
.orphan pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8rem;
  max-height: 200px;
  overflow: auto;
}
.tool-name-inline {
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
}
.turn-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  min-height: 44px;
  margin-left: -8px;
  opacity: 0;
  transition: opacity 0.15s;
}
.turn-actions.is-pinned,
.assistant-turn:hover .turn-actions,
.turn-actions:focus-within {
  opacity: 1;
}
@media (hover: none) {
  .turn-actions {
    opacity: 1;
  }
}
.usage {
  font-size: 0.8rem;
  margin-left: 8px;
  min-width: 0;
}
.usage-model {
  font-family: ui-monospace, monospace;
}

/* ---- Markdown 正文 ---- */
.md-body {
  font-size: 0.95rem;
  line-height: 1.7;
  word-break: break-word;
  min-width: 0;
}
.md-body :deep(> :first-child) {
  margin-top: 0;
}
.md-body :deep(> :last-child) {
  margin-bottom: 0;
}
.md-body :deep(p),
.md-body :deep(ul),
.md-body :deep(ol),
.md-body :deep(blockquote),
.md-body :deep(table) {
  margin: 0 0 0.75em;
}
.md-body :deep(ul),
.md-body :deep(ol) {
  padding-left: 1.4em;
}
.md-body :deep(li + li) {
  margin-top: 0.25em;
}
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  margin: 1.1em 0 0.5em;
  line-height: 1.35;
  font-weight: 600;
}
.md-body :deep(h1) {
  font-size: 1.35rem;
}
.md-body :deep(h2) {
  font-size: 1.2rem;
}
.md-body :deep(h3) {
  font-size: 1.05rem;
}
.md-body :deep(a) {
  color: rgb(var(--v-theme-primary));
  text-decoration: underline;
  text-underline-offset: 2px;
}
.md-body :deep(blockquote) {
  padding-left: 12px;
  border-left: 3px solid rgba(var(--v-theme-on-surface), 0.2);
  color: rgba(var(--v-theme-on-surface), 0.75);
}
.md-body :deep(:not(pre) > code) {
  padding: 1px 6px;
  border-radius: 5px;
  background: rgba(var(--v-theme-on-surface), 0.08);
  font-family: ui-monospace, monospace;
  font-size: 0.86em;
}
.md-body :deep(table) {
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
  max-width: 100%;
}
.md-body :deep(th),
.md-body :deep(td) {
  padding: 6px 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.md-body :deep(th) {
  background: rgba(var(--v-theme-on-surface), 0.05);
}
.md-body :deep(hr) {
  border: none;
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  margin: 1em 0;
}
.md-body :deep(.md-code) {
  margin: 0 0 0.75em;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface-variant), 0.45);
}
.md-body :deep(.md-code-head) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 4px 12px;
  font-size: 0.75rem;
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.md-body :deep(.md-code-lang) {
  font-family: ui-monospace, monospace;
  opacity: 0.7;
}
.md-body :deep(.md-code-copy) {
  padding: 4px 10px;
  min-height: 28px;
  border-radius: 6px;
  border: none;
  background: none;
  color: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  opacity: 0.75;
}
.md-body :deep(.md-code-copy:hover) {
  opacity: 1;
  background: rgba(var(--v-theme-on-surface), 0.08);
}
.md-body :deep(pre) {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  font-size: 0.85rem;
  line-height: 1.55;
}
.md-body :deep(pre code) {
  font-family: ui-monospace, monospace;
}
.md-body :deep(.hljs-comment),
.md-body :deep(.hljs-quote) {
  color: rgba(var(--v-theme-on-surface), 0.5);
  font-style: italic;
}
.md-body :deep(.hljs-keyword),
.md-body :deep(.hljs-selector-tag),
.md-body :deep(.hljs-meta) {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
.md-body :deep(.hljs-string),
.md-body :deep(.hljs-regexp),
.md-body :deep(.hljs-addition) {
  color: rgb(var(--v-theme-success));
}
.md-body :deep(.hljs-number),
.md-body :deep(.hljs-literal),
.md-body :deep(.hljs-symbol),
.md-body :deep(.hljs-bullet) {
  color: rgb(var(--v-theme-warning));
}
.md-body :deep(.hljs-title),
.md-body :deep(.hljs-section),
.md-body :deep(.hljs-title.function_) {
  color: rgb(var(--v-theme-secondary));
}
.md-body :deep(.hljs-attr),
.md-body :deep(.hljs-attribute),
.md-body :deep(.hljs-variable),
.md-body :deep(.hljs-type),
.md-body :deep(.hljs-built_in) {
  color: rgb(var(--v-theme-info));
}
.md-body :deep(.md-math-display) {
  display: block;
  overflow-x: auto;
  overflow-y: hidden;
  margin: 0.4em 0 0.75em;
  padding: 2px 0;
}
.md-body :deep(.md-math-display .katex-display) {
  margin: 0;
}
.md-body :deep(.katex) {
  font-size: 1.1em;
}
/* 长行内公式：可横向滚动的小盒子，窄屏不撑破气泡 */
.md-body :deep(.md-math-wide) {
  display: inline-block;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  vertical-align: middle;
}
.md-body :deep(.md-math-src) {
  font-family: ui-monospace, monospace;
  font-size: 0.86em;
  opacity: 0.75;
}
.md-body :deep(.hljs-deletion) {
  color: rgb(var(--v-theme-error));
}

@media (max-width: 720px) {
  .avatar {
    display: none;
  }
  .bubble {
    padding: 12px 14px;
    border-radius: 16px;
  }
}

@container yaya (max-width: 600px) {
  .assistant-turn {
    gap: 0;
  }
  .avatar {
    display: none;
  }
  .turn-col {
    gap: 4px;
  }
  .turn-head {
    min-height: 28px;
  }
  .turn-name {
    font-size: 0.82rem;
  }
  .bubble {
    padding: 10px 12px;
    gap: 10px;
    border-radius: 14px;
  }
  .md-body {
    font-size: 0.9rem;
    line-height: 1.6;
  }
  .md-body :deep(table) {
    font-size: 0.82rem;
  }
  .md-body :deep(th),
  .md-body :deep(td) {
    padding: 4px 8px;
  }
  .md-body :deep(pre) {
    padding: 8px 10px;
    font-size: 0.8rem;
  }
  .turn-actions {
    min-height: 36px;
    margin-left: -6px;
  }
  .turn-actions :deep(.v-btn) {
    width: 34px;
    height: 34px;
  }
  .turn-actions :deep(.v-icon) {
    font-size: 18px;
  }
  .usage {
    font-size: 0.72rem;
    margin-left: 4px;
  }
}
</style>
