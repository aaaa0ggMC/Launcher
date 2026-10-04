<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from '../../main/ui/i18n'
import { useSettings } from '../../main/ui/composables/settings'
import type { Session, MessageNode, MessageAttachment, YayaConfig, WorkflowInfo } from './types'
import type { WorkflowSnapshot } from './services/loop/types'
import { buildTurns } from './components/turns'
import ChatSessionList from './components/ChatSessionList.vue'
import UserMessage from './components/UserMessage.vue'
import AssistantTurn from './components/AssistantTurn.vue'
import ChatInputBox from './components/ChatInputBox.vue'
import ModelSelectDialog from './components/ModelSelectDialog.vue'
import MessageMenu from './components/MessageMenu.vue'
import type { MessageMenuItem, MessageMenuRequest } from './components/message-menu'

defineOptions({ name: 'cockpit-yaya-view' })

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)
const settings = useSettings()

const config = ref<YayaConfig | null>(null)
const sessions = ref<Session[]>([])
/** null = 新对话草稿（首次发送 / 添加附件时才真正创建会话，避免空会话堆积） */
const activeSessionId = ref<string | null>(null)
const messages = ref<MessageNode[]>([])
const runningIds = ref<string[]>([])
const snapshot = ref<WorkflowSnapshot | null>(null)
const draft = ref('')
const showModelSelect = ref(false)
const loadingMessages = ref(false)
const notice = ref<{ text: string; error?: boolean } | null>(null)
const workflows = ref<WorkflowInfo[]>([])
/** 新对话草稿里选的工作流（会话创建时带上） */
const draftWorkflow = ref<string | null>(null)
const composerExpanded = ref(false)
const menuRequest = ref<MessageMenuRequest | null>(null)
const editingId = ref<string | null>(null)
const pendingDelete = ref<{ messageId: string; kind: 'user' | 'assistant' } | null>(null)

const shellEl = ref<HTMLElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)
const inputRef = ref<{ focus: () => void } | null>(null)

// ---- 布局：按容器宽度（不是窗口宽度）决定侧栏常驻还是弹出 ----
const shellWidth = ref(1200)
const wide = computed(() => shellWidth.value >= 900)
const sidebarPinned = ref(true)
const drawerOpen = ref(false)
const sidebarVisible = computed(() => (wide.value ? sidebarPinned.value : drawerOpen.value))
let ro: ResizeObserver | null = null

function toggleSidebar(): void {
  if (wide.value) sidebarPinned.value = !sidebarPinned.value
  else drawerOpen.value = !drawerOpen.value
}

// ---- 派生状态 ----
const assistantName = computed(() => config.value?.assistantName?.trim() || 'YAYA')
const activeSession = computed(() => sessions.value.find((s) => s.id === activeSessionId.value))
const isRunning = computed(
  () => !!activeSessionId.value && runningIds.value.includes(activeSessionId.value)
)
const turns = computed(() => buildTurns(messages.value))
const lastTurnKey = computed(() => turns.value[turns.value.length - 1]?.key)
const pendingApprovalId = computed(() =>
  isRunning.value && snapshot.value?.status === 'waiting_approval'
    ? (snapshot.value.pendingApprovalTool?.id ?? null)
    : null
)
const currentModel = computed(() => activeSession.value?.model || config.value?.activeModel || '')
const currentProviderId = computed(
  () => activeSession.value?.providerId || config.value?.activeProviderId || ''
)
const currentProviderName = computed(
  () => config.value?.providers.find((p) => p.id === currentProviderId.value)?.name ?? ''
)
const sessionTitle = computed(() => activeSession.value?.title || t('yaya.new_chat', '新对话'))

/** 当前会话的工作流：会话自己的选择 → 草稿选择 → 设置里的默认 → agent */
const currentWorkflowId = computed({
  get: () =>
    (activeSession.value?.meta?.workflow as string | undefined) ||
    draftWorkflow.value ||
    config.value?.defaultWorkflow ||
    'agent',
  set: (id: string) => {
    const s = activeSession.value
    if (!s) {
      draftWorkflow.value = id
      return
    }
    s.meta = { ...(s.meta ?? {}), workflow: id }
    window.cockpit.command('yaya.session-update', { id: s.id, workflow: id }).catch((e) => {
      showNotice(errText(e), true)
    })
  }
})

