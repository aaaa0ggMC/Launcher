<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import type { Session, MessageNode, MessageAttachment, YayaConfig } from './types'
import type { WorkflowSnapshot } from './services/loop/types'
import ChatSessionList from './components/ChatSessionList.vue'
import ChatMessageItem from './components/ChatMessageItem.vue'
import ChatInputBox from './components/ChatInputBox.vue'
import ModelSelectDialog from './components/ModelSelectDialog.vue'

defineOptions({ name: 'cockpit-yaya-view' })

const sessions = ref<Session[]>([])
const activeSessionId = ref<string | null>(null)
const messages = ref<MessageNode[]>([])
const isRunning = ref(false)
const drawer = ref(false)
const activeModelName = ref('gpt-5.5')
const activeProviderId = ref<string>('')
const yayaConfig = ref<YayaConfig | null>(null)
const showModelSelect = ref(false)
const scrollContainer = ref<HTMLElement | null>(null)

// 移除监听的回调收集
const unsubs: (() => void)[] = []

async function loadSessions(): Promise<void> {
  try {
    const list = (await window.cockpit.command('yaya.sessions', {
      activeSession: activeSessionId.value || undefined
    })) as Session[]
    sessions.value = list
    if (!activeSessionId.value && list.length > 0) {
      await selectSession(list[0].id)
    } else if (list.length === 0) {
      await createNewSession()
    }
  } catch (e) {
    console.error('Failed to load sessions', e)
  }
}

async function selectSession(id: string): Promise<void> {
  // 如果离开前一个会话且该会话 0 消息，且与目标会话不同，清理旧的无聊空会话
  if (activeSessionId.value && activeSessionId.value !== id && messages.value.length === 0) {
    const prevId = activeSessionId.value
    sessions.value = sessions.value.filter((s) => s.id !== prevId)
    window.cockpit.command('yaya.session-delete', { id: prevId }).catch(() => {})
  }

  activeSessionId.value = id
  drawer.value = false // 选中后收起抽屉
  const current = sessions.value.find((s) => s.id === id)
  if (current?.model) {
    activeModelName.value = current.model
    if (current.providerId) activeProviderId.value = current.providerId
  } else if (yayaConfig.value?.activeModel) {
    activeModelName.value = yayaConfig.value.activeModel
    if (yayaConfig.value.activeProviderId) {
      activeProviderId.value = yayaConfig.value.activeProviderId
    }
  }
  await loadMessages()
  await checkWorkflowStatus()
}

async function createNewSession(): Promise<void> {
  // 如果当前已有空白会话（尚未发送任何消息），直接复用，不重复生成幽灵会话
  if (messages.value.length === 0 && activeSessionId.value) {
    drawer.value = false
    return
  }
  try {
    const s = (await window.cockpit.command('yaya.session-create', {
      title: '新对话',
      model: activeModelName.value,
      provider: activeProviderId.value || undefined
    })) as Session
    sessions.value.unshift(s)
    await selectSession(s.id)
  } catch (e) {
    console.error('Failed to create session', e)
  }
}

async function deleteSession(id: string): Promise<void> {
  try {
    await window.cockpit.command('yaya.session-delete', { id })
    sessions.value = sessions.value.filter((s) => s.id !== id)
    if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value.length > 0 ? sessions.value[0].id : null
      if (activeSessionId.value) {
        await selectSession(activeSessionId.value)
      } else {
        messages.value = []
        await createNewSession()
      }
    }
  } catch (e) {
    console.error('Failed to delete session', e)
  }
}

async function loadMessages(): Promise<void> {
  if (!activeSessionId.value) return
  try {
    const branch = (await window.cockpit.command('yaya.messages-branch', {
      session: activeSessionId.value
    })) as MessageNode[]
    messages.value = branch
    await scrollToBottom()
  } catch (e) {
    console.error('Failed to load messages', e)
  }
}

