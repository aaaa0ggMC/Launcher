<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { BtTaskInfo, BtOutputMessage } from '@shared/types'
import { renderMarkdown } from '../../../shared/markdown'
import ContextMenu from './ContextMenu.vue'

defineOptions({ name: 'AidjBtChatView' })

const props = defineProps<{
  task?: BtTaskInfo | null
  messages?: BtOutputMessage[]
}>()

interface ChatItem {
  kind: 'user' | 'assistant' | 'system' | 'playlist'
  content?: string
  songs?: { name: string; path: string }[]
}

const inputText = ref('')
const scrollEl = ref<HTMLElement | null>(null)

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
        songs: (d as Record<string, unknown>).songs as { name: string; path: string }[]
      })
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
</script>

<template>
  <div class="d-flex flex-column" style="height: 100%">
    <div class="d-flex align-center ga-2 px-4 pt-3 pb-2">
      <v-icon size="16" color="primary">mdi-radio-tower</v-icon>
      <span class="text-body-2 font-weight-medium">持续模式</span>
      <v-spacer />
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
          <div v-else-if="it.kind === 'playlist'" class="d-flex flex-column align-start w-100">
            <span class="text-caption text-medium-emphasis">推荐歌单</span>
            <v-card variant="tonal" rounded="lg" class="playlist-card w-100">
              <div class="song-grid">
                <div
                  v-for="(song, si) in it.songs"
                  :key="si"
                  class="d-flex align-center ga-2 px-2 py-1 song-cell"
                >
                  <span
                    class="text-caption text-medium-emphasis"
                    style="width: 2ch; text-align: right"
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
  </div>
</template>

<style scoped>
.chat-scroll {
  min-height: 0;
  scroll-behavior: smooth;
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
