<script setup lang="ts">
import {
  ref,
  inject,
  type Ref,
  computed,
  onMounted,
  onActivated,
  onDeactivated,
  nextTick
} from 'vue'
import { translate } from '../../main/ui/i18n'
import { renderMarkdown } from '../../shared/markdown'
import type { ChatMessage, PlayerStatus } from './types'
import ChatMessageVue from './components/ChatMessage.vue'

defineOptions({ name: 'cockpit-aidj' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const mode = ref<'immediate' | 'persistent'>('immediate')
const thinking = ref(false)
const persistentRunning = ref(false)
const sending = ref(false)
const pendingText = ref('')
const chatContainer = ref<HTMLElement | null>(null)
const expanded = ref(false)

const playerStatus = ref<PlayerStatus>({ status: 'Unknown', track: '', volume: null, player: '' })
const lastTokens = ref<{ prompt: number; completion: number }>({ prompt: 0, completion: 0 })
const sbTracks = ref(0)
const sbMemory = ref(0)
const sbVolbal = ref<{ enabled: boolean; method: string }>({ enabled: false, method: 'lufs' })
const sbRecordFreq = ref(false)
const memoryConfirm = ref(false)
const sbOrder = ref<Record<string, number>>({
  tokens: 1,
  tracks: 2,
  memory: 3,
  volbal: 4,
  record_freq: 5
})
const availablePlayers = ref<string[]>([])
const selectedPlayer = ref('')
const autoMode = ref(true)

function formatTokens(n: number): string {
  if (n >= 1000) {
    return (n / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'k'
  }
  return n.toLocaleString()
}

const visibleStatus = computed(() => {
  return Object.entries(sbOrder.value)
    .filter(([, v]) => v > 0)
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k]) => k)
})

async function toggleVolbal(): Promise<void> {
  const { enabled, method } = sbVolbal.value
  let next: { enabled: boolean; method: string }
  if (!enabled) {
    next = { enabled: true, method: 'lufs' }
  } else if (method === 'lufs') {
    next = { enabled: true, method: 'linear' }
  } else {
    next = { enabled: false, method: 'linear' }
  }
  await window.cockpit.command('aidj.update-config', {
    path: 'preferences.dynamic_balance_volume',
    value: next.enabled
  })
  await window.cockpit.command('aidj.update-config', {
    path: 'preferences.sound_adjust_method',
    value: next.method
  })
  sbVolbal.value = next
  await pollStatus()
}

async function toggleRecordFreq(): Promise<void> {
  const next = !sbRecordFreq.value
  await window.cockpit.command('aidj.update-config', {
    path: 'preferences.record_freq',
    value: next
  })
  sbRecordFreq.value = next
  await pollStatus()
}

async function clearMemory(): Promise<void> {
  memoryConfirm.value = false
  try {
    await window.cockpit.command('aidj.refresh')
    sbMemory.value = 0
  } catch {
    /* noop */
  }
}

let statusPollTimer: ReturnType<typeof setInterval> | null = null
let btUnsub: (() => void) | null = null

onMounted(() => {
  pollStatus()
  pollPlayers()
  statusPollTimer = setInterval(pollStatus, 2000)
  setInterval(pollPlayers, 5000)
  listenBt()
})

onActivated(() => {
  if (!statusPollTimer) {
    statusPollTimer = setInterval(pollStatus, 2000)
  }
  listenBt()
})

onDeactivated(() => {
  if (statusPollTimer) {
    clearInterval(statusPollTimer)
    statusPollTimer = null
  }
  if (btUnsub) {
    btUnsub()
    btUnsub = null
  }
})

function listenBt(): void {
  if (btUnsub) return
  if (!window.cockpit?.on) return
  btUnsub = window.cockpit.on('cockpit:bt', (event: unknown) => {
    const ev = event as Record<string, unknown>
    if (ev?.type === 'output' && String(ev.id ?? '').startsWith('bt-')) {
      const msgs = (ev.messages ?? []) as Record<string, unknown>[]
      for (const msg of msgs) {
        if (msg.data && typeof msg.data === 'object') {
          handleBtData(msg.data as Record<string, unknown>)
        }
      }
    }
    if (ev?.type === 'changed') {
      const tasks = (ev.tasks ?? []) as Record<string, unknown>[]
      for (const task of tasks) {
        if (
          String(task.name ?? '').includes('aidj') ||
          String(task.name ?? '').includes('persistent')
        ) {
          persistentRunning.value = task.status === 'running'
        }
      }
    }
    if (ev?.type === 'exit') {
      persistentRunning.value = false
    }
  })
}

