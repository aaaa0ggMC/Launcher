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
import type { ChatMessage, PlayerStatus } from './types'
import ChatMessageVue from './components/ChatMessage.vue'
import ContextMenu from './components/ContextMenu.vue'

defineOptions({ name: 'cockpit-aidj' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const mode = ref<'immediate' | 'persistent'>('immediate')
const thinking = ref(false)
const persistentTaskId = ref('')
const sending = ref(false)
const pendingText = ref('')
const chatContainer = ref<HTMLElement | null>(null)
const expanded = ref(false)

let msgSeq = 0
function makeUid(): number {
  return ++msgSeq
}

const playerStatus = ref<PlayerStatus>({ status: 'Unknown', track: '', volume: null, player: '' })
const lastTokens = ref<{ prompt: number; completion: number }>({ prompt: 0, completion: 0 })
const lastContext = ref<{ prompt: number; completion: number }>({ prompt: 0, completion: 0 })
const sbTracks = ref(0)
const sbMemory = ref(0)
const sbVolbal = ref<{ enabled: boolean; method: string }>({ enabled: false, method: 'lufs' })
const sbRecordFreq = ref(false)
const sbBackgrounds = ref(0)
const memoryConfirm = ref(false)
const playAllConfirm = ref(false)
const pendingPlayAll = ref<{ name: string; path: string }[] | null>(null)
const snackOpen = ref(false)
const snackText = ref('')
const snackColor = ref('success')
const sbOrder = ref<Record<string, number>>({
  tokens: 1,
  context: 2,
  tracks: 3,
  memory: 4,
  volbal: 5,
  record_freq: 6,
  backgrounds: 7
})
const availablePlayers = ref<string[]>([])
const selectedPlayer = ref('')
const autoMode = ref(true)
const netState = ref<'ok' | 'bad' | 'checking'>('checking')

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
let playersPollTimer: ReturnType<typeof setInterval> | null = null
let netPollTimer: ReturnType<typeof setInterval> | null = null
let btUnsub: (() => void) | null = null

onMounted(() => {
  pollStatus()
  pollPlayers()
  pollNetwork()
  refreshBackgroundCount()
  statusPollTimer = setInterval(pollStatus, 2000)
  playersPollTimer = setInterval(pollPlayers, 5000)
  netPollTimer = setInterval(pollNetwork, 15000)
  listenBt()
})

onActivated(() => {
  if (!statusPollTimer) {
    statusPollTimer = setInterval(pollStatus, 2000)
  }
  if (!playersPollTimer) {
    playersPollTimer = setInterval(pollPlayers, 5000)
  }
  if (!netPollTimer) {
    netPollTimer = setInterval(pollNetwork, 15000)
  }
  listenBt()
  scrollToBottom()
})

onDeactivated(() => {
  if (statusPollTimer) {
    clearInterval(statusPollTimer)
    statusPollTimer = null
  }
  if (playersPollTimer) {
    clearInterval(playersPollTimer)
    playersPollTimer = null
  }
  if (netPollTimer) {
    clearInterval(netPollTimer)
    netPollTimer = null
  }
  if (btUnsub) {
    btUnsub()
    btUnsub = null
  }
})

async function pollNetwork(): Promise<void> {
  netState.value = 'checking'
  try {
    const r = (await window.cockpit.command('aidj.network-test')) as { ok?: boolean }
    netState.value = r?.ok ? 'ok' : 'bad'
  } catch {
    netState.value = 'bad'
  }
}

function refreshBackgroundCount(): void {
  window.cockpit
    .btList()
    .then((res) => {
      const r = res as { ok?: boolean; tasks?: { status?: string }[] } | null
      if (r?.ok && Array.isArray(r.tasks)) {
        sbBackgrounds.value = r.tasks.filter((t) => t.status === 'running').length
      }
    })
    .catch(() => {})
}

function listenBt(): void {
  if (btUnsub) return
  if (!window.cockpit?.on) return
  btUnsub = window.cockpit.on('cockpit:bt', (event: unknown) => {
    const ev = event as Record<string, unknown>
    if (ev?.type === 'output' && String(ev.id ?? '').startsWith('bt-')) {
      if (persistentTaskId.value && ev.id === persistentTaskId.value) {
        const msgs = (ev.messages ?? []) as Record<string, unknown>[]
        for (const msg of msgs) {
          if (msg.data && typeof msg.data === 'object') {
            handleBtData(msg.data as Record<string, unknown>)
          }
        }
      }
    }
    if (ev?.type === 'changed') {
      const tasks = (ev.tasks ?? []) as Record<string, unknown>[]
      sbBackgrounds.value = tasks.filter((t) => t.status === 'running').length
    }
    if (ev?.type === 'exit') {
      if (ev.id === persistentTaskId.value) {
        persistentTaskId.value = ''
      }
      sbBackgrounds.value = Math.max(0, sbBackgrounds.value - 1)
    }
  })
}

function handleBtData(data: Record<string, unknown>): void {
  if (data.type === 'now_playing') {
    messages.value.push({
      role: 'assistant',
      content: `▶ 播放: ${String(data.track ?? '')}`,
      timestamp: Date.now(),
      uid: makeUid()
    })
    scrollToBottom()
  } else if (data.type === 'status' && data.message === 'started') {
    messages.value.push({
      role: 'system',
      content: `持久模式已启动 | 提示: ${String(data.prompt ?? '')}`,
      timestamp: Date.now(),
      uid: makeUid()
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
          context: 2,
          tracks: 3,
          memory: 4,
          volbal: 5,
          record_freq: 6,
          backgrounds: 7,
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

function shortPlayer(name: string): string {
  const short = name.replace(/^org\.mpris\.MediaPlayer2\./, '')
  if (short.length <= 10) return short
  return short.slice(0, 5) + '…' + short.slice(-4)
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
  messages.value.push({ role: 'user', content: text, timestamp: Date.now(), uid: makeUid() })
  const placeholderIdx = messages.value.length
  messages.value.push({
    role: 'assistant',
    content: '...',
    timestamp: Date.now(),
    uid: makeUid()
  })
  scrollToBottom()

  if (mode.value === 'immediate') {
    sending.value = true
    let charTimer: ReturnType<typeof setInterval> | null = null
    charTimer = setInterval(async () => {
      if (!sending.value) {
        if (charTimer) clearInterval(charTimer)
        return
      }
      try {
        const r = (await window.cockpit.command('aidj.stream-status')) as Record<string, unknown>
        if (r?.ok) {
          const msg = messages.value[placeholderIdx]
          if (!msg) return
          if (typeof r.chars === 'number') msg.chars = r.chars as number
          if (r.retrying === true) {
            const elapsed = Math.round(((r.retryElapsed as number) ?? 0) / 1000)
            const err = (r.retryLastError as string) || ''
            msg.content = `重试中(${String(r.retryAttempt ?? 0)}: 已经${elapsed}s)${err ? `\n⚠️ ${err}` : ''}`
          }
        }
      } catch {
        /* noop */
      }
    }, 200)
    try {
      const result = (await window.cockpit.command('aidj.generate', {
        prompt: text
      })) as Record<string, unknown>
      if (messages.value[placeholderIdx] == null) return
      if (result?.ok) {
        if (result.tokens)
          lastTokens.value = result.tokens as { prompt: number; completion: number }
        if (result.context)
          lastContext.value = result.context as { prompt: number; completion: number }
        const pl = result.playlist as { name: string; path: string }[] | undefined
        const placeholderUid = messages.value[placeholderIdx]?.uid
        if (pl && pl.length > 0) {
          messages.value[placeholderIdx] = {
            role: 'assistant',
            content: (result.intro as string) || '推荐歌单',
            playlist: pl as ChatMessage['playlist'],
            timestamp: Date.now(),
            uid: placeholderUid ?? makeUid()
          }
        } else if (result.intro) {
          messages.value[placeholderIdx] = {
            role: 'assistant',
            content: result.intro as string,
            timestamp: Date.now(),
            uid: placeholderUid ?? makeUid()
          }
          messages.value.push({
            role: 'system',
            content: '💬 AI 未生成歌曲列表（库中可能没有匹配的歌曲）',
            timestamp: Date.now(),
            uid: makeUid()
          })
        } else {
          messages.value[placeholderIdx] = {
            role: 'assistant',
            content: '（AI 无输出）',
            timestamp: Date.now(),
            uid: placeholderUid ?? makeUid()
          }
        }
      } else {
        messages.value[placeholderIdx] = {
          role: 'assistant',
          content: `错误: ${(result?.error as string) || '请求失败'}`,
          timestamp: Date.now(),
          uid: messages.value[placeholderIdx]?.uid ?? makeUid()
        }
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      if (messages.value[placeholderIdx] == null) return
      messages.value[placeholderIdx] = {
        role: 'assistant',
        content: `错误: ${e instanceof Error ? e.message : String(e)}`,
        timestamp: Date.now(),
        uid: messages.value[placeholderIdx]?.uid ?? makeUid()
      }
    } finally {
      if (charTimer) clearInterval(charTimer)
      sending.value = false
      scrollToBottom()
    }
  } else {
    // persistent mode → start a background chat session, then return to immediate
    messages.value.pop()
    messages.value.pop()
    await startPersistentChat(text)
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
  try {
    const statusRes = (await window.cockpit.command('aidj.status')) as Record<string, unknown>
    const status = statusRes?.status as { player?: string } | undefined
    const resolved = status?.player || ''
    const player = resolved || (selectedPlayer.value !== '__auto__' ? selectedPlayer.value : '')

    const list = (await window.cockpit.command('aidj.continuous-list')) as Record<string, unknown>
    const tasks = (list?.tasks ?? []) as { player: string }[]
    const occupied = player ? tasks.some((t) => t.player === player) : false

    if (occupied) {
      pendingPlayAll.value = songs
      playAllConfirm.value = true
      return
    }
  } catch {
    /* fall through to direct send */
  }
  doPlayAll(songs)
}

function doPlayAll(songs: { name: string; path: string }[]): void {
  const paths = songs.map((s) => s.path)
  window.cockpit.command('aidj.send', { path: paths })
  pollStatus()
}

function confirmPlayAll(): void {
  playAllConfirm.value = false
  if (pendingPlayAll.value) {
    doPlayAll(pendingPlayAll.value)
    pendingPlayAll.value = null
  }
}

function showSnack(text: string, color = 'success'): void {
  snackText.value = text
  snackColor.value = color
  snackOpen.value = true
}

async function handleContinuous(songs: { name: string; path: string }[]): Promise<void> {
  if (!songs.length) return
  try {
    const statusRes = (await window.cockpit.command('aidj.status')) as Record<string, unknown>
    const status = statusRes?.status as { player?: string } | undefined
    const resolved = status?.player || ''
    const player = resolved || (selectedPlayer.value !== '__auto__' ? selectedPlayer.value : '')

    const list = (await window.cockpit.command('aidj.continuous-list')) as Record<string, unknown>
    const tasks = (list?.tasks ?? []) as { taskId: string; player: string }[]
    const existing = tasks.find((t) => t.player === player && player)

    if (existing) {
      const r = (await window.cockpit.command('aidj.continuous-enqueue', {
        task: existing.taskId,
        songs: JSON.stringify(songs.map((s) => ({ name: s.name, path: s.path })))
      })) as Record<string, unknown>
      if (r?.ok) {
        showSnack(`已加入连续播放队列 (共 ${r.total ?? songs.length} 首)`)
      } else {
        showSnack(`加入队列失败: ${(r?.error as string) || '未知错误'}`, 'error')
      }
      return
    }

    const r = (await window.cockpit.btJob('aidj.continuous', {
      songs: songs.map((s) => ({ name: s.name, path: s.path })),
      player: player || '__auto__',
      view: 'continuous'
    })) as Record<string, unknown>
    if (r?.ok && r.task) {
      showSnack(`已启动连续播放后台任务 (${songs.length} 首)`)
    } else {
      showSnack(`启动连续播放失败: ${(r?.error as string) || '未知错误'}`, 'error')
    }
  } catch (e: unknown) {
    showSnack(`推送到后台失败: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
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

/** Persistent mode: start a background chat session with the current conversation copied in. */
async function startPersistentChat(prompt: string): Promise<void> {
  try {
    const statusRes = (await window.cockpit.command('aidj.status')) as Record<string, unknown>
    const status = statusRes?.status as { player?: string } | undefined
    const resolved = status?.player || ''
    const player = resolved || (selectedPlayer.value !== '__auto__' ? selectedPlayer.value : '')

    const rollingHistory: string[] = []
    for (const m of messages.value) {
      if (m.playlist && m.playlist.length > 0) {
        for (const s of m.playlist) {
          rollingHistory.push(s.name)
        }
      }
    }

    const history: ChatMessage[] = [
      ...messages.value.map((m) => ({
        role: m.role,
        content: m.content,
        playlist: m.playlist ? JSON.parse(JSON.stringify(m.playlist)) : undefined,
        timestamp: m.timestamp
      })),
      { role: 'user', content: prompt, timestamp: Date.now() }
    ]

    const result = (await window.cockpit.btJob('aidj.chat', {
      prompt,
      history: JSON.parse(JSON.stringify(history)),
      rollingHistory,
      player: player || '__auto__',
      view: 'chat'
    })) as Record<string, unknown>
    if (result?.task || result?.ok) {
      const task = result.task as { id?: string } | undefined
      if (task?.id) persistentTaskId.value = task.id
      mode.value = 'immediate'
      showSnack('已在后台启动持续会话，可打开后台面板继续对话')
    } else {
      showSnack(`启动持续会话失败: ${(result?.error as string) || '未知错误'}`, 'error')
    }
  } catch (e: unknown) {
    showSnack(`启动持续会话失败: ${e instanceof Error ? e.message : String(e)}`, 'error')
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
const ctxMsgIndex = ref(-1)
let ctxCloseTimer: ReturnType<typeof setTimeout> | null = null

function handleContextMenu(
  e: MouseEvent,
  content: string,
  isAi: boolean,
  songs: { name: string }[],
  msgIndex: number
): void {
  e.preventDefault()
  e.stopPropagation()
  ctxTarget.value = content
  ctxIsAi.value = isAi
  ctxSongs.value = songs
  ctxMsgIndex.value = msgIndex
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

async function doRevert(): Promise<void> {
  const idx = ctxMsgIndex.value
  if (idx < 0) return
  ctxMenu.value = false
  // Count user/assistant messages BEFORE the clicked one (skip now_playing pseudo-messages).
  let keep = 0
  for (let i = 0; i < idx && i < messages.value.length; i++) {
    const m = messages.value[i]
    if (
      (m.role === 'user' || m.role === 'assistant') &&
      !(m.role === 'assistant' && m.content.startsWith('▶ 播放'))
    ) {
      keep++
    }
  }
  const removed = messages.value.splice(idx)
  try {
    await window.cockpit.command('aidj.revert', { keep })
  } catch (e) {
    messages.value.splice(idx, 0, ...removed)
    showSnack(`回退失败: ${e instanceof Error ? e.message : String(e)}`, 'error')
    return
  }
  showSnack(`已回退到第 ${keep} 条消息`)
  scrollToBottom()
}

// ---------------------------------------------------------------------------
// Markdown export — dump the current conversation (messages + playlists).
// App.vue's copyCurrentView calls toMarkdown() for the copy-view shortcut.
// ---------------------------------------------------------------------------
function toMarkdown(): string {
  const lines: string[] = []
  for (const m of messages.value) {
    if (m.role === 'user') {
      lines.push(`**You**:\n\n${m.content}\n`)
    } else if (m.role === 'assistant') {
      if (m.content === '...') continue
      if (m.content.startsWith('▶ 播放')) {
        lines.push(`> ${m.content}\n`)
        continue
      }
      lines.push(`**AI DJ**:\n\n${m.content}\n`)
      if (m.playlist && m.playlist.length > 0) {
        m.playlist.forEach((s, i) => lines.push(`${i + 1}. ${s.name}`))
        lines.push('')
      }
    } else if (m.role === 'system' && m.content) {
      lines.push(`> ${m.content}\n`)
    }
  }
  return lines.join('\n').trim() + '\n'
}

defineExpose({ toMarkdown })
</script>

<template>
  <div class="aidj-root d-flex flex-column h-100">
    <div class="px-4 py-3">
      <v-row dense align="center">
        <v-col cols="auto">
          <v-icon start>mdi-disc-player</v-icon>
          <span class="text-body-2 font-weight-medium ml-1">{{ t('aidj.now_playing') }}</span>
        </v-col>
        <v-col class="min-w-0 d-flex align-center">
          <span class="text-body-2 track-name text-truncate">{{ playerStatus.track || '—' }}</span>
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
            class="ml-2 status-chip flex-shrink-0"
          >
            {{ playerStatus.status }}
          </v-chip>
          <v-chip
            size="small"
            variant="flat"
            :color="netState === 'ok' ? 'success' : netState === 'checking' ? 'secondary' : 'error'"
            class="ml-2 status-chip flex-shrink-0"
            :title="netState === 'ok' ? 'AI API 已连接' : 'AI API 无法连接'"
          >
            <span class="d-flex align-center ga-1">
              <v-icon size="12">
                {{
                  netState === 'ok'
                    ? 'mdi-wifi-check'
                    : netState === 'checking'
                      ? 'mdi-wifi-sync'
                      : 'mdi-wifi-off'
                }}
              </v-icon>
              <span>{{ netState === 'ok' ? 'API' : netState === 'checking' ? '…' : '离线' }}</span>
            </span>
          </v-chip>
        </v-col>
        <v-col cols="auto" class="player-select-col">
          <v-select
            v-model="selectedPlayer"
            :items="[
              { title: t('aidj.current_active', '当前激活'), value: '__auto__' },
              ...availablePlayers.map((p) => ({ title: shortPlayer(p), value: p }))
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
    </div>

    <v-divider />

    <div
      ref="chatContainer"
      class="chat-area d-flex flex-column flex-grow-1 overflow-y-auto px-4 py-3"
    >
      <TransitionGroup name="msg" tag="div" class="d-flex flex-column ga-3 flex-grow-1">
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
          :key="msg.uid ?? msg.timestamp"
          :message="msg"
          :index="idx"
          @play-all="handlePlayAll"
          @play-one="handlePlayOne"
          @reorder="(songs: any) => handleReorder(idx, songs)"
          @context-menu="handleContextMenu"
          @continuous="handleContinuous"
        />
      </TransitionGroup>
    </div>

    <v-divider />

    <div class="input-overlay d-flex flex-column" :class="{ 'input-expanded': expanded }">
      <div class="aidj-status-bar">
        <template v-for="key in visibleStatus" :key="key">
          <template v-if="key === 'tokens'">
            <v-chip
              variant="flat"
              size="small"
              class="status-chip is-on"
              :title="'累计所有请求的 tokens 总和'"
            >
              <span class="status-label">Tokens</span
              ><span class="status-value">{{
                formatTokens(lastTokens.prompt + lastTokens.completion)
              }}</span>
            </v-chip>
          </template>

          <template v-else-if="key === 'context'">
            <v-chip
              variant="flat"
              size="small"
              class="status-chip is-on"
              :title="'单次请求的上下文输入 tokens'"
            >
              <span class="status-label">Context</span
              ><span class="status-value">{{ formatTokens(lastContext.prompt) }}</span>
            </v-chip>
            <v-chip
              variant="flat"
              size="small"
              class="status-chip is-on"
              :title="'单次请求的输出 tokens'"
            >
              <span class="status-label">Completion</span
              ><span class="status-value">{{ formatTokens(lastContext.completion) }}</span>
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

          <v-chip
            v-else-if="key === 'backgrounds'"
            variant="flat"
            size="small"
            class="status-chip"
            :class="{ 'is-on': sbBackgrounds > 0 }"
            :title="'运行中的后台任务数量'"
          >
            <span class="status-label">Backgrounds</span
            ><span class="status-value">{{ sbBackgrounds }}</span>
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
            <v-btn value="immediate" class="px-3">
              {{ t('aidj.mode_immediate') }}
            </v-btn>
            <v-btn value="persistent" class="px-3">
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
              :disabled="thinking"
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
            :disabled="!inputText.trim()"
            color="primary"
            variant="elevated"
            class="flex-shrink-0"
            @click="sendMessage"
          >
            <v-icon start>mdi-send</v-icon>
            {{ t('aidj.send') }}
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
            <v-btn value="immediate" class="px-3">
              {{ t('aidj.mode_immediate') }}
            </v-btn>
            <v-btn value="persistent" class="px-3">
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
            :disabled="!inputText.trim()"
            color="primary"
            variant="elevated"
            class="flex-shrink-0"
            @click="sendMessage"
          >
            <v-icon start>mdi-send</v-icon>
            {{ t('aidj.send') }}
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
            :disabled="thinking"
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

    <v-dialog v-model="playAllConfirm" width="440">
      <v-card rounded="lg">
        <v-card-title class="text-subtitle-1">
          <v-icon start>mdi-alert-circle-outline</v-icon>
          覆盖播放列表？
        </v-card-title>
        <v-card-text class="text-body-2">
          该播放器上有一个连续播放后台任务正在推送歌曲。直接播放全部可能与之冲突（两个来源会争抢切歌），冲突需要你自行处理。
          确认仍要播放全部吗？
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="playAllConfirm = false">
            {{ t('aidj.cancel', '取消') }}
          </v-btn>
          <v-btn color="primary" @click="confirmPlayAll"> 覆盖并播放 </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="snackOpen" :timeout="2500" :color="snackColor" location="top">
      {{ snackText }}
    </v-snackbar>

    <ContextMenu
      v-model="ctxMenu"
      :x="ctxPos.x"
      :y="ctxPos.y"
      :content="ctxTarget"
      :is-ai="ctxIsAi"
      :songs="ctxSongs"
      :can-revert="ctxMsgIndex >= 0"
      @revert="doRevert"
    />
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
  /* No smooth scroll: programmatic scroll-to-bottom on a long history would
     animate the whole distance and take seconds. Instant jump instead. */
  scroll-behavior: auto;
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
  background: transparent;
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
.track-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
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
