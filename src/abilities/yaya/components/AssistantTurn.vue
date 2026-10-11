<script setup lang="ts">
import { computed, inject, ref, type CSSProperties } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import { vLongPress, type LongPressPoint } from '../../../main/ui/directives/long-press'
import type { ApprovalScope, ToolCallItem, YayaProfile } from '../types'
import { modelMonogram } from '../profile'
import AvatarBadge from './AvatarBadge.vue'
import type { AssistantTurn } from './turns'
import { readReactions } from '../services/reactions'
import { answerStep, hasProcess, turnFullMarkdown, turnSegments, turnText } from './turns'
import { renderSegments, handleMarkdownClick } from './markdown'
import { splitBubbles, trimPartialTag, type ChatBubble } from './chat-tags'
import {
  allChatTagRules,
  applyInlineTokensHtml,
  chatTagRules,
  fenceLangs,
  fenceViewFor,
  messageActions,
  toolCardFor,
  turnChromeFor
} from './plugin-ui-registry'
import type { MessageAction, MessageActionContext, TurnChrome } from './plugin-ui'
import './tokens.css'
import type { MessageMenuRequest } from './message-menu'
import ToolCallRow from './ToolCallRow.vue'
import DataCard from './DataCard.vue'
import ReactionBar from './ReactionBar.vue'
import WorkflowCard from './WorkflowCard.vue'
import SearchSources from './SearchSources.vue'
import type { BuiltinSearchInfo } from '../services/providers/types'