function handleBtData(data: Record<string, unknown>): void {
  if (data.type === 'now_playing') {
    messages.value.push({
      role: 'assistant',
      content: `▶ 播放: ${String(data.track ?? '')}`,
      timestamp: Date.now()
    })
    scrollToBottom()
  } else if (data.type === 'status' && data.message === 'started') {
    messages.value.push({
      role: 'system',
      content: `持久模式已启动 | 提示: ${String(data.prompt ?? '')}`,
      timestamp: Date.now()
    })
    scrollToBottom()
  }
}

async function pollStatus(): Promise<void> {
  try {
    const result = (await window.cockpit.command('aidj.status')) as Record<string, unknown>
    if (result?.ok && result.status) {
      playerStatus.value = result.status as PlayerStatus
    }
    if (result?.ok) {
      if (typeof result.tracks === 'number') sbTracks.value = result.tracks
      if (typeof result.memory === 'number') sbMemory.value = result.memory
      if (result.volbal) sbVolbal.value = result.volbal as { enabled: boolean; method: string }
      if (typeof result.recordFreq === 'boolean') sbRecordFreq.value = result.recordFreq
      if (result.statusBar) {
        sbOrder.value = {
          tokens: 1,
          tracks: 2,
          memory: 3,
          volbal: 4,
          record_freq: 5,
          ...(result.statusBar as Record<string, number>)
        }
      }
    }
  } catch {
    /* noop */
  }
}

async function pollPlayers(): Promise<void> {
  try {
    const result = (await window.cockpit.command('aidj.list-players')) as Record<string, unknown>
    if (result?.ok && Array.isArray(result.players)) {
      availablePlayers.value = result.players as string[]
      autoMode.value = result.auto === true
      if (autoMode.value) {
        selectedPlayer.value = '__auto__'
      } else {
        const current = result.current as string
        if (current) {
          selectedPlayer.value = current
        }
      }
    }
  } catch {
    /* noop */
  }
}

async function selectPlayer(name: string): Promise<void> {
  if (!name) return
  const result = (await window.cockpit.command('aidj.select-player', {
    name
  })) as Record<string, unknown>
  if (result?.ok) {
    selectedPlayer.value = name
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.shiftKey && e.key === 'Enter' && !sending.value && !thinking.value) {
    e.preventDefault()
    sendMessage()
  }
}