async function checkWorkflowStatus(): Promise<void> {
  if (!activeSessionId.value) return
  try {
    const snap = (await window.cockpit.command('yaya.workflow-snapshot', {
      session: activeSessionId.value
    })) as WorkflowSnapshot | null
    if (snap) {
      isRunning.value = snap.status === 'streaming' || snap.status === 'tool_executing'
    } else {
      isRunning.value = false
    }
  } catch {
    isRunning.value = false
  }
}

async function handleSend(
  prompt: string,
  attachments: MessageAttachment[],
  parentMessageId?: string | null
): Promise<void> {
  if (!activeSessionId.value) return
  isRunning.value = true

  // 若当前是会话的第一条消息，自动根据输入提炼标题更新会话
  const isFirstMessage = messages.value.length === 0
  if (isFirstMessage && prompt.trim()) {
    const autoTitle = prompt.trim().slice(0, 24)
    window.cockpit
      .command('yaya.session-update', {
        id: activeSessionId.value,
        title: autoTitle
      })
      .then(() => {
        const s = sessions.value.find((item) => item.id === activeSessionId.value)
        if (s) s.title = autoTitle
      })
      .catch(() => {})
  }

  try {
    const cleanAttachments = attachments ? JSON.parse(JSON.stringify(attachments)) : []
    await window.cockpit.command('yaya.workflow-start', {
      session: activeSessionId.value,
      prompt,
      attachments: cleanAttachments,
      parent: parentMessageId ?? null
    })
    await loadMessages()
  } catch (e) {
    console.error('Failed to start workflow', e)
    isRunning.value = false
  }
}

async function handleRetry(failedMsg: MessageNode): Promise<void> {
  if (!activeSessionId.value) return
  let prompt = ''
  let attachments: MessageAttachment[] = []
  let parentId: string | null | undefined = failedMsg.parentId

  if (failedMsg.role === 'assistant' && failedMsg.parentId) {
    const userMsg = messages.value.find((m) => m.id === failedMsg.parentId)
    if (userMsg) {
      prompt = userMsg.content
      attachments = userMsg.attachments || []
      parentId = userMsg.parentId
    }
  }

  if (prompt) {
    await handleSend(prompt, attachments, parentId)
  } else {
    await handleSend('', [])
  }
}

async function handleAbort(): Promise<void> {
  if (!activeSessionId.value) return
  try {
    await window.cockpit.command('yaya.workflow-abort', {
      session: activeSessionId.value
    })
    isRunning.value = false
  } catch (e) {
    console.error('Failed to abort workflow', e)
  }
}

async function handleApprove(approved: boolean): Promise<void> {
  if (!activeSessionId.value) return
  try {
    await window.cockpit.command('yaya.workflow-approve', {
      session: activeSessionId.value,
      approved
    })
  } catch (e) {
    console.error('Failed to approve tool', e)
  }
}

async function handleSwitchBranch(targetLeafId: string): Promise<void> {
  if (!activeSessionId.value) return
  try {
    await window.cockpit.command('yaya.session-switch-leaf', {
      session: activeSessionId.value,
      leaf: targetLeafId
    })
    await loadMessages()
  } catch (e) {
    console.error('Failed to switch branch', e)
  }
}

async function handleImportOpenAi(jsonText: string): Promise<void> {
  try {
    await window.cockpit.command('yaya.import-openai', {
      jsonContent: jsonText
    })
    await loadSessions()
  } catch (e) {
    console.error('Failed to import OpenAI conversations', e)
  }
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  if (scrollContainer.value) {
    scrollContainer.value.scrollTop = scrollContainer.value.scrollHeight
  }
}

const currentSessionTitle = ref('')
watch(
  [activeSessionId, sessions],
  () => {
    const curr = sessions.value.find((s) => s.id === activeSessionId.value)
    currentSessionTitle.value = curr?.title || 'YAYA 智能助手'
  },
  { immediate: true }
)

