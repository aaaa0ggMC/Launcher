<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, inject } from 'vue'
import type { Ref } from 'vue'
import type { BtTaskInfo, BtOutputMessage } from '@shared/types'
import { translate, translateTemplate } from '../../../main/ui/i18n'
import { renderMarkdown } from '../../../shared/markdown'
import ContextMenu from './ContextMenu.vue'
import WorkflowCard from './WorkflowCard.vue'
import { vLongPress, type LongPressPoint } from './long-press'
import {
  buildWorkflows,
  isWorkflowEvent,
  runningWorkflow,
  usageOfEvents,
  type WfView
} from './workflow-view'
import UsageBreakdownView from './UsageBreakdown.vue'
import { mergeUsage, type UsageBreakdown } from '../loop/usage'

defineOptions({ name: 'AidjBtChatView' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const props = defineProps<{
  task?: BtTaskInfo | null
  messages?: BtOutputMessage[]
}>()

interface ChatItem {
  kind: 'user' | 'assistant' | 'system' | 'playlist' | 'retry' | 'workflow'
  content?: string
  songs?: { name: string; path: string }[]
  history?: boolean
  /** Agent workflow batch id (kind === 'workflow'). */
  batch?: string
}

// -- agent workflow cards ---------------------------------------------------
/** Every batch's workflow, built from all workflow events of this task. */
const workflows = computed(() => {
  const evs: Record<string, unknown>[] = []
  for (const m of props.messages ?? []) {
    if (isWorkflowEvent(m.data)) evs.push(m.data as Record<string, unknown>)
  }
  const map = new Map<string, WfView>()
  for (const w of buildWorkflows(evs)) map.set(w.batch, w)
  return map
})

/** Kernel step of the running batch (agent mode), e.g. 3/11. */
const agentStep = computed(() => {
  const w = runningWorkflow([...workflows.value.values()])
  if (!w) return ''
  if (w.stage === 'rank') return 'RankAgent'
  return w.step
    ? translateTemplate(uiLang.value, 'aidj.wf.round', { n: String(w.step) }, '第 {n} 轮')
    : 'LoopAgent'
})

const inputText = ref('')
const scrollEl = ref<HTMLElement | null>(null)

// -- status bar -----------------------------------------------------------
const chatStatus = ref({
  promptTokens: 0,
  completionTokens: 0,
  tokens: 0,
  context: 0,
  contextCompletion: 0,
  memory: 0
})
const memoryConfirm = ref(false)

/** Tokens: last chat_status (cumulative) + usage events after it (the batch in flight, live). */
const liveStatus = computed(() => {
  const msgs = props.messages ?? []
  let base: Record<string, unknown> | null = null
  let at = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const d = msgs[i].data as Record<string, unknown> | undefined
    if (d && typeof d === 'object' && d.type === 'chat_status') {
      base = d
      at = i
      break
    }
  }
  const after = msgs
    .slice(at + 1)
    .map((m) => m.data as Record<string, unknown>)
    .filter((d) => isWorkflowEvent(d))
  const { total, lastLoop } = usageOfEvents(after)
  const usage = mergeUsage(
    {
      prompt: Number(base?.promptTokens) || 0,
      completion: Number(base?.completionTokens) || 0,
      cached: Number(base?.cached) || 0,
      byAgent: (base?.byAgent as UsageBreakdown['byAgent']) ?? {}
    },
    total
  )
  return {
    usage,
    context: lastLoop?.prompt ?? chatStatus.value.context,
    completion: lastLoop?.completion ?? chatStatus.value.contextCompletion
  }
})

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'k'
  return n.toLocaleString()
}

async function clearMemory(): Promise<void> {
  memoryConfirm.value = false
  if (!props.task?.id) return
  try {
    await window.cockpit.command('aidj.chat-clear-memory', { task: props.task.id })
    chatStatus.value.memory = 0
  } catch {
    /* noop */
  }
}

async function doRevert(): Promise<void> {
  const idx = ctxMsgIndex.value
  if (idx < 0 || !props.task?.id) return
  ctxMenu.value = false
  // Count user/assistant items BEFORE the clicked one.
  let keep = 0
  for (let i = 0; i < idx && i < items.value.length; i++) {
    if (items.value[i].kind === 'user' || items.value[i].kind === 'assistant') keep++
  }
  await window.cockpit.command('aidj.chat-revert', { task: props.task.id, keep }).catch(() => {})
}