// ---- 滚动：贴底时跟随，用户上翻后不打扰 ----
const stickToBottom = ref(true)
function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  stickToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80
}
async function scrollToBottom(force = false): Promise<void> {
  await nextTick()
  const el = scrollEl.value
  if (el && (force || stickToBottom.value)) {
    el.scrollTop = el.scrollHeight
    stickToBottom.value = true
  }
}

// ---- 数据加载 ----
async function loadConfig(): Promise<void> {
  try {
    config.value = (await window.cockpit.command('yaya.config-get')) as YayaConfig
  } catch (e) {
    console.error('[yaya] load config failed', e)
  }
}

async function loadWorkflows(): Promise<void> {
  try {
    workflows.value = (await window.cockpit.command('yaya.workflows-list')) as WorkflowInfo[]
  } catch {
    workflows.value = []
  }
}

async function loadSessions(): Promise<void> {
  try {
    sessions.value = (await window.cockpit.command('yaya.sessions', {
      activeSession: activeSessionId.value || undefined
    })) as Session[]
    if (activeSessionId.value && !activeSession.value) activeSessionId.value = null
  } catch (e) {
    console.error('[yaya] load sessions failed', e)
  }
}

let loadSeq = 0
async function loadMessages(): Promise<void> {
  const id = activeSessionId.value
  if (!id) {
    messages.value = []
    return
  }
  const seq = ++loadSeq
  try {
    const branch = (await window.cockpit.command('yaya.messages-branch', {
      session: id
    })) as MessageNode[]
    if (seq !== loadSeq || id !== activeSessionId.value) return
    messages.value = branch
    void scrollToBottom()
  } catch (e) {
    console.error('[yaya] load messages failed', e)
  }
}

let reloadTimer: ReturnType<typeof setTimeout> | null = null
function scheduleReload(): void {
  if (reloadTimer) return
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void loadMessages()
  }, 60)
}

async function refreshSnapshot(): Promise<void> {
  if (!activeSessionId.value) {
    snapshot.value = null
    return
  }
  try {
    snapshot.value = (await window.cockpit.command('yaya.workflow-snapshot', {
      session: activeSessionId.value
    })) as WorkflowSnapshot | null
  } catch {
    snapshot.value = null
  }
}

async function selectSession(id: string): Promise<void> {
  drawerOpen.value = false
  if (id === activeSessionId.value) return
  activeSessionId.value = id
  messages.value = []
  loadingMessages.value = true
  await Promise.all([loadMessages(), refreshSnapshot()])
  loadingMessages.value = false
  void scrollToBottom(true)
}

function newChat(): void {
  drawerOpen.value = false
  activeSessionId.value = null
  messages.value = []
  snapshot.value = null
  draftWorkflow.value = null
  void nextTick(() => inputRef.value?.focus())
}

async function ensureSession(): Promise<string> {
  if (activeSessionId.value) return activeSessionId.value
  const s = (await window.cockpit.command('yaya.session-create', {
    title: t('yaya.new_chat', '新对话'),
    model: config.value?.activeModel,
    provider: config.value?.activeProviderId,
    workflow: draftWorkflow.value || undefined
  })) as Session
  sessions.value.unshift(s)
  activeSessionId.value = s.id
  return s.id
}