async function loadConfig(): Promise<void> {
  try {
    const cfg = (await window.cockpit.command('yaya.config-get')) as YayaConfig
    yayaConfig.value = cfg
    if (cfg?.activeModel) {
      activeModelName.value = cfg.activeModel
    }
    if (cfg?.activeProviderId) {
      activeProviderId.value = cfg.activeProviderId
    }
  } catch {
    /* noop */
  }
}

async function handleModelSelect(payload: { model: string; providerId: string }): Promise<void> {
  const { model, providerId } = payload
  activeModelName.value = model
  activeProviderId.value = providerId

  // 1. 同步更新当前会话的 model & provider
  if (activeSessionId.value) {
    try {
      await window.cockpit.command('yaya.session-update', {
        id: activeSessionId.value,
        model,
        provider: providerId
      })
      const s = sessions.value.find((item) => item.id === activeSessionId.value)
      if (s) {
        s.model = model
        s.providerId = providerId
      }
    } catch (e) {
      console.error('Failed to update session model', e)
    }
  }

  // 2. 同时更新全局默认配置
  if (yayaConfig.value) {
    try {
      yayaConfig.value.activeModel = model
      yayaConfig.value.activeProviderId = providerId
      const rawConfig = JSON.parse(JSON.stringify(yayaConfig.value))
      await window.cockpit.command('yaya.config-save', {
        config: rawConfig
      })
    } catch (e) {
      console.error('Failed to update global active model', e)
    }
  }
}

async function handleAddCustomModel(payload: { model: string; providerId: string }): Promise<void> {
  const { model, providerId } = payload
  if (!yayaConfig.value) return
  const provider = yayaConfig.value.providers.find((p) => p.id === providerId)
  if (provider && !provider.models.includes(model)) {
    provider.models.push(model)
    try {
      const rawConfig = JSON.parse(JSON.stringify(yayaConfig.value))
      await window.cockpit.command('yaya.config-save', {
        config: rawConfig
      })
    } catch (e) {
      console.error('Failed to save custom model to provider', e)
    }
  }
}

onMounted(async () => {
  await loadConfig()
  await loadSessions()

  // 监听 Token 流
  unsubs.push(
    window.cockpit.on('cockpit:yaya-token', (payload: unknown) => {
      const p = payload as { sessionId: string; messageId: string; token: string }
      if (p.sessionId !== activeSessionId.value) return
      const target = messages.value.find((m) => m.id === p.messageId)
      if (target) {
        target.content += p.token
        scrollToBottom()
      } else {
        loadMessages()
      }
    })
  )

  // 监听推理过程
  unsubs.push(
    window.cockpit.on('cockpit:yaya-reasoning', (payload: unknown) => {
      const p = payload as { sessionId: string; messageId: string; reasoning: string }
      if (p.sessionId !== activeSessionId.value) return
      const target = messages.value.find((m) => m.id === p.messageId)
      if (target) {
        target.reasoningContent = (target.reasoningContent || '') + p.reasoning
        scrollToBottom()
      }
    })
  )

  // 监听工作流快照状态
  unsubs.push(
    window.cockpit.on('cockpit:yaya-loop', (snap: unknown) => {
      const s = snap as WorkflowSnapshot
      if (s.sessionId !== activeSessionId.value) return
      isRunning.value = s.status === 'streaming' || s.status === 'tool_executing'
      loadMessages()
    })
  )
})

onBeforeUnmount(() => {
  for (const unsub of unsubs) unsub()
})
</script>

