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

defineOptions({ name: 'cockpit-aidj' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const mode = ref<'immediate' | 'persistent'>('immediate')
const thinking = ref(false)
const persistentRunning = ref(false)
const chatContainer = ref<HTMLElement | null>(null)
const expanded = ref(false)

const playerStatus = ref<PlayerStatus>({ status: 'Unknown', track: '', volume: null, player: '' })
const lastTokens = ref<{ prompt: number; completion: number }>({ prompt: 0, completion: 0 })
const sbTracks = ref(0)
const sbVolbal = ref<{ enabled: boolean; method: string }>({ enabled: false, method: 'lufs' })
const sbRecordFreq = ref(false)
const sbOrder = ref<Record<string, number>>({
  tokens: 1,
  tracks: 2,
  volbal: 3,
  record_freq: 4
})

function formatTokens(n: number): string {
  if (n >= 1000) {
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'k'
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
let statusPollTimer: ReturnType<typeof setInterval> | null = null
let btUnsub: (() => void) | null = null

onMounted(() => {
  pollStatus()
  statusPollTimer = setInterval(pollStatus, 2000)
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
      if (result.volbal) sbVolbal.value = result.volbal as { enabled: boolean; method: string }
      if (typeof result.recordFreq === 'boolean') sbRecordFreq.value = result.recordFreq
      if (result.statusBar) sbOrder.value = result.statusBar as Record<string, number>
    }
  } catch {
    /* noop */
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.shiftKey && e.key === 'Enter' && !thinking.value) {
    e.preventDefault()
    sendMessage()
  }
}

async function sendMessage(): Promise<void> {
  const text = inputText.value.trim()
  if (!text || thinking.value) return

  inputText.value = ''
  messages.value.push({ role: 'user', content: text, timestamp: Date.now() })
  scrollToBottom()

  if (mode.value === 'immediate') {
    thinking.value = true
    try {
      const result = (await window.cockpit.command('aidj.generate', {
        prompt: text
      })) as Record<string, unknown>
      if (result?.ok) {
        if (result.tokens)
          lastTokens.value = result.tokens as { prompt: number; completion: number }
        const pl = result.playlist as { name: string; path: string }[] | undefined
        if (pl && pl.length > 0) {
          messages.value.push({
            role: 'assistant',
            content: (result.intro as string) || '推荐歌单',
            playlist: pl as ChatMessage['playlist'],
            timestamp: Date.now()
          })
        } else if (result.intro) {
          messages.value.push({
            role: 'assistant',
            content: result.intro as string,
            timestamp: Date.now()
          })
          messages.value.push({
            role: 'system',
            content: '💬 AI 未生成歌曲列表（库中可能没有匹配的歌曲）',
            timestamp: Date.now()
          })
        }
      } else {
        messages.value.push({
          role: 'assistant',
          content: `错误: ${(result?.error as string) || '请求失败'}`,
          timestamp: Date.now()
        })
      }
    } catch (e: unknown) {
      messages.value.push({
        role: 'assistant',
        content: `错误: ${e instanceof Error ? e.message : String(e)}`,
        timestamp: Date.now()
      })
    } finally {
      thinking.value = false
      scrollToBottom()
    }
  } else {
    if (!persistentRunning.value) {
      await startPersistent(text)
    } else {
      await sendToPersistent(text)
    }
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
      class="chat-area flex-grow-1 overflow-y-auto px-4 py-3 d-flex flex-column ga-3"
    >
      <div
        v-if="messages.length === 0"
        class="empty-state flex-grow-1 d-flex flex-column align-center justify-center text-center text-medium-emphasis"
      >
        <v-icon size="64" class="mb-4">mdi-chat-processing-outline</v-icon>
        <div class="text-h6">{{ t('aidj.heading') }}</div>
        <div class="text-body-2 mt-1">{{ t('aidj.input_placeholder') }}</div>
      </div>

      <ChatMessageVue v-for="(msg, idx) in messages" :key="idx" :message="msg" />
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
        <div class="input-bar d-flex ga-2 align-start px-4 pb-3">
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
            :loading="thinking"
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
            :loading="thinking"
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
}
.input-bar > .v-btn-toggle {
  flex: 0 0 auto;
}
</style>