// ---- 发送 / 控制 ----
async function handleSend(prompt: string, attachments: MessageAttachment[]): Promise<void> {
  try {
    const firstMessage = !activeSessionId.value || messages.value.length === 0
    const id = await ensureSession()
    if (firstMessage) {
      const title = (prompt || attachments[0]?.name || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      if (title) {
        await window.cockpit.command('yaya.session-update', { id, title })
        const s = sessions.value.find((x) => x.id === id)
        if (s) s.title = title
      }
    }
    await window.cockpit.command('yaya.workflow-start', {
      session: id,
      prompt,
      attachments
    })
    markRunning(id)
    await loadMessages()
    void scrollToBottom(true)
  } catch (e) {
    showNotice(te('yaya.send_failed', { error: errText(e) }, '发送失败：{error}'), true)
  }
}

async function handleEdit(message: MessageNode, text: string): Promise<void> {
  if (!activeSessionId.value) return
  try {
    await window.cockpit.command('yaya.workflow-start', {
      session: activeSessionId.value,
      prompt: text,
      attachments: JSON.parse(JSON.stringify(message.attachments ?? [])),
      parent: message.parentId
    })
    markRunning(activeSessionId.value)
    await loadMessages()
    void scrollToBottom(true)
  } catch (e) {
    showNotice(te('yaya.send_failed', { error: errText(e) }, '发送失败：{error}'), true)
  }
}

async function handleRegenerate(fromMessageId: string): Promise<void> {
  if (!activeSessionId.value) return
  try {
    await window.cockpit.command('yaya.workflow-regenerate', {
      session: activeSessionId.value,
      message: fromMessageId
    })
    markRunning(activeSessionId.value)
    await loadMessages()
    void scrollToBottom(true)
  } catch (e) {
    showNotice(errText(e), true)
  }
}

async function handleAbort(): Promise<void> {
  if (!activeSessionId.value) return
  await window.cockpit.command('yaya.workflow-abort', { session: activeSessionId.value })
  runningIds.value = runningIds.value.filter((x) => x !== activeSessionId.value)
  await loadMessages()
}

async function handleApprove(approved: boolean): Promise<void> {
  if (!activeSessionId.value) return
  await window.cockpit.command('yaya.workflow-approve', {
    session: activeSessionId.value,
    approved
  })
}

async function handleSwitchBranch(messageId: string): Promise<void> {
  if (!activeSessionId.value) return
  try {
    await window.cockpit.command('yaya.session-switch-leaf', {
      session: activeSessionId.value,
      leaf: messageId
    })
    await loadMessages()
  } catch (e) {
    showNotice(errText(e), true)
  }
}

async function handleDelete(id: string): Promise<void> {
  await window.cockpit.command('yaya.session-delete', { id })
  sessions.value = sessions.value.filter((s) => s.id !== id)
  if (activeSessionId.value === id) newChat()
}

async function handleRename(id: string, title: string): Promise<void> {
  await window.cockpit.command('yaya.session-update', { id, title })
  const s = sessions.value.find((x) => x.id === id)
  if (s) s.title = title
}

async function handleImport(): Promise<void> {
  const path = await window.cockpit.pickFile({
    title: t('yaya.import_title', '选择 ChatGPT 导出的 conversations.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!path) return
  try {
    await window.cockpit.command('yaya.import-openai', { path })
    showNotice(t('yaya.import_started', '已开始导入，进度见后台任务面板'))
  } catch (e) {
    showNotice(errText(e), true)
  }
}

async function exportSession(format: 'md' | 'jsonl'): Promise<void> {
  if (!activeSessionId.value) return
  const ext = format === 'md' ? 'md' : 'jsonl'
  const base = (activeSession.value?.title || 'chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)
  const out = await window.cockpit.pickSaveFile({
    title: t('yaya.export_title', '导出会话'),
    defaultPath: `${base}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  })
  if (!out) return
  try {
    await window.cockpit.command('yaya.session-export-file', {
      session: activeSessionId.value,
      format,
      out
    })
    showNotice(te('yaya.exported', { path: out }, '已导出到 {path}'))
  } catch (e) {
    showNotice(errText(e), true)
  }
}

async function handleModelSelect(payload: { model: string; providerId: string }): Promise<void> {
  const { model, providerId } = payload
  if (activeSessionId.value) {
    await window.cockpit.command('yaya.session-update', {
      id: activeSessionId.value,
      model,
      provider: providerId
    })
    const s = sessions.value.find((x) => x.id === activeSessionId.value)
    if (s) {
      s.model = model
      s.providerId = providerId
    }
  }
  // 同时作为之后新对话的默认模型
  if (config.value) {
    config.value.activeModel = model
    config.value.activeProviderId = providerId
    await saveConfig()
  }
}

async function handleAddCustomModel(payload: { model: string; providerId: string }): Promise<void> {
  const provider = config.value?.providers.find((p) => p.id === payload.providerId)
  if (!provider || provider.models.includes(payload.model)) return
  provider.models.push(payload.model)
  await saveConfig()
}

async function saveConfig(): Promise<void> {
  if (!config.value) return
  try {
    await window.cockpit.command('yaya.config-save', {
      config: JSON.parse(JSON.stringify(config.value))
    })
  } catch (e) {
    showNotice(errText(e), true)
  }
}

// ---- 消息右键 / 长按菜单 ----
const menuItems = computed<MessageMenuItem[]>(() => {
  const req = menuRequest.value
  if (!req) return []
  const items: MessageMenuItem[] = []
  if (req.selection.trim())
    items.push({
      key: 'copy-selection',
      icon: 'mdi-selection',
      label: t('yaya.menu.copy_selection', '复制选中内容')
    })
  items.push({
    key: 'copy',
    icon: 'mdi-content-copy',
    label:
      req.kind === 'user' ? t('yaya.copy', '复制') : t('yaya.menu.copy_markdown', '复制 Markdown')
  })
  if (req.kind === 'user') {
    items.push({
      key: 'edit',
      icon: 'mdi-pencil-outline',
      label: t('yaya.edit', '编辑并重新发送'),
      disabled: isRunning.value
    })
  } else {
    items.push({
      key: 'regenerate',
      icon: 'mdi-refresh',
      label: t('yaya.regenerate', '重新生成'),
      disabled: isRunning.value
    })
  }
  items.push({
    key: 'delete',
    icon: 'mdi-delete-outline',
    label:
      req.kind === 'user'
        ? t('yaya.menu.delete_from_here', '删除此消息及之后的对话')
        : t('yaya.menu.delete_answer', '删除这个回答'),
    danger: true,
    divider: true,
    disabled: isRunning.value
  })
  return items
})

async function onMenuSelect(key: string): Promise<void> {
  const req = menuRequest.value
  menuRequest.value = null
  if (!req) return
  switch (key) {
    case 'copy-selection':
      await window.cockpit.copyText(req.selection)
      break
    case 'copy':
      await window.cockpit.copyText(req.text)
      break
    case 'edit':
      editingId.value = req.messageId
      break
    case 'regenerate':
      await handleRegenerate(req.messageId)
      break
    case 'delete':
      pendingDelete.value = { messageId: req.messageId, kind: req.kind }
      break
  }
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value
  pendingDelete.value = null
  if (!target || !activeSessionId.value) return
  try {
    await window.cockpit.command('yaya.message-delete', {
      session: activeSessionId.value,
      id: target.messageId
    })
    await loadMessages()
  } catch (e) {
    showNotice(errText(e), true)
  }
}

function openSettings(): void {
  settings.open('yaya')
}

const suggestions = computed(() => [
  { icon: 'mdi-monitor-dashboard', text: t('yaya.suggest.system', '看看这台电脑现在的状态') },
  { icon: 'mdi-console-line', text: t('yaya.suggest.commands', '你能调用哪些 Cockpit 命令？') },
  { icon: 'mdi-folder-search-outline', text: t('yaya.suggest.files', '帮我整理下载目录里的文件') },
  { icon: 'mdi-web', text: t('yaya.suggest.web', '读一下这个网页并总结要点：') }
])
function useSuggestion(text: string): void {
  draft.value = text
  inputRef.value?.focus()
}

// ---- 小工具 ----
function markRunning(id: string): void {
  if (!runningIds.value.includes(id)) runningIds.value = [...runningIds.value, id]
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
let noticeTimer: ReturnType<typeof setTimeout> | null = null
function showNotice(text: string, error = false): void {
  notice.value = { text, error }
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (notice.value = null), error ? 8000 : 4000)
}

// ---- 流式事件 ----
interface ChunkEvent {
  sessionId: string
  messageId: string
  offset: number
}
/** 按 offset 追加：重复的块忽略，有缺口就整体重拉（拉取结果已叠加主进程缓冲） */
function applyChunk(p: ChunkEvent, field: 'content' | 'reasoningContent', chunk: string): void {
  if (p.sessionId !== activeSessionId.value) return
  const target = messages.value.find((m) => m.id === p.messageId)
  if (!target) return scheduleReload()
  const current = target[field] ?? ''
  if (current.length === p.offset) {
    target[field] = current + chunk
    if (target.status === 'pending') target.status = 'streaming'
    void scrollToBottom()
  } else if (current.length < p.offset) {
    scheduleReload()
  }
}

const unsubs: (() => void)[] = []

onMounted(async () => {
  if (shellEl.value) {
    ro = new ResizeObserver((entries) => {
      shellWidth.value = entries[0].contentRect.width
    })
    ro.observe(shellEl.value)
  }

  unsubs.push(
    window.cockpit.on('cockpit:yaya-token', (payload: unknown) => {
      const p = payload as ChunkEvent & { token: string }
      applyChunk(p, 'content', p.token)
    }),
    window.cockpit.on('cockpit:yaya-reasoning', (payload: unknown) => {
      const p = payload as ChunkEvent & { reasoning: string }
      applyChunk(p, 'reasoningContent', p.reasoning)
    }),
    window.cockpit.on('cockpit:yaya-loop', (payload: unknown) => {
      const s = payload as WorkflowSnapshot
      if (s.sessionId !== activeSessionId.value) return
      snapshot.value = s
      scheduleReload()
    }),
    window.cockpit.on('cockpit:yaya-running', (payload: unknown) => {
      runningIds.value = (payload as { sessionIds: string[] }).sessionIds
    }),
    window.cockpit.on('cockpit:yaya-config-changed', (payload: unknown) => {
      config.value = payload as YayaConfig
    }),
    window.cockpit.on('cockpit:yaya-sessions-changed', () => {
      void loadSessions()
    })
  )

  await Promise.all([loadConfig(), loadWorkflows()])
  await loadSessions()
  runningIds.value = ((await window.cockpit.command('yaya.workflow-running').catch(() => [])) ??
    []) as string[]
  // 默认打开最近的会话；没有会话就停在新对话
  if (sessions.value.length > 0) await selectSession(sessions.value[0].id)
})

onBeforeUnmount(() => {
  for (const off of unsubs) off()
  ro?.disconnect()
  if (reloadTimer) clearTimeout(reloadTimer)
  if (noticeTimer) clearTimeout(noticeTimer)
})

// 运行结束时刷新会话列表（updatedAt 排序）
watch(isRunning, (now, before) => {
  if (before && !now) void loadSessions()
})
</script>

<template>
  <div ref="shellEl" class="yaya-shell" :class="{ 'is-narrow': !wide }">
    <!-- 会话侧栏：宽屏常驻，窄屏弹出 -->
    <div v-if="!wide && drawerOpen" class="scrim" @click="drawerOpen = false" />
    <aside
      class="sidebar"
      :class="{ 'is-open': sidebarVisible, 'is-overlay': !wide }"
      :aria-hidden="!sidebarVisible"
    >
      <ChatSessionList
        :sessions="sessions"
        :active-session-id="activeSessionId"
        :running-session-ids="runningIds"
        @select-session="selectSession"
        @create-session="newChat"
        @delete-session="handleDelete"
        @rename-session="handleRename"
        @import="handleImport"
      />
    </aside>

    <section class="main">
      <header class="topbar">
        <v-btn
          icon
          variant="text"
          density="comfortable"
          :title="t('yaya.toggle_sessions', '会话列表')"
          :aria-label="t('yaya.toggle_sessions', '会话列表')"
          @click="toggleSidebar"
        >
          <v-icon icon="mdi-menu" />
        </v-btn>

        <div class="title-block">
          <div class="assistant-name">{{ assistantName }}</div>
          <div class="session-title text-medium-emphasis" :title="sessionTitle">
            {{ sessionTitle }}
          </div>
        </div>

        <button
          type="button"
          class="model-btn"
          :title="t('yaya.select_model', '选择模型')"
          @click="showModelSelect = true"
        >
          <span
            class="run-dot"
            :class="{ 'is-running': isRunning }"
            :aria-label="isRunning ? t('yaya.running', '运行中') : ''"
          />
          <span class="model-text">
            <span class="model-name">{{ currentModel || t('yaya.no_model', '未选择模型') }}</span>
            <span v-if="currentProviderName" class="provider-name">{{ currentProviderName }}</span>
          </span>
          <v-icon icon="mdi-chevron-down" size="18" />
        </button>

        <v-btn
          v-if="activeSessionId"
          icon
          variant="text"
          density="comfortable"
          :title="t('yaya.new_chat', '新对话')"
          :aria-label="t('yaya.new_chat', '新对话')"
          @click="newChat"
        >
          <v-icon icon="mdi-square-edit-outline" />
        </v-btn>

        <v-menu location="bottom end">
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              icon
              variant="text"
              density="comfortable"
              :title="t('yaya.more', '更多')"
              :aria-label="t('yaya.more', '更多')"
            >
              <v-icon icon="mdi-dots-vertical" />
            </v-btn>
          </template>
          <v-list density="comfortable" min-width="220">
            <v-list-item
              prepend-icon="mdi-language-markdown-outline"
              :title="t('yaya.export_md', '导出为 Markdown')"
              :disabled="!activeSessionId"
              @click="exportSession('md')"
            />
            <v-list-item
              prepend-icon="mdi-code-json"
              :title="t('yaya.export_jsonl', '导出为 JSONL')"
              :disabled="!activeSessionId"
              @click="exportSession('jsonl')"
            />
            <v-divider class="my-1" />
            <v-list-item
              prepend-icon="mdi-cog-outline"
              :title="t('yaya.settings', '设置')"
              @click="openSettings"
            />
          </v-list>
        </v-menu>
      </header>

      <div ref="scrollEl" class="scroll" @scroll.passive="onScroll">
        <div class="thread">
          <div v-if="loadingMessages" class="loading">
            <v-progress-circular indeterminate size="28" width="3" color="primary" />
          </div>

          <div v-else-if="turns.length === 0" class="empty">
            <div class="empty-avatar">
              <v-icon icon="mdi-robot-happy-outline" size="36" />
            </div>
            <h2 class="empty-title">
              {{ te('yaya.empty_title', { name: assistantName }, '有什么可以帮你？') }}
            </h2>
            <p class="empty-sub text-medium-emphasis">
              {{
                te(
                  'yaya.empty_subtitle',
                  { name: assistantName },
                  '{name} 可以调用本机工具：查看系统状态、读写文件、执行命令（会先征求你的同意）'
                )
              }}
            </p>
            <div class="suggestions">
              <button
                v-for="s in suggestions"
                :key="s.text"
                type="button"
                class="suggestion"
                @click="useSuggestion(s.text)"
              >
                <v-icon :icon="s.icon" size="20" class="text-primary flex-shrink-0" />
                <span>{{ s.text }}</span>
              </button>
            </div>
          </div>

          <template v-for="turn in turns" :key="turn.key">
            <UserMessage
              v-if="turn.kind === 'user'"
              :message="turn.message"
              :busy="isRunning"
              :editing="editingId === turn.message.id"
              @update:editing="(on: boolean) => (editingId = on ? turn.message.id : null)"
              @switch-branch="handleSwitchBranch"
              @edit="(text) => handleEdit(turn.message, text)"
              @menu="(req) => (menuRequest = req)"
            />
            <AssistantTurn
              v-else
              :turn="turn"
              :assistant-name="assistantName"
              :live="isRunning && turn.key === lastTurnKey"
              :pending-approval-id="turn.key === lastTurnKey ? pendingApprovalId : null"
              :is-last="turn.key === lastTurnKey"
              @switch-branch="handleSwitchBranch"
              @approve="handleApprove"
              @regenerate="handleRegenerate"
              @menu="(req) => (menuRequest = req)"
            />
          </template>
        </div>
      </div>

      <div class="composer" :class="{ 'is-expanded': composerExpanded }">
        <transition name="fade">
          <v-btn
            v-if="!stickToBottom && turns.length > 0"
            class="jump-btn"
            icon
            density="comfortable"
            variant="elevated"
            :title="t('yaya.jump_bottom', '回到底部')"
            :aria-label="t('yaya.jump_bottom', '回到底部')"
            @click="scrollToBottom(true)"
          >
            <v-icon icon="mdi-arrow-down" />
          </v-btn>
        </transition>
        <transition name="fade">
          <div v-if="notice" class="notice" :class="{ 'is-error': notice.error }" role="status">
            <span>{{ notice.text }}</span>
            <v-btn
              icon="mdi-close"
              variant="text"
              size="x-small"
              :title="t('yaya.close', '关闭')"
              :aria-label="t('yaya.close', '关闭')"
              @click="notice = null"
            />
          </div>
        </transition>
        <ChatInputBox
          ref="inputRef"
          v-model="draft"
          v-model:workflow-id="currentWorkflowId"
          v-model:expanded="composerExpanded"
          :workflows="workflows"
          :is-running="isRunning"
          :session-id="activeSessionId || ''"
          :ensure-session="ensureSession"
          :assistant-name="assistantName"
          @send="handleSend"
          @abort="handleAbort"
        />
      </div>
    </section>

    <MessageMenu
      :request="menuRequest"
      :items="menuItems"
      @select="onMenuSelect"
      @close="menuRequest = null"
    />

    <v-dialog
      :model-value="pendingDelete !== null"
      max-width="420"
      @update:model-value="(v: boolean) => !v && (pendingDelete = null)"
    >
      <v-card class="pa-2">
        <v-card-title class="text-h6">{{ t('yaya.menu.delete_title', '删除消息') }}</v-card-title>
        <v-card-text class="text-body-2">
          {{
            pendingDelete?.kind === 'user'
              ? t(
                  'yaya.menu.delete_user_hint',
                  '这条消息以及它之后的所有回答、分支都会被删除，无法恢复。'
                )
              : t(
                  'yaya.menu.delete_answer_hint',
                  '这个回答（含它之后的追问分支）会被删除，无法恢复。'
                )
          }}
        </v-card-text>
        <v-card-actions class="px-4 pb-4 ga-2">
          <v-spacer />
          <v-btn variant="text" @click="pendingDelete = null">{{ t('yaya.cancel', '取消') }}</v-btn>
          <v-btn
            color="error"
            variant="flat"
            prepend-icon="mdi-delete-outline"
            @click="confirmDelete"
          >
            {{ t('yaya.menu.delete', '删除') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <ModelSelectDialog
      v-model="showModelSelect"
      :current-model="currentModel"
      :current-provider-id="currentProviderId"
      :config="config"
      @select="handleModelSelect"
      @add-custom-model="handleAddCustomModel"
    />
  </div>
</template>

<style scoped>
/* 与 AIDJ 一致：铺满能力页内容区，外壳不出滚动条，只有消息区滚动 */
.yaya-shell {
  position: absolute;
  inset: 0;
  display: flex;
  overflow: hidden;
}

/* ---- 会话侧栏 ---- */
.sidebar {
  flex: 0 0 auto;
  width: 0;
  overflow: hidden;
  border-right: 1px solid transparent;
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.35));
  transition:
    width 0.2s ease,
    border-color 0.2s ease;
}
.sidebar.is-open {
  width: 280px;
  border-right-color: rgba(var(--v-border-color), var(--v-border-opacity));
}
.sidebar.is-overlay {
  position: absolute;
  z-index: 20;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(320px, 86%);
  transform: translateX(-100%);
  background: rgb(var(--v-theme-surface));
  box-shadow: 0 0 32px rgba(0, 0, 0, 0.3);
  transition: transform 0.22s ease;
}
.sidebar.is-overlay.is-open {
  transform: translateX(0);
}
.scrim {
  position: absolute;
  inset: 0;
  z-index: 19;
  background: rgba(0, 0, 0, 0.35);
}

/* ---- 主列 ---- */
.main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.topbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 60px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.35));
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
}
.title-block {
  flex: 1 1 auto;
  min-width: 0;
  padding-left: 4px;
}
.assistant-name {
  font-weight: 700;
  font-size: 1.05rem;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.session-title {
  font-size: 0.8rem;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 300px;
  min-width: 0;
  min-height: 40px;
  padding: 4px 8px 4px 12px;
  border-radius: 12px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-on-surface), 0.03);
  color: inherit;
  cursor: pointer;
  transition: background 0.15s;
}
.model-btn:hover {
  background: rgba(var(--v-theme-primary), 0.1);
}
.model-text {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  line-height: 1.25;
}
.model-name {
  font-size: 0.85rem;
  font-weight: 600;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.provider-name {
  font-size: 0.7rem;
  opacity: 0.65;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.run-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: rgba(var(--v-theme-on-surface), 0.25);
}
.run-dot.is-running {
  background: rgb(var(--v-theme-success));
  animation: yaya-pulse 1.2s ease-in-out infinite;
}
@keyframes yaya-pulse {
  50% {
    opacity: 0.35;
  }
}

/* ---- 消息区 ---- */
.scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  scroll-behavior: auto;
}
.thread {
  max-width: 820px;
  margin: 0 auto;
  padding: 24px 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.loading {
  display: flex;
  justify-content: center;
  padding: 64px 0;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 8vh 0 24px;
}
.empty-avatar {
  width: 64px;
  height: 64px;
  border-radius: 20px;
  display: grid;
  place-items: center;
  background: rgba(var(--v-theme-primary), 0.14);
  color: rgb(var(--v-theme-primary));
  margin-bottom: 16px;
}
.empty-title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0 0 8px;
}
.empty-sub {
  max-width: 460px;
  margin: 0 0 28px;
  font-size: 0.9rem;
  line-height: 1.6;
}
.suggestions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  width: 100%;
  max-width: 600px;
}
.suggestion {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 56px;
  padding: 12px 16px;
  border-radius: 14px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.5));
  color: inherit;
  text-align: left;
  font-size: 0.875rem;
  line-height: 1.45;
  cursor: pointer;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.suggestion:hover {
  background: rgba(var(--v-theme-primary), 0.08);
  border-color: rgba(var(--v-theme-primary), 0.4);
}

/* ---- 输入区 ---- */
.composer {
  flex-shrink: 0;
  position: relative;
  padding: 8px 24px 16px;
}
.jump-btn {
  position: absolute;
  top: -52px;
  right: 24px;
  z-index: 2;
}
/* 展开编辑：输入区盖住消息区下方大部分，顶栏仍可见 */
.composer.is-expanded {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  top: max(76px, 22%);
  z-index: 6;
  display: flex;
  flex-direction: column;
  background: linear-gradient(
    to bottom,
    rgba(var(--v-theme-surface), 0) 0,
    rgba(var(--v-theme-surface), 0.55) 32px
  );
}
.composer.is-expanded > :last-child {
  flex: 1 1 auto;
  min-height: 0;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 820px;
  margin: 0 auto 8px;
  padding: 8px 8px 8px 14px;
  border-radius: 10px;
  font-size: 0.85rem;
  background: rgba(var(--v-theme-info), 0.12);
  border: 1px solid rgba(var(--v-theme-info), 0.3);
  word-break: break-word;
}
.notice > span {
  flex: 1 1 auto;
  min-width: 0;
}
.notice.is-error {
  background: rgba(var(--v-theme-error), 0.1);
  border-color: rgba(var(--v-theme-error), 0.3);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ---- 窄屏（手机） ---- */
@media (max-width: 720px) {
  .topbar {
    min-height: 56px;
    padding: 6px 8px;
    gap: 4px;
  }
  .model-btn {
    max-width: 44%;
    padding-left: 10px;
  }
  .provider-name {
    display: none;
  }
  .thread {
    padding: 16px 12px 12px;
    gap: 20px;
  }
  .composer {
    padding: 6px 8px 10px;
  }
  .composer.is-expanded {
    top: 64px;
  }
  .jump-btn {
    right: 12px;
  }
  .suggestions {
    grid-template-columns: minmax(0, 1fr);
  }
  .empty {
    padding-top: 4vh;
  }
}
</style>