<template>
  <div class="yaya-shell d-flex flex-column h-100 position-relative">
    <!-- 顶部玻璃状态栏 (仿 AIDJ 极简设计) -->
    <div class="yaya-topbar px-4 py-2 border-b flex-shrink-0">
      <div class="d-flex align-center justify-space-between w-100">
        <!-- 左侧：历史会话抽屉开关 + 当前标题 + 新建 -->
        <div class="d-flex align-center ga-1 min-w-0">
          <!-- 会话记录：小屏折叠为纯图标，大屏带文字 -->
          <v-btn
            variant="text"
            density="comfortable"
            icon="mdi-history"
            class="topbar-btn flex-shrink-0 d-sm-none"
            aria-label="会话记录"
            :title="'会话记录'"
            @click="drawer = !drawer"
          />
          <v-btn
            variant="text"
            density="comfortable"
            prepend-icon="mdi-history"
            class="topbar-btn flex-shrink-0 d-none d-sm-inline-flex"
            @click="drawer = !drawer"
          >
            会话记录
          </v-btn>

          <!-- 新建：小屏折叠为纯图标，大屏带文字 -->
          <v-btn
            variant="text"
            density="comfortable"
            icon="mdi-plus"
            class="topbar-btn flex-shrink-0 d-sm-none"
            aria-label="新建对话"
            :title="'新建对话'"
            @click="createNewSession"
          />
          <v-btn
            variant="text"
            density="comfortable"
            prepend-icon="mdi-plus"
            class="topbar-btn flex-shrink-0 d-none d-sm-inline-flex"
            @click="createNewSession"
          >
            新建
          </v-btn>

          <!-- 会话标题：仅在中等及以上屏幕展示，防止移动端横向挤压 -->
          <v-divider vertical class="mx-1 my-1 flex-shrink-0 d-none d-sm-block" />
          <div class="d-none d-sm-flex align-center min-w-0">
            <v-icon
              icon="mdi-chat-outline"
              size="16"
              class="text-medium-emphasis flex-shrink-0 mr-1"
            />
            <span class="text-body-2 font-weight-medium text-truncate" :title="currentSessionTitle">
              {{ currentSessionTitle }}
            </span>
          </div>
        </div>

        <!-- 右侧：当前模型 (无生硬边框，点击打开弹窗选择) + 运行状态 -->
        <div class="d-flex align-center ga-2 flex-shrink-0 ml-2">
          <v-chip
            variant="text"
            class="model-chip cursor-pointer"
            prepend-icon="mdi-robot-outline"
            append-icon="mdi-chevron-down"
            :title="'点击选择大模型 (当前: ' + activeModelName + ')'"
            @click="showModelSelect = true"
          >
            <span class="text-truncate model-name-text">{{ activeModelName }}</span>
          </v-chip>

          <v-chip v-if="isRunning" color="primary" variant="flat" class="status-chip">
            <v-progress-circular indeterminate size="12" width="2" class="mr-1" />
            <span>运行中</span>
          </v-chip>
        </div>
      </div>
    </div>

    <!-- 左侧弹出式会话抽屉 (移动端与桌面端均采用覆盖式临时抽屉，不挤压主聊天流) -->
    <v-navigation-drawer
      v-model="drawer"
      temporary
      location="left"
      width="320"
      class="yaya-sessions-drawer"
    >
      <ChatSessionList
        :sessions="sessions"
        :active-session-id="activeSessionId"
        @select-session="selectSession"
        @create-session="createNewSession"
        @delete-session="deleteSession"
        @import-open-ai="handleImportOpenAi"
      />
    </v-navigation-drawer>

    <!-- 消息列表滚动区 (居中自适应，最大宽度限制) -->
    <div ref="scrollContainer" class="messages-scroll-area flex-grow-1 overflow-y-auto px-4 py-4">
      <div class="messages-container mx-auto">
        <!-- 空状态提示 -->
        <div
          v-if="messages.length === 0"
          class="empty-state d-flex flex-column align-center justify-center py-16 text-center"
        >
          <v-icon
            icon="mdi-robot-outline"
            size="56"
            color="primary"
            class="mb-3 empty-robot-icon"
          />
          <div class="text-h6 font-weight-bold mb-1">与 YAYA 开始对话</div>
          <div class="text-body-2 text-medium-emphasis max-w-sm mb-6">
            你的私人智能体中枢 — 支持深度推理、工具调度与无头恢复
          </div>

          <!-- 快捷提示词建议 (使用单色 MDI 图标，无彩色裸 emoji，默认密度+显式内边距) -->
          <div class="d-flex flex-wrap ga-2 justify-center max-w-sm">
            <v-chip
              variant="outlined"
              prepend-icon="mdi-monitor-dashboard"
              class="prompt-chip"
              @click="handleSend('查询当前系统的硬件与状态信息', [])"
            >
              查询系统硬件状态
            </v-chip>
            <v-chip
              variant="outlined"
              prepend-icon="mdi-console-line"
              class="prompt-chip"
              @click="handleSend('列出当前支持的 Cockpit 系统命令', [])"
            >
              列出 Cockpit 系统命令
            </v-chip>
            <v-chip
              variant="outlined"
              prepend-icon="mdi-script-text-outline"
              class="prompt-chip"
              @click="handleSend('帮我写一个快速清理系统垃圾文件的脚本', [])"
            >
              编写系统清理脚本
            </v-chip>
          </div>
        </div>

        <!-- 消息流 -->
        <ChatMessageItem
          v-for="msg in messages"
          :key="msg.id"
          :message="msg"
          :session-id="activeSessionId || ''"
          @switch-branch="handleSwitchBranch"
          @approve-tool="handleApprove"
          @resume-workflow="() => handleRetry(msg)"
        />
      </div>
    </div>

    <!-- 底部药丸型输入条 -->
    <ChatInputBox
      :is-running="isRunning"
      :session-id="activeSessionId || ''"
      @send="handleSend"
      @abort="handleAbort"
    />

    <!-- 大模型选择弹窗 (支持全局搜索与多 Provider 独立搜索) -->
    <ModelSelectDialog
      v-model="showModelSelect"
      :current-model="activeModelName"
      :current-provider-id="activeProviderId"
      :config="yayaConfig"
      @select="handleModelSelect"
      @add-custom-model="handleAddCustomModel"
    />
  </div>