async function sendMessage(): Promise<void> {
  const text = inputText.value.trim()
  if (!text || sending.value || thinking.value) return

  pendingText.value = text
  inputText.value = ''
  messages.value.push({ role: 'user', content: text, timestamp: Date.now() })
  const placeholderIdx = messages.value.length
  messages.value.push({
    role: 'assistant',
    content: '...',
    timestamp: Date.now()
  })
  scrollToBottom()

  if (mode.value === 'immediate') {
    sending.value = true
    let charTimer: ReturnType<typeof setInterval> | null = null
    charTimer = setInterval(async () => {
      if (!sending.value) { if (charTimer) clearInterval(charTimer); return }
      try {
        const r = (await window.cockpit.command('aidj.stream-status')) as Record<string, unknown>
        if (r?.ok && typeof r.chars === 'number') {
          const msg = messages.value[placeholderIdx]
          if (msg) msg.chars = r.chars as number
        }
      } catch { /* noop */ }
    }, 200)
    try {
      const result = (await window.cockpit.command('aidj.generate', {
        prompt: text
      })) as Record<string, unknown>
      if (result?.ok) {
        if (result.tokens)
          lastTokens.value = result.tokens as { prompt: number; completion: number }
        const pl = result.playlist as { name: string; path: string }[] | undefined
        if (pl && pl.length > 0) {
          messages.value[placeholderIdx] = {
            role: 'assistant',
            content: (result.intro as string) || '推荐歌单',
            playlist: pl as ChatMessage['playlist'],
            timestamp: Date.now()
          }
        } else if (result.intro) {
          messages.value[placeholderIdx] = {
            role: 'assistant',
            content: result.intro as string,
            timestamp: Date.now()
          }
          messages.value.push({
            role: 'system',
            content: '💬 AI 未生成歌曲列表（库中可能没有匹配的歌曲）',
            timestamp: Date.now()
          })
        }
      } else {
        messages.value[placeholderIdx] = {
          role: 'assistant',
          content: `错误: ${(result?.error as string) || '请求失败'}`,
          timestamp: Date.now()
        }
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      messages.value[placeholderIdx] = {
        role: 'assistant',
        content: `错误: ${e instanceof Error ? e.message : String(e)}`,
        timestamp: Date.now()
      }
    } finally {
      if (charTimer) clearInterval(charTimer)
      sending.value = false
      scrollToBottom()
    }
  } else {
    if (!persistentRunning.value) {
      messages.value.pop()
      messages.value.pop()
      await startPersistent(text)
    } else {
      messages.value.pop()
      messages.value.pop()
      await sendToPersistent(text)
    }
  }
}

async function stopSending(): Promise<void> {
  await window.cockpit.command('aidj.abort')
  sending.value = false
  inputText.value = pendingText.value
  pendingText.value = ''
  messages.value.splice(-2)
  scrollToBottom()
}

async function handlePlayAll(songs: { name: string; path: string }[]): Promise<void> {
  if (!songs.length) return
  const paths = songs.map((s) => s.path)
  await window.cockpit.command('aidj.send', { path: paths })
  pollStatus()
}

async function handlePlayOne(song: { path: string }): Promise<void> {
  await window.cockpit.command('aidj.send', { path: [song.path] })
  pollStatus()
}

function handleReorder(msgIdx: number, songs: { name: string; path: string }[]): void {
  const msg = messages.value[msgIdx]
  if (msg) {
    msg.playlist = songs
  }
}

async function startPersistent(prompt: string): Promise<void> {
  thinking.value = true
  try {
    const result = (await window.cockpit.btJob('aidj.persistent', {
      prompt
    })) as Record<string, unknown>
    if (result?.task || result?.ok) {
      persistentRunning.value = true
      messages.value.push({
        role: 'system',
        content: `持久模式已启动 | 提示: "${prompt}"`,
        timestamp: Date.now()
      })
    }
  } catch (e: unknown) {
    messages.value.push({
      role: 'system',
      content: `启动持久模式失败: ${e instanceof Error ? e.message : String(e)}`,
      timestamp: Date.now()
    })
  } finally {
    thinking.value = false
    scrollToBottom()
  }
}

async function sendToPersistent(text: string): Promise<void> {
  try {
    if (text.startsWith('/discard_follows')) {
      await window.cockpit.command('aidj.chat', { text })
      messages.value.push({
        role: 'system',
        content: '✅ 已丢弃后续待播歌曲',
        timestamp: Date.now()
      })
      scrollToBottom()
      return
    }
    await window.cockpit.command('aidj.chat', { text })
  } catch (e: unknown) {
    messages.value.push({
      role: 'system',
      content: `发送失败: ${e instanceof Error ? e.message : String(e)}`,
      timestamp: Date.now()
    })
    scrollToBottom()
  }
}

async function stopPersistent(): Promise<void> {
  try {
    await window.cockpit.command('aidj.stop-persistent')
    persistentRunning.value = false
    messages.value.push({
      role: 'system',
      content: '持久模式已停止',
      timestamp: Date.now()
    })
    scrollToBottom()
  } catch {
    // stop errors are non-fatal
  }
}

function scrollToBottom(): void {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

const ctxMenu = ref(false)
const ctxPos = ref({ x: 0, y: 0 })
const ctxTarget = ref('')
const ctxIsAi = ref(false)
const ctxSongs = ref<{ name: string }[]>([])
const ctxEl = ref<HTMLElement | null>(null)
let ctxCloseTimer: ReturnType<typeof setTimeout> | null = null

function handleContextMenu(
  e: MouseEvent,
  content: string,
  isAi: boolean,
  songs: { name: string }[]
): void {
  e.preventDefault()
  e.stopPropagation()
  ctxTarget.value = content
  ctxIsAi.value = isAi
  ctxSongs.value = songs
  const pos = { x: e.clientX + 8, y: e.clientY + 8 }
  if (ctxMenu.value) {
    ctxMenu.value = false
    if (ctxCloseTimer) clearTimeout(ctxCloseTimer)
    ctxCloseTimer = setTimeout(() => showCtx(pos), 120)
  } else {
    showCtx(pos)
  }
}

function showCtx(pos: { x: number; y: number }): void {
  ctxPos.value = pos
  ctxMenu.value = true
  nextTick(() => {
    const el = ctxEl.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    const margin = 8
    const x = Math.min(ctxPos.value.x, window.innerWidth - rect.width - margin)
    const y = Math.min(ctxPos.value.y, window.innerHeight - rect.height - margin)
    ctxPos.value = { x: Math.max(margin, x), y: Math.max(margin, y) }
  })
  document.addEventListener('click', closeCtx)
  document.addEventListener('keydown', onCtxKey)
}

function onCtxKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeCtx()
}

function copyToClipboard(text: string): void {
  navigator.clipboard.writeText(text)
  closeCtx()
}

function withSongs(text: string): string {
  const songs = ctxSongs.value
  if (!songs.length) return text
  const list = songs.map((s, i) => `${i + 1}. ${s.name}`).join('\n')
  return `${text}\n\n${list}`
}

function copyRendered(): void {
  const html = renderMarkdown(ctxTarget.value)
  copyToClipboard(withSongs(stripHtml(html) || ctxTarget.value))
}

function copyRaw(): void {
  copyToClipboard(withSongs(ctxTarget.value))
}

function stripHtml(html: string): string {
  const el = document.createElement('div')
  el.innerHTML = html
  return el.textContent || ''
}

function closeCtx(): void {
  ctxMenu.value = false
  if (ctxCloseTimer) {
    clearTimeout(ctxCloseTimer)
    ctxCloseTimer = null
  }
  document.removeEventListener('click', closeCtx)
  document.removeEventListener('keydown', onCtxKey)
}
</script>

<template>
  <div class="aidj-root d-flex flex-column h-100">
    <div class="px-4 py-3">
      <v-row dense align="center">
        <v-col cols="auto">
          <v-icon start>mdi-disc-player</v-icon>
          <span class="text-body-2 font-weight-medium ml-1">{{ t('aidj.now_playing') }}</span>
        </v-col>
        <v-col>
          <span class="text-body-2">{{ playerStatus.track || '—' }}</span>
          <v-chip
            size="small"
            variant="flat"
            :color="
              playerStatus.status === 'Playing'
                ? 'success'
                : playerStatus.status === 'Paused'
                  ? 'warning'
                  : 'secondary'
            "
            class="ml-2 status-chip"
          >
            {{ playerStatus.status }}
          </v-chip>
        </v-col>
        <v-col cols="auto" class="player-select-col">
          <v-select
            v-model="selectedPlayer"
            :items="[
              { title: t('aidj.current_active', '当前激活'), value: '__auto__' },
              ...availablePlayers.map((p) => ({ title: p, value: p }))
            ]"
            density="compact"
            variant="outlined"
            hide-details
            class="player-select"
            :placeholder="t('aidj.select_player', '选择播放器')"
            @update:model-value="selectPlayer"
          >
          </v-select>
        </v-col>
      </v-row>
      <v-row v-if="persistentRunning" dense class="mt-1">
        <v-col cols="auto">
          <v-chip size="small" color="info" variant="flat" class="status-chip">
            {{ t('aidj.mode_persistent') }}
          </v-chip>
        </v-col>
        <v-col cols="auto">
          <v-chip size="small" variant="tonal" class="status-chip">
            {{ t('aidj.queue_length') }}: {{ playerStatus.track ? 1 : 0 }}
          </v-chip>
        </v-col>
      </v-row>
    </div>

    <v-divider />

    <div
      ref="chatContainer"
      class="chat-area d-flex flex-column flex-grow-1 overflow-y-auto px-4 py-3"
    >
      <TransitionGroup
        name="msg"
        tag="div"
        class="d-flex flex-column ga-3 flex-grow-1"
      >
        <div
          v-if="messages.length === 0"
          key="empty"
          class="empty-state flex-grow-1 d-flex flex-column align-center justify-center text-center text-medium-emphasis"
        >
          <v-icon size="64" class="mb-4">mdi-chat-processing-outline</v-icon>
          <div class="text-h6">{{ t('aidj.heading') }}</div>
          <div class="text-body-2 mt-1">{{ t('aidj.input_placeholder') }}</div>
        </div>

        <ChatMessageVue
          v-for="(msg, idx) in messages"
          :key="msg.timestamp"
          :message="msg"
          @play-all="handlePlayAll"
          @play-one="handlePlayOne"
          @reorder="(songs: any) => handleReorder(idx, songs)"
          @context-menu="handleContextMenu"
        />
      </TransitionGroup>
    </div>

    <v-divider />

    <div class="input-overlay d-flex flex-column" :class="{ 'input-expanded': expanded }">
      <div class="aidj-status-bar">
        <template v-for="key in visibleStatus" :key="key">
          <template v-if="key === 'tokens'">
            <v-chip variant="flat" size="small" class="status-chip is-on">
              <span class="status-label">Prompt</span
              ><span class="status-value">{{ formatTokens(lastTokens.prompt) }}</span>
            </v-chip>
            <v-chip variant="flat" size="small" class="status-chip is-on">
              <span class="status-label">Completion</span
              ><span class="status-value">{{ formatTokens(lastTokens.completion) }}</span>
            </v-chip>
          </template>

          <v-chip
            v-else-if="key === 'tracks'"
            variant="flat"
            size="small"
            class="status-chip is-on"
          >
            <span class="status-label">Tracks</span
            ><span class="status-value">{{ sbTracks.toLocaleString() }}</span>
          </v-chip>

          <v-chip
            v-else-if="key === 'memory'"
            variant="flat"
            size="small"
            class="status-chip clickable is-on"
            @click="memoryConfirm = true"
            :title="'点击清空已播记忆'"
          >
            <span class="status-label">Memory</span
            ><span class="status-value">{{ sbMemory.toLocaleString() }}</span>
          </v-chip>

          <v-chip
            v-else-if="key === 'volbal'"
            variant="flat"
            size="small"
            class="status-chip clickable"
            :class="{ 'is-on': sbVolbal.enabled }"
            @click="toggleVolbal"
            :title="sbVolbal.enabled ? '点击关闭响度平衡' : '点击开启响度平衡'"
          >
            <span class="status-label">Volbal</span
            ><span class="status-value">{{ sbVolbal.enabled ? sbVolbal.method : 'off' }}</span>
          </v-chip>

          <v-chip
            v-else-if="key === 'record_freq'"
            variant="flat"
            size="small"
            class="status-chip clickable"
            :class="{ 'is-on': sbRecordFreq }"
            @click="toggleRecordFreq"
            :title="sbRecordFreq ? '点击关闭频率记录' : '点击开启频率记录'"
          >
            <span class="status-label">RecordFreq</span
            ><span class="status-value">{{ sbRecordFreq ? 'on' : 'off' }}</span>
          </v-chip>
        </template>
      </div>

      <template v-if="!expanded">
        <div class="input-bar d-flex ga-2 align-center px-4 pb-3">
          <v-btn-toggle
            v-model="mode"
            mandatory
            color="primary"
            variant="outlined"
            divided
            class="mode-toggle flex-shrink-0"
            style="white-space: nowrap"
          >
            <v-btn value="immediate" :disabled="persistentRunning" class="px-3">
              {{ t('aidj.mode_immediate') }}
            </v-btn>
            <v-btn value="persistent" :disabled="persistentRunning" class="px-3">
              {{ t('aidj.mode_persistent') }}
            </v-btn>
          </v-btn-toggle>

          <div class="textarea-wrap flex-grow-1">
            <v-textarea
              v-model="inputText"
              rows="1"
              :max-rows="3"
              auto-grow
              no-resize
              :placeholder="t('aidj.input_placeholder')"
              :disabled="thinking || (mode === 'persistent' && !persistentRunning)"
              hide-details
              variant="outlined"
              class="input-textarea"
              @keydown="onKeydown"
            />
            <v-btn
              v-if="inputText.includes('\n')"
              variant="text"
              size="small"
              class="expand-btn"
              @click="expanded = true"
              title="展开"
              >&lt;&gt;</v-btn
            >
          </div>

          <v-btn
            v-if="sending"
            color="error"
            variant="elevated"
            class="flex-shrink-0"
            @click="stopSending"
          >
            <v-icon start>mdi-stop</v-icon>
            {{ t('aidj.stop') }}
          </v-btn>
          <v-btn
            v-else
            :disabled="
              !inputText.trim() || (mode === 'persistent' && !persistentRunning && thinking)
            "
            color="primary"
            variant="elevated"
            class="flex-shrink-0"
            @click="sendMessage"
          >
            <v-icon start>mdi-send</v-icon>
            {{ t('aidj.send') }}
          </v-btn>

          <v-btn
            v-if="persistentRunning"
            color="error"
            variant="text"
            class="flex-shrink-0"
            @click="stopPersistent"
          >
            <v-icon start>mdi-stop</v-icon>
            {{ t('aidj.stop') }}
          </v-btn>
        </div>
      </template>

      <template v-else>
        <div class="d-flex align-center ga-2 px-4 pt-1">
          <v-btn-toggle
            v-model="mode"
            mandatory
            color="primary"
            variant="outlined"
            divided
            class="mode-toggle flex-shrink-0"
            style="white-space: nowrap"
          >
            <v-btn value="immediate" :disabled="persistentRunning" class="px-3">
              {{ t('aidj.mode_immediate') }}
            </v-btn>
            <v-btn value="persistent" :disabled="persistentRunning" class="px-3">
              {{ t('aidj.mode_persistent') }}
            </v-btn>
          </v-btn-toggle>

          <v-spacer />

          <v-btn
            v-if="sending"
            color="error"
            variant="elevated"
            class="flex-shrink-0"
            @click="stopSending"
          >
            <v-icon start>mdi-stop</v-icon>
            {{ t('aidj.stop') }}
          </v-btn>
          <v-btn
            v-else
            :disabled="
              !inputText.trim() || (mode === 'persistent' && !persistentRunning && thinking)
            "
            color="primary"
            variant="elevated"
            class="flex-shrink-0"
            @click="sendMessage"
          >
            <v-icon start>mdi-send</v-icon>
            {{ t('aidj.send') }}
          </v-btn>

          <v-btn
            v-if="persistentRunning"
            color="error"
            variant="text"
            class="flex-shrink-0"
            @click="stopPersistent"
          >
            <v-icon start>mdi-stop</v-icon>
            {{ t('aidj.stop') }}
          </v-btn>

          <v-btn
            variant="text"
            size="small"
            class="flex-shrink-0"
            @click="expanded = false"
            title="收缩"
            >&gt;&lt;</v-btn
          >
        </div>

        <div class="expanded-textarea-wrap flex-grow-1 px-4 pb-3">
          <v-textarea
            v-model="inputText"
            :auto-grow="false"
            rows="8"
            :placeholder="t('aidj.input_placeholder')"
            :disabled="thinking || (mode === 'persistent' && !persistentRunning)"
            hide-details
            variant="outlined"
            class="h-100 input-textarea"
            @keydown="onKeydown"
          />
        </div>
      </template>
    </div>

    <v-dialog v-model="memoryConfirm" width="420">
      <v-card rounded="lg">
        <v-card-title class="text-subtitle-1">
          <v-icon start>mdi-delete-sweep</v-icon>
          {{ t('aidj.clear_memory_title', '清空已播记忆') }}
        </v-card-title>
        <v-card-text class="text-body-2">
          {{ t('aidj.clear_memory_text', '确定要清空已播放歌曲的记忆吗？AI 将不再回避这些歌曲。') }}
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="memoryConfirm = false">
            {{ t('aidj.cancel', '取消') }}
          </v-btn>
          <v-btn color="error" @click="clearMemory">
            {{ t('aidj.clear', '清空') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <Teleport to="body">
      <Transition name="ctx">
        <div
          v-if="ctxMenu"
          ref="ctxEl"
          class="aidj-ctx-menu"
          :style="{ left: ctxPos.x + 'px', top: ctxPos.y + 'px' }"
          @click.stop
        >
          <button class="aidj-ctx-item" @click="copyRendered">
            <v-icon icon="mdi-content-copy" size="14" />
            <span>复制</span>
          </button>
          <button v-if="ctxIsAi" class="aidj-ctx-item" @click="copyRaw">
            <v-icon icon="mdi-code-tags" size="14" />
            <span>CopyRaw</span>
          </button>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.aidj-root {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.chat-area {
  min-height: 0;
  scroll-behavior: smooth;
}
.chat-area::-webkit-scrollbar {
  width: 6px;
}
.chat-area::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.45);
  border-radius: 3px;
}
.input-overlay {
  flex-shrink: 0;
  background: rgb(var(--v-theme-surface));
  border-top: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
}
.aidj-status-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  padding: 6px 16px 10px;
}
.status-chip {
  padding-block: 4px;
  min-height: 24px;
}
.status-chip.clickable {
  cursor: pointer;
}
.status-chip.clickable:hover {
  filter: brightness(1.15);
}
.status-chip.is-on {
  background: rgba(var(--v-theme-success-container), 0.9);
  color: rgb(var(--v-theme-on-success-container));
}
.status-chip .status-label {
  opacity: 0.6;
  margin-right: 5px;
}
.status-chip .status-value {
  font-family: monospace;
  font-weight: 600;
}
.input-overlay.input-expanded {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 80%;
  z-index: 10;
  display: flex;
  flex-direction: column;
}
.expanded-textarea-wrap {
  min-height: 0;
}
.expanded-textarea-wrap :deep(.v-textarea) {
  height: 100% !important;
}
.expanded-textarea-wrap :deep(.v-textarea) textarea {
  height: 100% !important;
  max-height: none !important;
}
.status-chip {
  padding-block: 4px;
  min-height: 24px;
}
.mode-toggle {
  flex: 0 0 auto;
}
.textarea-wrap {
  position: relative;
  flex: 1 1 auto;
  min-width: 120px;
}
.expand-btn {
  position: absolute;
  top: 4px;
  right: 8px;
  min-width: 28px;
  opacity: 0.6;
  z-index: 1;
}
.expand-btn:hover {
  opacity: 1;
}
.expanded-btn {
  top: 8px;
  right: 12px;
}
.input-textarea {
  min-width: 120px;
}
.input-bar > .v-btn {
  flex: 0 0 auto;
  height: 36px;
}
.input-bar > .v-btn-toggle {
  flex: 0 0 auto;
  height: 36px;
}
.player-select-col {
  min-width: 200px;
  max-width: 280px;
}
.player-select {
  min-width: 160px;
}
.player-select :deep(.v-field) {
  font-size: 0.8rem;
}
.player-select :deep(.v-select__selection) {
  font-size: 0.8rem;
}

.msg-enter-active {
  transition: all 0.3s ease-out;
}
.msg-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.msg-leave-active {
  transition: all 0.2s ease-in;
}
.msg-leave-to {
  opacity: 0;
  transform: translateX(-20px);
}
</style>

<style>
.aidj-ctx-menu {
  position: fixed;
  z-index: 3000;
  min-width: 110px;
  padding: 4px;
  border-radius: 8px;
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.25);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.aidj-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.8rem;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.aidj-ctx-item:hover {
  background: rgba(var(--v-theme-primary), 0.15);
}
.ctx-enter-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.ctx-leave-active {
  transition: opacity 0.1s ease;
}
.ctx-enter-from {
  opacity: 0;
  transform: scale(0.92) translateY(-4px);
}
.ctx-enter-to {
  opacity: 1;
  transform: scale(1) translateY(0);
}
.ctx-leave-to {
  opacity: 0;
}
</style>
