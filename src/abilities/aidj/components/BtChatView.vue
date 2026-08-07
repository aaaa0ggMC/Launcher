<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { BtTaskInfo, BtOutputMessage } from '@shared/types'
import { renderMarkdown } from '../../../shared/markdown'
import ContextMenu from './ContextMenu.vue'

defineOptions({ name: 'AidjBtChatView' })

const props = defineProps<{
  task?: BtTaskInfo | null
  messages?: BtOutputMessage[]
}>()

interface ChatItem {
  kind: 'user' | 'assistant' | 'system' | 'playlist' | 'retry'
  content?: string
  songs?: { name: string; path: string }[]
  history?: boolean
}

const inputText = ref('')
const scrollEl = ref<HTMLElement | null>(null)

// -- status bar -----------------------------------------------------------
const chatStatus = ref({ promptTokens: 0, completionTokens: 0, memory: 0 })
const memoryConfirm = ref(false)

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

// -- send target (player) ------------------------------------------------
const players = ref<string[]>([])
const targetPlayer = ref('')
let playersTimer: ReturnType<typeof setInterval> | null = null

function shortPlayer(name: string): string {
  const short = name.replace(/^org\.mpris\.MediaPlayer2\./, '')
  if (short.length <= 10) return short
  return short.slice(0, 5) + '…' + short.slice(-4)
}

async function pollPlayers(): Promise<void> {
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
  pollPlayers()
  playersTimer = setInterval(pollPlayers, 5000)
})
onUnmounted(() => {
  if (playersTimer) clearInterval(playersTimer)
})

const ctxMenu = ref(false)
const ctxPos = ref({ x: 0, y: 0 })
const ctxTarget = ref('')
const ctxIsAi = ref(false)
let ctxCloseTimer: ReturnType<typeof setTimeout> | null = null

function openCtx(e: MouseEvent, content: string, isAi: boolean): void {
  e.preventDefault()
  e.stopPropagation()
  ctxTarget.value = content
  ctxIsAi.value = isAi
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
  for (const m of props.messages ?? []) {
    const d = m.data
    if (!d || typeof d !== 'object') continue
    const t = (d as Record<string, unknown>).type as string | undefined
    if (t === 'thinking' || t === 'idle') continue
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
  }
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
      <span class="text-body-2 font-weight-medium">持续模式</span>
      <v-spacer />
      <v-select
        :model-value="targetPlayer"
        :items="[
          { title: '当前激活', value: '__auto__' },
          ...players.map((p) => ({ title: shortPlayer(p), value: p }))
        ]"
        density="compact"
        variant="outlined"
        hide-details
        class="chat-player-select"
        :placeholder="'发送目标'"
        @update:model-value="selectTarget"
      />
      <v-chip v-if="thinking" size="small" variant="flat" color="primary" class="thinking-chip">
        <v-progress-circular indeterminate size="12" width="2" />
        <span class="ml-1">AI DJ</span>
      </v-chip>
    </div>

    <v-divider />

    <div ref="scrollEl" class="chat-scroll flex-grow-1 overflow-y-auto px-4 py-3">
      <div class="d-flex flex-column ga-3">
        <template v-for="(it, i) in items" :key="i">
          <div v-if="it.kind === 'user'" class="d-flex flex-column align-end">
            <span class="text-caption text-medium-emphasis">You</span>
            <div
              class="chat-bubble chat-bubble-user pa-3 text-body-2"
              @contextmenu="it.content && openCtx($event, it.content, false)"
            >
              {{ it.content }}
            </div>
          </div>
          <div v-else-if="it.kind === 'assistant'" class="d-flex flex-column align-start">
            <span class="text-caption text-medium-emphasis">AI DJ</span>
            <div
              class="chat-bubble chat-bubble-ai pa-3 text-body-2 msg-markdown"
              @contextmenu="it.content && openCtx($event, it.content, true)"
            >
              <div v-html="renderMarkdown(it.content || '')" />
            </div>
          </div>
          <div v-else-if="it.kind === 'system'" class="d-flex justify-center">
            <span class="text-caption text-medium-emphasis">{{ it.content }}</span>
          </div>
          <div v-else-if="it.kind === 'retry'" class="d-flex justify-center">
            <span class="text-caption text-warning">
              <v-icon size="12" class="mr-1">mdi-loading mdi-spin</v-icon>
              {{ it.content }}
            </span>
          </div>
          <div v-else-if="it.kind === 'playlist'" class="d-flex flex-column align-start w-100">
            <div class="d-flex align-start ga-2 w-100">
              <span class="text-caption text-medium-emphasis flex-grow-1">
                {{ it.history ? '主界面歌单' : '推荐歌单' }}
              </span>
              <v-btn
                v-if="!it.history"
                size="x-small"
                variant="text"
                color="primary"
                class="text-caption"
                density="compact"
                @click="resendPlaylist(it.songs ?? [])"
              >
                <v-icon size="12" start>mdi-refresh</v-icon>
                重新发送
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
                  <span class="text-body-2 text-truncate">{{ song.name }}</span>
                </div>
              </div>
            </v-card>
          </div>
        </template>

        <div v-if="items.length === 0 && !thinking" class="text-caption text-medium-emphasis pa-2">
          AI 正在生成首个歌单…
        </div>
      </div>
    </div>

    <div class="aidj-status-bar">
      <v-chip variant="flat" size="small" class="status-chip">
        <span class="status-label">Prompt</span
        ><span class="status-value">{{ formatTokens(chatStatus.promptTokens) }}</span>
      </v-chip>
      <v-chip variant="flat" size="small" class="status-chip">
        <span class="status-label">Completion</span
        ><span class="status-value">{{ formatTokens(chatStatus.completionTokens) }}</span>
      </v-chip>
      <v-chip
        variant="flat"
        size="small"
        class="status-chip clickable"
        :title="'点击清空已播记忆'"
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
        placeholder="输入消息，回车发送 (/discard_follows 丢弃后续待播)"
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
        发送
      </v-btn>
    </div>

    <ContextMenu
      v-model="ctxMenu"
      :x="ctxPos.x"
      :y="ctxPos.y"
      :content="ctxTarget"
      :is-ai="ctxIsAi"
    />

    <v-dialog v-model="memoryConfirm" max-width="400">
      <v-card>
        <v-card-title class="text-body-1 font-weight-medium">清空已播记忆</v-card-title>
        <v-card-text class="text-body-2">
          清空后 AI 将不再记住已推荐过的歌曲，可能重复推荐。
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-0 ga-2">
          <v-spacer />
          <v-btn variant="text" @click="memoryConfirm = false">取消</v-btn>
          <v-btn variant="tonal" color="primary" @click="clearMemory">确认清空</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style scoped>
.chat-scroll {
  min-height: 0;
  scroll-behavior: smooth;
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