</template>

<style scoped>
.yaya-shell {
  /* 严格遵循 DESIGN.md §4.6 规范：定高与视口高度对齐（--app-vh - 96px），外壳不产生空滚动条；
     顶部工具栏与底部输入条固定在视口顶底，仅中间消息列表区滚动 */
  height: calc(var(--app-vh) - 96px);
  max-height: calc(var(--app-vh) - 96px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
  background: transparent;
}

.yaya-topbar {
  flex-shrink: 0;
  z-index: 5;
  background: rgba(var(--v-theme-surface), 0.75);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border-bottom: 1px solid rgba(var(--v-theme-surface-bright), 0.2) !important;
}

.topbar-btn {
  border-radius: 8px;
  border: none !important;
  transition: background 0.15s ease;
}

.topbar-btn:hover {
  background: rgba(var(--v-theme-surface-variant), 0.5) !important;
}

.model-chip {
  padding-block: 4px;
  min-height: 24px;
  border-radius: 8px;
  background: rgba(var(--v-theme-surface-variant), 0.35);
  border: none !important;
  cursor: pointer;
  transition: all 0.15s ease;
}

.model-chip:hover {
  background: rgba(var(--v-theme-primary), 0.15);
  color: rgb(var(--v-theme-primary));
}

.model-name-text {
  max-width: 140px;
}

.cursor-pointer {
  cursor: pointer;
}

.status-chip {
  padding-block: 4px;
  min-height: 24px;
}

.messages-scroll-area {
  scroll-behavior: smooth;
}

.messages-container {
  max-width: 840px;
}

.empty-robot-icon {
  opacity: 0.9;
}

.max-w-sm {
  max-width: 420px;
}

.prompt-chip {
  padding-block: 4px;
  min-height: 26px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.prompt-chip:hover {
  background: rgba(var(--v-theme-primary), 0.12);
  border-color: rgb(var(--v-theme-primary));
}

.min-w-0 {
  min-width: 0;
}

@media (max-width: 720px) {
  .messages-scroll-area {
    padding-inline: 8px !important;
  }
}
</style>