// -- send target (player) ------------------------------------------------
const players = ref<string[]>([])
const targetPlayer = ref('')
const mode = ref<'dbus' | 'web'>('dbus')
let playersTimer: ReturnType<typeof setInterval> | null = null

function shortPlayer(name: string): string {
  const short = name.replace(/^org\.mpris\.MediaPlayer2\./, '')
  if (short.length <= 10) return short
  return short.slice(0, 5) + '…' + short.slice(-4)
}

async function pollMode(): Promise<void> {
  try {
    const r = (await window.cockpit.command('aidj.status')) as Record<string, unknown>
    if (r?.mode === 'dbus' || r?.mode === 'web') mode.value = r.mode
  } catch {
    /* noop */
  }
}

async function pollPlayers(): Promise<void> {
  // MPRIS player list is dbus-only — skip in web mode (the command isn't
  // exposed there, and the chat always pushes to the built-in engine).
  if (mode.value !== 'dbus') return
  try {
    const r = (await window.cockpit.command('aidj.list-players').catch(() => null)) as {
      ok?: boolean
      players?: string[]
    } | null
    if (r?.ok && Array.isArray(r.players)) {
      players.value = r.players
      if (!targetPlayer.value) targetPlayer.value = '__auto__'
    }
  } catch {
    /* noop */
  }
}

async function selectTarget(name: string): Promise<void> {
  if (!props.task?.id || !name) return
  targetPlayer.value = name
  await window.cockpit.command('aidj.chat-player', { task: props.task.id, player: name })
}

onMounted(() => {
  void pollMode().then(() => pollPlayers())
  playersTimer = setInterval(() => {
    void pollPlayers()
    void pollMode()
  }, 5000)
})
onUnmounted(() => {
  if (playersTimer) clearInterval(playersTimer)
})

const ctxMenu = ref(false)
const ctxPos = ref({ x: 0, y: 0 })
const ctxTarget = ref('')
const ctxIsAi = ref(false)
const ctxMsgIndex = ref(-1)
let ctxCloseTimer: ReturnType<typeof setTimeout> | null = null

function openCtx(e: MouseEvent, content: string, isAi: boolean, index: number): void {
  e.preventDefault()
  e.stopPropagation()
  ctxTarget.value = content
  ctxIsAi.value = isAi
  ctxMsgIndex.value = index
  const pos = { x: e.clientX + 8, y: e.clientY + 8 }
  if (ctxMenu.value) {
    ctxMenu.value = false
    if (ctxCloseTimer) clearTimeout(ctxCloseTimer)
    ctxCloseTimer = setTimeout(() => {
      ctxPos.value = pos
      ctxMenu.value = true
    }, 120)
  } else {
    ctxPos.value = pos
    ctxMenu.value = true
  }
}

/** Long-press (touch) → the same menu right-click opens. */
function openCtxPoint(point: LongPressPoint, content: string, isAi: boolean, index: number): void {
  openCtx(
    {
      clientX: point.clientX,
      clientY: point.clientY,
      preventDefault: () => {},
      stopPropagation: () => {}
    } as unknown as MouseEvent,
    content,
    isAi,
    index
  )
}

const thinking = computed(() => {
  const msgs = props.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const d = msgs[i].data
    if (d && typeof d === 'object') {
      const t = (d as Record<string, unknown>).type
      if (t === 'thinking') return true
      if (t === 'idle') return false
    }
  }
  return false
})

const items = computed<ChatItem[]>(() => {
  const out: ChatItem[] = []
  const seenBatches = new Set<string>()
  for (const m of props.messages ?? []) {
    const d = m.data
    if (!d || typeof d !== 'object') continue
    const t = (d as Record<string, unknown>).type as string | undefined
    if (t === 'thinking' || t === 'idle') continue
    if (t === 'now_playing') {
      out.push({
        kind: 'system',
        content: `▶ 播放: ${String((d as Record<string, unknown>).track ?? '')}`
      })
      continue
    }
    if (t === 'clear_history') {
      out.length = 0
      seenBatches.clear()
      continue
    }
    if (isWorkflowEvent(d)) {
      // One card per batch, placed where its first event arrived.
      const b =
        typeof (d as Record<string, unknown>).batch === 'string'
          ? String((d as Record<string, unknown>).batch)
          : '_'
      if (!seenBatches.has(b)) {
        seenBatches.add(b)
        out.push({ kind: 'workflow', batch: b })
      }
      continue
    }
    if (t === 'user' || t === 'assistant' || t === 'system') {
      out.push({ kind: t, content: String((d as Record<string, unknown>).content ?? '') })
    } else if (t === 'playlist') {
      out.push({
        kind: 'playlist',
        songs: (d as Record<string, unknown>).songs as { name: string; path: string }[],
        history: (d as Record<string, unknown>).history === true
      })
    } else if (t === 'retry') {
      const content = String((d as Record<string, unknown>).content ?? '')
      if (out.length > 0 && out[out.length - 1].kind === 'retry') {
        out[out.length - 1].content = content
      } else {
        out.push({ kind: 'retry', content })
      }
    } else if (t === 'retry_clear') {
      if (out.length > 0 && out[out.length - 1].kind === 'retry') {
        out.pop()
      }
    }
  }
  return out
})