const props = defineProps<{
  turn: AssistantTurn
  assistantName: string
  /** 形象设置（头像 / 每条回答显示的名字） */
  profile?: YayaProfile
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
const sessionId = computed(() => props.turn.steps[0]?.sessionId ?? '')

// ---- 聊天标记与回答外观（插件 SDK：inlineTags / turnChrome，全部按插件启用状态门控） ----
/** 已启用插件声明的标记规则（只解析 assistant 输出）——决定要不要分段 */
const tagRules = computed(() => chatTagRules('assistant'))
/** 全部指令标记（不看启用状态）——只用于剥离，插件关掉后历史消息也不露原文 */
const stripRules = computed(() => allChatTagRules())
/** 外观偏好：只影响框架自有元素（内置操作栏 / 过程卡片 / 输入提示） */
const chrome = computed<TurnChrome | null>(() =>
  turnChromeFor({ sessionId: sessionId.value, messageId: props.turn.firstId, live: props.live })
)
/** 过程卡片显示方式（缺省 = 现状：收起 + 预览最近几步） */
const processMode = computed(() => chrome.value?.process ?? 'collapsed')
/** 隐藏回答下方的内置操作栏（右键 / 长按菜单仍可用） */
const hideActions = computed(() => chrome.value?.hideActions === true)

/** 本轮各步模型自带搜索的查询词与来源（合并去重） */
const turnSearch = computed<BuiltinSearchInfo | null>(() => {
  const queries: string[] = []
  const sources: BuiltinSearchInfo['sources'] = []
  let used = false
  for (const n of props.turn.steps) {
    const s = n.meta?.search as BuiltinSearchInfo | undefined
    if (!s || typeof s !== 'object') continue
    used = true
    for (const q of s.queries ?? []) if (!queries.includes(q)) queries.push(q)
    for (const src of s.sources ?? [])
      if (!sources.some((x) => x.url === src.url)) sources.push(src)
  }
  return used ? { queries, sources } : null
})
const showProcess = computed(() => hasProcess(props.turn))
const labels = computed(() => ({ copy: t('yaya.copy', '复制') }))

// ---- 插件注入的回答操作（如「朗读」） ----
const actionCtx = computed<MessageActionContext>(() => ({
  sessionId: props.turn.steps[0]?.sessionId ?? '',
  messageId: props.turn.firstId,
  role: 'assistant',
  text: answer.value?.content ?? ''
}))
const pluginActions = computed(() =>
  messageActions.value.filter(({ action }) => action.visible?.(actionCtx.value) ?? true)
)
function actionActive(a: MessageAction): boolean {
  return a.active?.(actionCtx.value) ?? false
}
function actionLabel(a: MessageAction): string {
  if (actionActive(a) && a.activeLabel)
    return a.activeLabelKey ? t(a.activeLabelKey, a.activeLabel) : a.activeLabel
  return a.labelKey ? t(a.labelKey, a.label) : a.label
}
function runAction(a: MessageAction): void {
  void Promise.resolve()
    .then(() => a.run(actionCtx.value))
    .catch((e: unknown) => console.warn('[yaya] message action failed', a.id, e))
}

/** Markdown 分段 + 插件的正文记号（如 [[secret_xxxx]]）：只改显示 */
function renderWithTokens(text: string): ReturnType<typeof renderSegments> {
  const ctx = { sessionId: sessionId.value, role: 'assistant' as const, t }
  // 标记只在显示层剥掉：复制 / 导出 / 菜单与气泡正文都走这份，数据库与模型历史保留原文。
  // 流式中再把没写完的尾部标记藏起来，闭合后才出现
  let src = stripRules.value.length ? splitBubbles(text, stripRules.value).plain : text
  if (props.live) src = trimPartialTag(src, stripRules.value)
  return renderSegments(src, fenceLangs.value, labels.value).map((part) =>
    part.kind === 'html' ? { ...part, html: applyInlineTokensHtml(part.html, ctx) } : part
  )
}

/** 回答切段：插件接管的代码块（```mermaid 等）渲染成组件，其余是 Markdown HTML */
const answerSegments = computed(() =>
  answer.value?.content ? renderWithTokens(answer.value.content) : []
)

/**
 * 过程块与 AI 中途说的话交错显示（说的话不再藏进过程卡片，只有思考 / 工具调用收起）。
 * 说的话与最终回答用同一套 Markdown 分段（插件代码块照样接管）。
 */
const isCardTool = (name: string): boolean => toolCardFor(name) !== null
const segments = computed(() => {
  if (!(showProcess.value || props.turn.cards.length)) return []
  const segs = turnSegments(props.turn, 'before', isCardTool).map((seg) =>
    seg.kind === 'text' ? { ...seg, parts: renderWithTokens(seg.node.content) } : seg
  )
  // 外观偏好「不显示」只砍过程块：数据卡 / 提问卡 / AI 说的话是内容，照常显示
  return processMode.value === 'hidden' ? segs.filter((s) => s.kind !== 'process') : segs
})
/** 回答之后的过程块 / 卡片（按过程记录在回答之后的步骤） */
const segmentsAfter = computed(() => {
  if (!props.turn.workflow) return []
  const segs = turnSegments(props.turn, 'after', isCardTool)
  return processMode.value === 'hidden' ? segs.filter((s) => s.kind !== 'process') : segs
})

/** 回答切成的气泡：标记启用且正文里真有标记才分段（否则渲染路径与今天完全一致） */
const bubbleSplit = computed(() => {
  const content = answer.value?.content
  if (!tagRules.value.length || !content) return null
  const r = splitBubbles(content, tagRules.value)
  return r.hadTags ? r : null
})
const bubbles = computed(() => bubbleSplit.value?.bubbles ?? [])
const bubbleParts = computed(() => bubbles.value.map((b) => renderWithTokens(b.text)))
const isSplit = computed(() => bubbleSplit.value !== null)
/** 分段气泡时每个气泡自带表情条；已有消息级回应才额外显示消息级那条 */
const showMessageBar = computed(() => {
  if (!isSplit.value) return true
  const node = props.turn.steps[0]
  return node ? readReactions(node.meta).length > 0 : false
})
/** 气泡进入延迟（`<||1.2s/>`）走 animation-delay，动画只在挂载时跑一次 */
function bubbleStyle(b: ChatBubble): CSSProperties {
  return b.delay ? { animationDelay: `${b.delay}ms` } : {}
}
/** 复制 / 菜单用的显示文本：剥掉标记（数据库与模型历史保留原文） */
function displayText(s: string): string {
  return stripRules.value.length ? splitBubbles(s, stripRules.value).plain : s
}
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
  // 带工具的子 Agent（如副代理）的调用记在过程记录的步骤上
  for (const s of props.turn.workflow?.steps ?? [])
    for (const c of s.calls ?? []) if (c.id === props.pendingApprovalId) return c
  return null
})

