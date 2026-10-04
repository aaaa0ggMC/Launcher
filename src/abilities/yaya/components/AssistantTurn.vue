<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { MessageNode } from '../types'
import type { AssistantTurn } from './turns'
import { turnText } from './turns'
import { renderMarkdown, handleMarkdownClick } from './markdown'
import ToolCallRow from './ToolCallRow.vue'
import BranchSwitcher from './BranchSwitcher.vue'

const props = defineProps<{
  turn: AssistantTurn
  assistantName: string
  /** 本轮正在运行（流式 / 工具执行 / 等待确认） */
  live: boolean
  /** 正挂起等待确认的工具调用 id（Runner 活着时才有） */
  pendingApprovalId: string | null
}>()

const emit = defineEmits<{
  (e: 'switchBranch', messageId: string): void
  (e: 'approve', approved: boolean): void
  (e: 'regenerate', fromMessageId: string): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const openReasoning = ref<Record<string, boolean>>({})
const copied = ref(false)

const labels = computed(() => ({ copy: t('yaya.copy', '复制') }))
function html(step: MessageNode): string {
  return renderMarkdown(step.content, labels.value)
}

function onContentClick(ev: MouseEvent): void {
  if (handleMarkdownClick(ev, t('yaya.copied', '已复制'))) ev.preventDefault()
}

function isWaiting(step: MessageNode): boolean {
  return (
    (step.status === 'pending' || step.status === 'streaming') &&
    !step.content &&
    !step.reasoningContent &&
    !step.toolCalls?.length
  )
}

function isThinking(step: MessageNode): boolean {
  return step.status === 'streaming' && Boolean(step.reasoningContent) && !step.content
}

/** 用户主动停止 = 安静的一行提示；其余中断（程序重启等）才用横幅 */
function stoppedByUser(step: MessageNode): boolean {
  return step.status === 'interrupted' && step.error === 'aborted'
}

const usage = computed(() => {
  let total = 0
  for (const s of props.turn.steps) total += s.usage?.total ?? 0
  return total
})

async function copyTurn(): Promise<void> {
  await window.cockpit.copyText(turnText(props.turn))
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <div class="assistant-turn">
    <div class="turn-head">
      <div class="avatar">
        <v-icon icon="mdi-robot-happy-outline" size="18" />
      </div>
      <span class="turn-name">{{ assistantName }}</span>
      <BranchSwitcher
        v-if="turn.siblingIds && turn.siblingIds.length > 1"
        :ids="turn.siblingIds"
        :current="turn.firstId"
        @switch="(id) => emit('switchBranch', id)"
      />
    </div>

    <div class="turn-body" @click="onContentClick">
      <template v-for="step in turn.steps" :key="step.id">
        <div v-if="step.reasoningContent" class="reasoning">
          <button
            type="button"
            class="reasoning-toggle"
            :aria-expanded="!!openReasoning[step.id]"
            @click="openReasoning[step.id] = !openReasoning[step.id]"
          >
            <v-progress-circular
              v-if="isThinking(step)"
              indeterminate
              size="14"
              width="2"
              color="primary"
            />
            <v-icon v-else icon="mdi-lightbulb-outline" size="16" />
            <span>{{
              isThinking(step) ? t('yaya.thinking_live', '思考中…') : t('yaya.thinking', '思考过程')
            }}</span>
            <v-icon
              :icon="openReasoning[step.id] ? 'mdi-chevron-up' : 'mdi-chevron-down'"
              size="16"
            />
          </button>
          <div v-if="openReasoning[step.id]" class="reasoning-text">
            {{ step.reasoningContent }}
          </div>
        </div>

        <!-- eslint-disable-next-line vue/no-v-html -- markdown-it html:false 已转义原始 HTML -->
        <div v-if="step.content" class="md-body" v-html="html(step)" />

        <div v-if="step.toolCalls?.length" class="tools">
          <ToolCallRow
            v-for="call in step.toolCalls"
            :key="call.id"
            :call="call"
            :awaiting-approval="call.id === pendingApprovalId"
            @approve="(ok) => emit('approve', ok)"
          />
        </div>

        <div v-if="isWaiting(step)" class="typing" :aria-label="t('yaya.generating', '生成中')">
          <span /><span /><span />
        </div>

        <div v-if="stoppedByUser(step)" class="stopped text-medium-emphasis">
          <v-icon icon="mdi-stop-circle-outline" size="16" />
          {{ t('yaya.stopped', '已停止生成') }}
        </div>
        <div
          v-else-if="step.status === 'error' || step.status === 'interrupted'"
          class="notice"
          :class="step.status === 'error' ? 'is-error' : 'is-info'"
        >
          <v-icon
            :icon="
              step.status === 'error' ? 'mdi-alert-circle-outline' : 'mdi-pause-circle-outline'
            "
            size="20"
            class="flex-shrink-0"
          />
          <div class="notice-text">
            <div class="font-weight-medium">
              {{
                step.status === 'error'
                  ? t('yaya.error_title', '生成失败')
                  : t('yaya.interrupted_title', '工作流已中断')
              }}
            </div>
            <div class="text-medium-emphasis notice-detail">{{ step.error }}</div>
          </div>
        </div>
      </template>

      <div v-for="r in turn.orphanResults" :key="r.id" class="orphan text-medium-emphasis">
        <span class="tool-name-inline">{{ r.name || 'tool' }}</span>
        <pre>{{ r.content }}</pre>
      </div>
    </div>

    <div v-if="!live" class="turn-actions">
      <v-btn
        icon
        variant="text"
        size="small"
        :title="copied ? t('yaya.copied', '已复制') : t('yaya.copy', '复制')"
        :aria-label="t('yaya.copy', '复制')"
        @click="copyTurn"
      >
        <v-icon :icon="copied ? 'mdi-check' : 'mdi-content-copy'" size="18" />
      </v-btn>
      <v-btn
        icon
        variant="text"
        size="small"
        :title="t('yaya.regenerate', '重新生成')"
        :aria-label="t('yaya.regenerate', '重新生成')"
        @click="emit('regenerate', turn.firstId)"
      >
        <v-icon icon="mdi-refresh" size="18" />
      </v-btn>
      <span v-if="usage" class="usage text-disabled">
        {{ te('yaya.tokens', { n: usage.toLocaleString() }, '{n} tokens') }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.assistant-turn {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.turn-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 32px;
}
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(var(--v-theme-primary), 0.16);
  color: rgb(var(--v-theme-primary));
  flex-shrink: 0;
}
.turn-name {
  font-weight: 600;
  font-size: 0.9rem;
}
.turn-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-left: 38px;
  min-width: 0;
}
.reasoning-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  min-height: 30px;
  border-radius: 999px;
  border: none;
  background: rgba(var(--v-theme-on-surface), 0.05);
  color: rgba(var(--v-theme-on-surface), 0.75);
  font-size: 0.8rem;
  cursor: pointer;
}
.reasoning-toggle:hover {
  background: rgba(var(--v-theme-on-surface), 0.09);
}
.reasoning-text {
  margin-top: 8px;
  padding: 4px 0 4px 14px;
  border-left: 2px solid rgba(var(--v-theme-on-surface), 0.15);
  color: rgba(var(--v-theme-on-surface), 0.7);
  font-size: 0.875rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.tools {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.typing {
  display: flex;
  gap: 6px;
  padding: 8px 0;
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
  gap: 4px;
  padding-left: 32px;
  min-height: 36px;
}
.usage {
  font-size: 0.75rem;
  margin-left: 6px;
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
.md-body :deep(.hljs-variable) {
  color: rgb(var(--v-theme-info));
}
.md-body :deep(.hljs-type),
.md-body :deep(.hljs-built_in) {
  color: rgb(var(--v-theme-info));
}
.md-body :deep(.hljs-deletion) {
  color: rgb(var(--v-theme-error));
}

@media (max-width: 720px) {
  .turn-body {
    padding-left: 0;
  }
  .turn-actions {
    padding-left: 0;
    margin-left: -6px;
  }
}
</style>