async function send(): Promise<void> {
  const text = inputText.value.trim()
  if (!text || !props.task?.id) return
  inputText.value = ''
  await window.cockpit.command('aidj.chat', { task: props.task.id, text }).catch(() => {})
}

async function resendPlaylist(songs: { name: string; path: string }[]): Promise<void> {
  if (!props.task?.id || !songs.length) return
  await window.cockpit
    .command('aidj.chat-resend', { task: props.task.id, songs: JSON.stringify(songs) })
    .catch(() => {})
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

watch(
  () => items.value.length,
  () => {
    nextTick(() => {
      if (scrollEl.value) scrollEl.value.scrollTop = scrollEl.value.scrollHeight
    })
  },
  { immediate: true }
)

watch(
  () => props.messages,
  (msgs) => {
    if (!msgs) return
    for (let i = msgs.length - 1; i >= 0; i--) {
      const d = msgs[i].data
      if (d && typeof d === 'object' && (d as Record<string, unknown>).type === 'chat_status') {
        const data = d as Record<string, unknown>
        chatStatus.value = {
          promptTokens: (data.promptTokens as number) ?? 0,
          completionTokens: (data.completionTokens as number) ?? 0,
          tokens:
            (data.tokens as number) ??
            ((data.promptTokens as number) ?? 0) + ((data.completionTokens as number) ?? 0),
          context: (data.context as number) ?? (data.promptTokens as number) ?? 0,
          contextCompletion:
            (data.contextCompletion as number) ?? (data.completionTokens as number) ?? 0,
          memory: (data.memory as number) ?? 0
        }
        break
      }
    }
  },
  { deep: true }
)
</script>

<template>
  <div class="d-flex flex-column" style="height: 100%">
    <div class="d-flex align-center ga-2 px-4 pt-3 pb-2">
      <v-icon size="16" color="primary">mdi-radio-tower</v-icon>
      <span class="text-body-2 font-weight-medium">{{ t('aidj.btchat.title', '持续模式') }}</span>
      <v-spacer />
      <v-select
        v-if="mode === 'dbus'"
        :model-value="targetPlayer"
        :items="[
          { title: t('aidj.current_active', '当前激活'), value: '__auto__' },
          ...players.map((p) => ({ title: shortPlayer(p), value: p }))
        ]"
        density="compact"
        variant="outlined"
        hide-details
        class="chat-player-select"
        :placeholder="t('aidj.btchat.target', '发送目标')"
        @update:model-value="selectTarget"
      />
      <v-chip v-else size="small" variant="flat" class="chat-player-chip">
        <v-icon start size="14">mdi-music</v-icon>
        <span>{{ t('aidj.player_mode.web', '内置播放器') }}</span>
      </v-chip>
      <v-chip v-if="thinking" size="small" variant="flat" color="primary" class="thinking-chip">
        <v-progress-circular indeterminate size="12" width="2" />
        <span class="ml-1">{{ t('aidj.heading', 'AI DJ') }}</span>
        <span v-if="agentStep" class="ml-1">· {{ agentStep }}</span>
      </v-chip>
    </div>

    <v-divider />

    <div ref="scrollEl" class="chat-scroll flex-grow-1 overflow-y-auto px-4 py-3">
      <div class="d-flex flex-column ga-3">
        <template v-for="(it, i) in items" :key="i">
          <div v-if="it.kind === 'user'" class="d-flex flex-column align-end">
            <span class="text-caption text-medium-emphasis">You</span>
            <div
              v-long-press="(p) => it.content && openCtxPoint(p, it.content, false, i)"
              class="chat-bubble chat-bubble-user pa-3 text-body-2"
              @contextmenu="it.content && openCtx($event, it.content, false, i)"
            >
              {{ it.content }}
            </div>
          </div>
          <div v-else-if="it.kind === 'assistant'" class="d-flex flex-column align-start">
            <span class="text-caption text-medium-emphasis">AI DJ</span>
            <div
              v-long-press="(p) => it.content && openCtxPoint(p, it.content, true, i)"
              class="chat-bubble chat-bubble-ai pa-3 text-body-2 msg-markdown"
              @contextmenu="it.content && openCtx($event, it.content, true, i)"
            >
              <div v-html="renderMarkdown(it.content || '')" />
            </div>
          </div>
          <div v-else-if="it.kind === 'system'" class="d-flex justify-center">
            <span class="text-caption text-medium-emphasis">{{ it.content }}</span>
          </div>
          <div
            v-else-if="it.kind === 'workflow' && it.batch && workflows.get(it.batch)"
            class="d-flex flex-column align-start w-100"
          >
            <WorkflowCard :wf="workflows.get(it.batch)!" />
          </div>
          <div v-else-if="it.kind === 'retry'" class="d-flex justify-center">
            <span class="text-caption text-warning">
              <v-icon size="12" class="mr-1">mdi-loading mdi-spin</v-icon>
              {{ it.content }}
            </span>
          </div>
          <div v-else-if="it.kind === 'playlist'" class="d-flex flex-column align-start w-100">
            <div class="d-flex align-start ga-2 w-100 flex-wrap">
              <span class="text-caption text-medium-emphasis flex-grow-1">
                {{
                  it.history
                    ? t('aidj.btchat.main_playlist', '主界面歌单')
                    : t('aidj.playlist_title', '推荐歌单')
                }}
              </span>
              <v-btn
                v-if="!it.history"
                variant="text"
                color="primary"
                @click="resendPlaylist(it.songs ?? [])"
              >
                <v-icon start>mdi-refresh</v-icon>
                {{ t('aidj.btchat.resend', '重新发送') }}
              </v-btn>
            </div>
            <v-card variant="tonal" rounded="lg" class="playlist-card w-100 mt-1">
              <div class="song-grid">
                <div
                  v-for="(song, si) in it.songs"
                  :key="si"
                  class="d-flex align-center ga-2 px-2 py-1 song-cell"
                >
                  <span
                    class="text-caption text-medium-emphasis"
                    style="min-width: 3ch; text-align: right"
                  >
                    {{ si + 1 }}
                  </span>
                  <v-icon size="16">mdi-music</v-icon>
                  <span class="text-body-2 text-truncate" :title="song.name">{{ song.name }}</span>
                </div>
              </div>
            </v-card>
          </div>
        </template>

        <div v-if="items.length === 0 && !thinking" class="text-caption text-medium-emphasis pa-2">
          {{ t('aidj.btchat.generating', 'AI 正在生成首个歌单…') }}
        </div>
      </div>
    </div>

    <div class="aidj-status-bar">
      <v-tooltip location="top" :open-delay="150">
        <template #activator="{ props: tip }">
          <v-chip
            v-bind="tip"
            variant="flat"
            size="small"
            class="status-chip"
            :aria-label="t('aidj.chat.title_tokens_total', '累计所有请求的 tokens 总和')"
          >
            <span class="status-label">Tokens</span
            ><span class="status-value">{{
              formatTokens(liveStatus.usage.prompt + liveStatus.usage.completion)
            }}</span>
          </v-chip>
        </template>
        <UsageBreakdownView :usage="liveStatus.usage" />
      </v-tooltip>
      <v-chip
        variant="flat"
        size="small"
        class="status-chip"
        :title="t('aidj.chat.title_context', '单次请求的上下文输入 tokens')"
      >
        <span class="status-label">Context</span
        ><span class="status-value">{{ formatTokens(liveStatus.context) }}</span>
      </v-chip>
      <v-chip
        variant="flat"
        size="small"
        class="status-chip"
        :title="t('aidj.chat.title_output_tokens', '单次请求的输出 tokens')"
      >
        <span class="status-label">Completion</span
        ><span class="status-value">{{ formatTokens(liveStatus.completion) }}</span>
      </v-chip>
      <v-chip
        variant="flat"
        size="small"
        class="status-chip clickable"
        :title="t('aidj.chat.title_clear_memory', '点击清空已播记忆')"
        @click="memoryConfirm = true"
      >
        <span class="status-label">Memory</span
        ><span class="status-value">{{ chatStatus.memory.toLocaleString() }}</span>
      </v-chip>
    </div>

    <v-divider />

    <div class="d-flex align-center ga-2 px-4 py-3">
      <v-textarea
        v-model="inputText"
        rows="1"
        :max-rows="3"
        auto-grow
        no-resize
        :placeholder="
          t('aidj.btchat.input_placeholder', '输入消息，回车发送 (/discard_follows 丢弃后续待播)')
        "
        hide-details
        variant="outlined"
        class="chat-input"
        @keydown="onKeydown"
      />
      <v-btn
        color="primary"
        variant="elevated"
        :disabled="!inputText.trim()"
        class="flex-shrink-0"
        style="height: 36px"
        @click="send"
      >
        <v-icon start>mdi-send</v-icon>
        {{ t('aidj.send', '发送') }}
      </v-btn>
    </div>

    <ContextMenu
      v-model="ctxMenu"
      :x="ctxPos.x"
      :y="ctxPos.y"
      :content="ctxTarget"
      :is-ai="ctxIsAi"
      :can-revert="ctxMsgIndex >= 0"
      @revert="doRevert"
    />

    <v-dialog v-model="memoryConfirm" max-width="400">
      <v-card>
        <v-card-title class="text-body-1 font-weight-medium">{{
          t('aidj.clear_memory_title', '清空已播记忆')
        }}</v-card-title>
        <v-card-text class="text-body-2">
          {{
            t('aidj.btchat.clear_memory_text', '清空后 AI 将不再记住已推荐过的歌曲，可能重复推荐。')
          }}
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-0 ga-2">
          <v-spacer />
          <v-btn variant="text" @click="memoryConfirm = false">{{
            t('aidj.cancel', '取消')
          }}</v-btn>
          <v-btn variant="tonal" color="primary" @click="clearMemory">{{
            t('aidj.btchat.confirm_clear', '确认清空')
          }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.chat-scroll {
  min-height: 0;
  /* No smooth scroll: programmatic scroll-to-bottom on a long history would
     animate the whole distance and take seconds. Instant jump instead. */
  scroll-behavior: auto;
}
.chat-player-select {
  width: 160px;
  max-width: 200px;
  flex-shrink: 0;
}
.chat-player-select :deep(.v-field) {
  font-size: 0.78rem;
  min-height: 28px;
}
.chat-player-select :deep(.v-select__selection) {
  font-size: 0.78rem;
}
.chat-bubble {
  border-radius: 12px;
  max-width: 85%;
  word-break: break-word;
  white-space: pre-wrap;
}
.chat-bubble-user {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  border-bottom-right-radius: 4px;
}
.chat-bubble-ai {
  background: rgba(var(--v-theme-surface-variant), 0.6);
  color: rgb(var(--v-theme-on-surface));
  border-bottom-left-radius: 4px;
}
.playlist-card {
  max-width: 100%;
}
.song-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 4px 8px;
  padding: 8px;
}
.song-cell {
  min-width: 0;
  border-radius: 8px;
}
.song-cell .text-truncate {
  min-width: 0;
  flex: 1 1 auto;
}
.thinking-chip {
  display: flex;
  align-items: center;
  padding-block: 4px;
  min-height: 24px;
}
.status-chip {
  padding-block: 4px;
  min-height: 24px;
  flex-shrink: 0;
}
.status-chip.clickable {
  cursor: pointer;
}
.status-chip.clickable:hover {
  opacity: 0.8;
}
.status-label {
  font-size: 0.7rem;
  opacity: 0.7;
  margin-right: 4px;
}
.status-value {
  font-size: 0.78rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.aidj-status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  flex-shrink: 0;
}
.msg-markdown p {
  margin: 0 0 0.4em;
}
.msg-markdown p:last-child {
  margin-bottom: 0;
}
.msg-markdown code {
  background: rgba(0, 0, 0, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.85em;
}
.msg-markdown pre {
  background: rgba(0, 0, 0, 0.15);
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0.4em 0;
}
.msg-markdown pre code {
  background: none;
  padding: 0;
}
.msg-markdown a {
  color: inherit;
  text-decoration: underline;
  opacity: 0.85;
}
.msg-markdown ul {
  margin: 0.2em 0;
  padding-left: 1.2em;
}
.msg-markdown strong {
  font-weight: 600;
}
.msg-markdown table {
  border-collapse: collapse;
  margin: 0.4em 0;
}
.msg-markdown th,
.msg-markdown td {
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.5);
  padding: 4px 8px;
}
</style>