/** 还没有任何可见内容：显示打字点 */
const waiting = computed(() => {
  if (!props.live) return false
  if (answer.value?.content) return false
  return !showProcess.value
})
/** 外观偏好给的「输入中」提示（没有这个字段 = 保持原来的打字点） */
const typingLabel = computed(() => {
  const v = chrome.value?.typingLabel
  if (v === undefined) return ''
  return v.trim() || t('yaya.typing_hint', '对方输入中…')
})
/** 运行中显示：拟真模式下整轮都显示「输入中」，其余情况只在还看不到内容时打点 */
const showTyping = computed(() => props.live && (waiting.value || !!typingLabel.value))

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
/** 回答上显示的名字：助手名，或这条回答用的模型 */
const displayName = computed(() =>
  props.profile?.assistantLabel === 'model' && modelUsed.value
    ? modelUsed.value
    : props.assistantName
)
const avatarImage = computed(() =>
  props.profile?.assistantAvatarMode === 'custom' ? props.profile.assistantAvatar || '' : ''
)
const avatarMonogram = computed(() =>
  props.profile?.assistantAvatarMode === 'model' && modelUsed.value
    ? modelMonogram(modelUsed.value)
    : null
)
/** 窄屏不显示左侧大头像；设了自定义 / 模型头像时在名字前放个小的 */
const customAvatar = computed(() => !!avatarImage.value || !!avatarMonogram.value)

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

function openMenu(x: number, y: number, via: 'context' | 'button' = 'context'): void {
  emit('menu', {
    x,
    y,
    kind: 'assistant',
    messageId: props.turn.firstId,
    sessionId: sessionId.value,
    text: displayText(turnText(props.turn)),
    selection: window.getSelection()?.toString() ?? '',
    fullText: turnFullMarkdown(props.turn, {
      thinking: t('yaya.copy_full.thinking', '思考'),
      tool: t('yaya.copy_full.tool', '工具调用'),
      args: t('yaya.copy_full.args', '参数'),
      result: t('yaya.copy_full.result', '结果'),
      error: t('yaya.copy_full.error', '出错')
    }),
    answerText: displayText(answer.value?.content ?? ''),
    via
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
  await window.cockpit.copyText(displayText(turnText(props.turn)))
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <div class="assistant-turn">
    <AvatarBadge class="avatar" :image="avatarImage" :monogram="avatarMonogram" />

    <div class="turn-col">
      <div class="turn-head">
        <AvatarBadge
          v-if="customAvatar"
          class="head-avatar"
          :image="avatarImage"
          :monogram="avatarMonogram"
          :size="22"
        />
        <span class="turn-name">{{ displayName }}</span>
      </div>

      <div
        v-long-press="onLongPress"
        class="turn-body"
        :class="isSplit ? 'is-split' : 'bubble'"
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
            :open-by-default="processMode === 'open'"
          />
          <DataCard v-else-if="seg.kind === 'card'" :node="seg.node" />
          <component
            :is="toolCardFor(seg.call.name)?.component"
            v-else-if="seg.kind === 'toolcard'"
            :call="seg.call"
            :plugin-id="toolCardFor(seg.call.name)?.pluginId"
            :tool-name="toolCardFor(seg.call.name)?.toolName"
            :session-id="sessionId"
            :live="live"
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

        <!-- 拟真模式：回答按 <||> 标记切成多个气泡，逐泡渲染（撤回的泡只留占位） -->
        <template v-if="isSplit">
          <div
            v-for="(b, i) in bubbles"
            :key="b.id"
            class="bubble waifu-bubble"
            :class="{ 'is-retracted': b.retracted }"
            :style="bubbleStyle(b)"
          >
            <div v-if="b.retracted" class="waifu-retracted text-medium-emphasis">
              <v-icon icon="mdi-undo-variant" size="16" class="flex-shrink-0" />
              {{ t('yaya.plugin.waifu.retracted', '对方撤回了一条消息') }}
            </div>
            <template v-else>
              <template v-for="(seg, j) in bubbleParts[i]" :key="j">
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
              <!-- 气泡级表情：每个气泡一份，回应记在同一个节点的 meta 上（带 segment） -->
              <ReactionBar v-if="!live" :node="turn.steps[0]" :segment="b.id" />
            </template>
          </div>
        </template>
        <template v-else>
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
        </template>

        <!-- 消息表情回应（默认集 + 插件图标包）；这轮定稿后才出现。
             分段气泡时由每个气泡自带表情条，只有已有消息级回应才额外显示这一条 -->
        <ReactionBar v-if="!live && turn.steps[0] && showMessageBar" :node="turn.steps[0]" />

        <!-- 写在回答之后的步骤（工作流回答后还有记录 / 计算 / 卡片） -->
        <template v-for="seg in segmentsAfter" :key="seg.key">
          <WorkflowCard
            v-if="seg.kind === 'process'"
            :turn="turn"
            :items="seg.items"
            :first="false"
            :last="true"
            :assistant-name="assistantName"
            :live="live"
            :pending-approval-id="pendingApprovalId"
            :preview-steps="previewSteps"
            :open-by-default="processMode === 'open'"
          />
          <DataCard v-else-if="seg.kind === 'card'" :node="seg.node" />
          <component
            :is="toolCardFor(seg.call.name)?.component"
            v-else-if="seg.kind === 'toolcard'"
            :call="seg.call"
            :plugin-id="toolCardFor(seg.call.name)?.pluginId"
            :tool-name="toolCardFor(seg.call.name)?.toolName"
            :session-id="sessionId"
            :live="live"
          />
        </template>

        <SearchSources v-if="turnSearch" :search="turnSearch" />

        <div v-if="showTyping" class="typing-row">
          <span v-if="typingLabel" class="typing-label">{{ typingLabel }}</span>
          <div class="typing" :aria-label="t('yaya.generating', '生成中')">
            <span /><span /><span />
          </div>
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

      <div v-if="!live && !hideActions" class="turn-actions" :class="{ 'is-pinned': isLast }">
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
          v-for="{ pluginId, action } in pluginActions"
          :key="`${pluginId}:${action.id}`"
          icon
          variant="text"
          density="comfortable"
          :color="actionActive(action) ? 'primary' : undefined"
          :title="actionLabel(action)"
          :aria-label="actionLabel(action)"
          :aria-pressed="action.active ? actionActive(action) : undefined"
          @click="runAction(action)"
        >
          <v-icon
            :icon="actionActive(action) && action.activeIcon ? action.activeIcon : action.icon"
            size="20"
          />
        </v-btn>
        <v-btn
          icon
          variant="text"
          density="comfortable"
          :title="t('yaya.more', '更多')"
          :aria-label="t('yaya.more', '更多')"
          @click="(e: MouseEvent) => openMenu(e.clientX, e.clientY, 'button')"
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
.head-avatar {
  display: none;
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
/* turn-body 是内容容器（分段气泡时它自己不带玻璃底，气泡是它的子元素） */
.turn-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.turn-body.is-split {
  gap: 10px;
}
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
/* ---- 拟真对话：分段气泡（进入动画 + 撤回占位） ---- */
.turn-body.is-split .waifu-bubble {
  border-radius: 18px;
  animation: waifu-in 0.26s ease both;
}
.turn-body.is-split .waifu-bubble:first-child {
  border-radius: 6px 18px 18px 18px;
}
@keyframes waifu-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .turn-body.is-split .waifu-bubble {
    animation: none;
  }
}
.waifu-bubble.is-retracted {
  border-style: dashed;
  padding-top: 10px;
  padding-bottom: 10px;
  opacity: 0.85;
}
.waifu-retracted {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  font-style: italic;
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
/* 「输入中」提示文字（拟真模式）：与打点同一行 */
.typing-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.typing-label {
  font-size: 0.85rem;
  color: rgba(var(--v-theme-on-surface), 0.65);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
  .head-avatar {
    display: inline-grid;
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
  .head-avatar {
    display: inline-grid;
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
