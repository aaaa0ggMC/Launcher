<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onMounted,
  ref,
  watch
} from 'vue'
import { useI18n } from '../../main/ui/i18n'
import { useSettings } from '../../main/ui/composables/settings'
import { DrawerSwipe } from '../../main/ui/composables/drawer-swipe'
import { copyExportText, pickExportTarget } from '../../main/ui/composables/export'
import './components/pop.css'
import type {
  Session,
  MessageNode,
  ApprovalScope,
  MessageAttachment,
  ReasoningEffort,
  YayaAssistant,
  YayaConfig,
  WorkflowInfo
} from './types'
import type { WorkflowSnapshot } from './services/loop/types'
import { buildTurnsReusing, mergeNodes, type Turn } from './components/turns'
import ChatSessionList from './components/ChatSessionList.vue'
import TtsPlayer from './plugins/speech/TtsPlayer.vue'
import { tts } from './plugins/speech/player'
import UserMessage from './components/UserMessage.vue'
import AssistantTurn from './components/AssistantTurn.vue'
import ChatInputBox from './components/ChatInputBox.vue'
import ModelSelectDialog from './components/ModelSelectDialog.vue'
import MessageMenu from './components/MessageMenu.vue'
import UsageDialog from './components/UsageDialog.vue'
import ConversationTree from './components/tree/ConversationTree.vue'
import SelectTextDialog from './components/SelectTextDialog.vue'
import type { TreeTurn } from './types'
import type { ContextState } from './services/context'
import ContextMarker from './components/ContextMarker.vue'
import AvatarBadge from './components/AvatarBadge.vue'
import { modelMonogram } from './profile'
import { ensurePluginMap, setPluginAssistant } from './components/plugin-ui-registry'
import {
  assistantConfig,
  DEFAULT_ASSISTANT_ID,
  findAssistant,
  sessionAssistantId,
  sessionOwnerId
} from './assistants'
import type { MessageMenuItem, MessageMenuRequest } from './components/message-menu'

defineOptions({ name: 'cockpit-yaya-view' })

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)
const settings = useSettings()

/** 原始配置（含助手列表）；页面读的 `config` 是当前会话的助手叠加后的生效配置 */
const rawConfig = ref<YayaConfig | null>(null)
const sessions = ref<Session[]>([])
/** null = 新对话草稿（首次发送 / 添加附件时才真正创建会话，避免空会话堆积） */
const activeSessionId = ref<string | null>(null)
const messages = ref<MessageNode[]>([])
const runningIds = ref<string[]>([])
const snapshot = ref<WorkflowSnapshot | null>(null)
const draft = ref('')
const showModelSelect = ref(false)
const showUsage = ref(false)
const showTree = ref(false)
/** 「选择文字」弹窗（手机上长按被菜单占用，在这里自由选择一段复制） */
const selectText = ref<{ text: string; fullText?: string } | null>(null)
const loadingMessages = ref(false)
const notice = ref<{ text: string; error?: boolean } | null>(null)
const workflows = ref<WorkflowInfo[]>([])
/** 新对话草稿里选的工作流（会话创建时带上） */
const draftWorkflow = ref<string | null>(null)
const draftReasoning = ref<ReasoningEffort | null>(null)
const composerExpanded = ref(false)
const menuRequest = ref<MessageMenuRequest | null>(null)
/** 正在编辑的已发送消息：内容载入底部输入框，发送时从它的父节点开新分支 */
const editTarget = ref<MessageNode | null>(null)
const pendingDelete = ref<{ messageId: string; kind: 'user' | 'assistant' } | null>(null)

const shellEl = ref<HTMLElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)
const inputRef = ref<{
  focus: () => void
  acceptShare: (share: { paths?: string[]; text?: string; error?: string }) => Promise<void>
  loadForEdit: (message: {
    text: string
    attachments: MessageAttachment[]
    mentions: { ref: string; label: string; kind: string }[]
  }) => void
} | null>(null)

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

// ---- 窄屏弹出侧栏：单指向左划收回（与外壳侧栏同一套手势判定，竖向滚动不受影响） ----
const drawerSwipe = new DrawerSwipe()
const drawerDragX = ref(0)
const drawerDragging = ref(false)
const drawerWidth = ref(1)
let drawerBlockClick = false

function resetDrawerSwipe(): void {
  drawerSwipe.reset()
  drawerDragX.value = 0
  drawerDragging.value = false
}

function onDrawerPointerDown(e: PointerEvent): void {
  if (wide.value || !drawerOpen.value || e.button !== 0) return
  if ((e.target as Element).closest('input, textarea, [contenteditable="true"]')) return
  drawerBlockClick = false
  const el = e.currentTarget as HTMLElement
  const width = el.getBoundingClientRect().width
  drawerWidth.value = el.offsetWidth || 1
  drawerSwipe.down(e.pointerId, e.clientX, e.clientY, width, e.timeStamp)
  drawerDragging.value = false
  drawerDragX.value = 0
}

function onDrawerPointerMove(e: PointerEvent): void {
  const state = drawerSwipe.move(e.pointerId, e.clientX, e.clientY)
  if (!state) return
  const el = e.currentTarget as HTMLElement
  const width = el.getBoundingClientRect().width
  // 页面可能被缩放：屏幕位移换回元素自身坐标
  const scale = width > 0 ? el.offsetWidth / width : 1
  drawerDragging.value = state.dragging
  drawerDragX.value = state.offset * scale
  if (state.dragging) {
    drawerBlockClick = true
    e.preventDefault()
    if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId)
  }
}

function onDrawerPointerEnd(e: PointerEvent): void {
  // 子元素被夺走捕获时也会冒泡一个 lostpointercapture，我们自己的捕获还在
  if (e.type === 'lostpointercapture' && e.target !== e.currentTarget) return
  const result = drawerSwipe.end(e.pointerId, e.timeStamp, e.type !== 'pointerup')
  drawerDragging.value = false
  drawerDragX.value = 0
  if (result.close) drawerOpen.value = false
}

/** 划过之后吞掉随后的 click，免得松手时点开了手指下的会话 */
function onDrawerClick(e: MouseEvent): void {
  if (!drawerBlockClick || e.detail === 0) return
  drawerBlockClick = false
  e.preventDefault()
  e.stopImmediatePropagation()
}

const drawerStyle = computed(() =>
  drawerDragging.value
    ? { transform: `translateX(${drawerDragX.value}px)`, transition: 'none' }
    : undefined
)
/** 遮罩跟着手指变淡 */
const scrimStyle = computed(() =>
  drawerDragging.value
    ? {
        opacity: String(Math.max(0, 1 + drawerDragX.value / drawerWidth.value)),
        transition: 'none'
      }
    : undefined
)

watch([drawerOpen, wide], resetDrawerSwipe)

// ---- 派生状态 ----
const activeSession = computed(() => sessions.value.find((s) => s.id === activeSessionId.value))
/** 当前会话的助手；新对话 = 活动助手 */
const currentAssistantId = computed(() =>
  activeSession.value
    ? sessionAssistantId(activeSession.value)
    : rawConfig.value?.activeAssistantId || DEFAULT_ASSISTANT_ID
)
const currentAssistant = computed(() =>
  rawConfig.value ? findAssistant(rawConfig.value, currentAssistantId.value) : undefined
)
const config = computed<YayaConfig | null>(() =>
  rawConfig.value ? assistantConfig(rawConfig.value, currentAssistantId.value) : null
)
const assistantName = computed(() => config.value?.assistantName?.trim() || 'YAYA')

// ---- 会话列表按助手过滤：默认只列当前助手的会话，开关打开后列出全部助手的 ----
const ALL_ASSISTANTS_KEY = 'yaya-sessions-all-assistants'
function readAllAssistants(): boolean {
  try {
    return localStorage.getItem(ALL_ASSISTANTS_KEY) === '1'
  } catch {
    return false
  }
}
const showAllAssistants = ref(readAllAssistants())
function toggleAllAssistants(): void {
  showAllAssistants.value = !showAllAssistants.value
  try {
    localStorage.setItem(ALL_ASSISTANTS_KEY, showAllAssistants.value ? '1' : '0')
  } catch {
    /* 存不了就只在本次生效 */
  }
}
const multiAssistant = computed(() => (rawConfig.value?.assistants?.length ?? 0) > 1)
/** 过滤用的助手 id（被删的助手已退回第一个，与会话归属同一口径） */
const filterAssistantId = computed(() =>
  rawConfig.value ? (findAssistant(rawConfig.value, currentAssistantId.value)?.id ?? null) : null
)
// 插件开关按助手生效：朗读按钮、输入框扩展等界面门控跟着当前会话的助手走
watch(filterAssistantId, (id) => setPluginAssistant(id), { immediate: true })
const visibleSessions = computed(() => {
  const cfg = rawConfig.value
  if (!cfg || !multiAssistant.value || showAllAssistants.value) return sessions.value
  return sessions.value.filter((s) => sessionOwnerId(cfg, s) === filterAssistantId.value)
})
/** 列出全部助手时，每个会话条目标上所属助手名 */
const sessionAssistantNames = computed<Record<string, string>>(() => {
  const cfg = rawConfig.value
  if (!cfg || !multiAssistant.value || !showAllAssistants.value) return {}
  const out: Record<string, string> = {}
  for (const s of sessions.value) {
    out[s.id] = findAssistant(cfg, sessionOwnerId(cfg, s))?.assistantName?.trim() || 'YAYA'
  }
  return out
})

// 外壳 App bar 标题 / 侧栏条目跟随助手名（默认名就恢复能力原名）
const setShellTitle = inject<(id: string, title: string | null) => void>(
  'cockpit:set-title',
  () => {}
)
watch(assistantName, (name) => setShellTitle('yaya', name === 'YAYA' ? null : name))
/** 上下文管理的切点（设置里关掉时不显示） */
const contextBoundary = computed<ContextState | null>(() => {
  if (!config.value?.context?.mode || config.value.context.mode === 'off') return null
  const st = (activeSession.value?.meta as { context?: ContextState } | undefined)?.context
  return st?.boundaryId ? st : null
})
async function resetContext(): Promise<void> {
  const id = activeSessionId.value
  if (!id) return
  try {
    await window.cockpit.command('yaya.context-reset', { session: id })
  } catch (e) {
    console.warn('[yaya] context reset failed', e)
  }
}
const isRunning = computed(
  () => !!activeSessionId.value && runningIds.value.includes(activeSessionId.value)
)
// 复用未变化的轮次对象：刷新时只有真正变化的轮次重渲染
let prevTurns: Turn[] = []
const turns = computed(() => (prevTurns = buildTurnsReusing(messages.value, prevTurns)))
const lastTurnKey = computed(() => turns.value[turns.value.length - 1]?.key)
/** 用户在标题栏头像上暂停了本会话的运行 */
const isPaused = computed(() => isRunning.value && snapshot.value?.status === 'paused')
/** 模型请求出错、等待自动重试：倒计时每半秒刷新一次（只在有重试时跑） */
const retry = computed(() => (isRunning.value ? (snapshot.value?.retry ?? null) : null))
const retryNow = ref(Date.now())
let retryTicker = 0
watch(
  retry,
  (r) => {
    window.clearInterval(retryTicker)
    retryTicker = 0
    retryNow.value = Date.now()
    if (r) retryTicker = window.setInterval(() => (retryNow.value = Date.now()), 500)
  },
  { immediate: true }
)
const retryText = computed(() => {
  const r = retry.value
  if (!r) return ''
  const left = Math.ceil((r.at - retryNow.value) / 1000)
  const vars = { n: String(r.attempt), max: String(r.max), s: String(left) }
  return left > 0
    ? te('yaya.retry_wait', vars, '请求出错，{s} 秒后自动重试（{n}/{max}）')
    : te('yaya.retry_now', vars, '正在重试（{n}/{max}）…')
})
async function controlRun(action: 'pause' | 'resume' | 'stop'): Promise<void> {
  if (!activeSessionId.value) return
  const session = activeSessionId.value
  if (action === 'stop') await window.cockpit.command('yaya.workflow-abort', { session })
  else await window.cockpit.command('yaya.workflow-control', { session, action })
}

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

/** 过程卡片收起时预览的步数（设置项「收起时显示最近几步」，0 = 完全折叠） */
const processPreviewSteps = computed(() => {
  const v = config.value?.processPreviewSteps
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(5, Math.max(0, Math.round(v))) : 1
})

/**
 * 当前会话的工作流：会话自己的选择 → 草稿选择 → 助手的默认 → 全局默认 → agent。
 * 列表已加载时跳过不可用的（插件工作流的插件被关了），与运行时的回落一致。
 */
const currentWorkflowId = computed({
  get: () => {
    const chain = [
      activeSession.value?.meta?.workflow as string | undefined,
      draftWorkflow.value,
      config.value?.defaultWorkflow,
      rawConfig.value?.defaultWorkflow,
      'agent'
    ].filter((x): x is string => !!x)
    if (!workflows.value.length) return chain[0]
    return chain.find((id) => workflows.value.some((w) => w.id === id)) ?? 'agent'
  },
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

/** 当前会话的思考强度：会话自己的选择 → 草稿选择 → 设置里的默认 → default（不发参数） */
const currentReasoning = computed<ReasoningEffort>({
  get: () =>
    (activeSession.value?.meta?.reasoning as ReasoningEffort | undefined) ||
    draftReasoning.value ||
    config.value?.reasoningEffort ||
    'default',
  set: (v: ReasoningEffort) => {
    const s = activeSession.value
    if (!s) {
      draftReasoning.value = v
      return
    }
    s.meta = { ...(s.meta ?? {}), reasoning: v }
    window.cockpit.command('yaya.session-update', { id: s.id, reasoning: v }).catch((e) => {
      showNotice(errText(e), true)
    })
  }
})

// ---- 滚动：贴底时跟随，用户上翻后不打扰 ----
// 按「方向」判断用户意图，而不是按离底部的距离：流式输出时每帧都在把视图拉回底部，
// 手指刚往上拖几十像素（还在 80px 阈值内）就会被下一帧拉回去，永远翻不上去。
const stickToBottom = ref(true)
let lastScrollTop = 0
function onScroll(): void {
  const el = scrollEl.value
  if (!el) return
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight
  if (dist < 4) stickToBottom.value = true
  else if (el.scrollTop < lastScrollTop - 1) stickToBottom.value = false
  else if (dist < 80 && el.scrollTop > lastScrollTop) stickToBottom.value = true
  lastScrollTop = el.scrollTop
  if (el.scrollTop < 400) void loadOlder()
}
/** 鼠标滚轮向上：立即停止跟随（内容还不够长、不会触发 scroll 时也生效） */
function onWheel(ev: WheelEvent): void {
  if (ev.deltaY < 0) stickToBottom.value = false
}
let scrollFrame = 0
async function scrollToBottom(force = false): Promise<void> {
  if (force) stickToBottom.value = true
  await nextTick()
  if (scrollFrame) return
  // 同一帧里的多次请求（每个 token 一次）合并成一次布局
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0
    const el = scrollEl.value
    if (el && stickToBottom.value) {
      el.scrollTop = el.scrollHeight
      lastScrollTop = el.scrollTop
    }
  })
}

// ---- 数据加载 ----
async function loadConfig(): Promise<void> {
  try {
    rawConfig.value = (await window.cockpit.command('yaya.config-get')) as YayaConfig
  } catch (e) {
    console.error('[yaya] load config failed', e)
  }
}

/** 工作流列表按当前助手过滤（插件注入的工作流只在插件对这个助手启用时出现） */
let workflowsSeq = 0
async function loadWorkflows(): Promise<void> {
  const seq = ++workflowsSeq
  try {
    const list = (await window.cockpit.command('yaya.workflows-list', {
      assistant: currentAssistantId.value
    })) as WorkflowInfo[]
    if (seq === workflowsSeq) workflows.value = list
  } catch {
    if (seq === workflowsSeq) workflows.value = []
  }
}
watch(currentAssistantId, () => void loadWorkflows())

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

// ---- 长会话滑动窗口：只加载最后若干轮，滚到顶部再往前加载 ----
/** 首次加载 / 向上翻页的轮数（按用户消息计） */
const WINDOW_TURNS = 20
const hasMore = ref(false)
const loadingOlder = ref(false)

interface BranchWindow {
  messages: MessageNode[]
  hasMore: boolean
}
function fetchWindow(
  session: string,
  limit: number,
  before?: string,
  include?: string
): Promise<BranchWindow> {
  return window.cockpit.command('yaya.messages-branch', {
    session,
    limit,
    ...(before ? { before } : {}),
    ...(include ? { include } : {})
  }) as Promise<BranchWindow>
}
function userTurnCount(): number {
  return messages.value.reduce((n, m) => (m.role === 'user' ? n + 1 : n), 0)
}

let loadSeq = 0
/** 整个窗口重新加载（切会话 / 切分支 / 删除后）；同一会话里保留已经翻出来的轮数 */
async function loadMessages(): Promise<void> {
  const id = activeSessionId.value
  if (!id) {
    messages.value = []
    hasMore.value = false
    return
  }
  const seq = ++loadSeq
  flushChunks()
  try {
    const limit = Math.max(WINDOW_TURNS, userTurnCount())
    const win = await fetchWindow(id, limit)
    if (seq !== loadSeq || id !== activeSessionId.value) return
    messages.value = mergeNodes(messages.value, win.messages)
    hasMore.value = win.hasMore
    void scrollToBottom()
    void fillViewport()
  } catch (e) {
    console.error('[yaya] load messages failed', e)
  }
}

/**
 * 运行中的增量刷新：只重新拉最后两轮，拼回窗口末尾（未变化的节点复用旧对象）。
 * 拼不上（分支变了）就整窗重载。
 */
async function refreshTail(): Promise<void> {
  const id = activeSessionId.value
  if (!id) return
  if (!messages.value.length) return loadMessages()
  const seq = ++loadSeq
  flushChunks()
  try {
    const win = await fetchWindow(id, 2)
    if (seq !== loadSeq || id !== activeSessionId.value) return
    const first = win.messages[0]
    const at = first ? messages.value.findIndex((m) => m.id === first.id) : -1
    if (at < 0) {
      void loadMessages()
      return
    }
    messages.value = [
      ...messages.value.slice(0, at),
      ...mergeNodes(messages.value.slice(at), win.messages)
    ]
    void scrollToBottom()
  } catch (e) {
    console.error('[yaya] refresh failed', e)
  }
}

/** 向上翻页：保持当前看到的内容不跳 */
async function loadOlder(): Promise<void> {
  const id = activeSessionId.value
  const first = messages.value[0]
  if (!id || !first || !hasMore.value || loadingOlder.value) return
  loadingOlder.value = true
  try {
    const win = await fetchWindow(id, WINDOW_TURNS, first.id)
    if (id !== activeSessionId.value || messages.value[0]?.id !== first.id) return
    const el = scrollEl.value
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0
    messages.value = [...win.messages, ...messages.value]
    hasMore.value = win.hasMore
    await nextTick()
    // 浏览器的滚动锚定可能已经补偿过：按「离底部的距离不变」写回，两种情况都对
    if (el) {
      el.scrollTop = el.scrollHeight - fromBottom
      lastScrollTop = el.scrollTop
    }
  } catch (e) {
    console.error('[yaya] load older failed', e)
  } finally {
    loadingOlder.value = false
  }
  void fillViewport()
}

// ---- 跳转到某条消息（搜索命中 / 用量统计）：目标在窗口外就把窗口往前扩到它 ----
/** 重新加载窗口并保证包含目标；返回目标是否在当前分支上 */
async function loadAround(messageId: string): Promise<boolean> {
  const id = activeSessionId.value
  if (!id) return false
  const seq = ++loadSeq
  flushChunks()
  const win = await fetchWindow(id, Math.max(WINDOW_TURNS, userTurnCount()), undefined, messageId)
  if (seq !== loadSeq || id !== activeSessionId.value) return false
  messages.value = mergeNodes(messages.value, win.messages)
  hasMore.value = win.hasMore
  return win.messages.some((m) => m.id === messageId)
}

function turnHas(turn: Turn, id: string): boolean {
  if (turn.kind === 'user') return turn.message.id === id
  return turn.steps.some((m) => m.id === id) || turn.orphanResults.some((m) => m.id === id)
}

let flashTimer = 0
async function jumpToMessage(sessionId: string, messageId: string): Promise<void> {
  try {
    if (sessionId !== activeSessionId.value) await selectSession(sessionId)
    else drawerOpen.value = false
    if (activeSessionId.value !== sessionId) return
    if (!messages.value.some((m) => m.id === messageId) && !(await loadAround(messageId))) {
      // 不在当前分支：切到它所在的分支（走到该分支最新的进展）再加载
      await window.cockpit.command('yaya.session-switch-leaf', {
        session: sessionId,
        leaf: messageId
      })
      if (!(await loadAround(messageId))) {
        showNotice(t('yaya.jump_not_found', '找不到这条消息，可能已被删除'), true)
        return
      }
    }
  } catch (e) {
    showNotice(errText(e), true)
    return
  }
  await nextTick()
  const turn = turns.value.find((x) => turnHas(x, messageId))
  const el = turn
    ? scrollEl.value?.querySelector<HTMLElement>(`[data-turn-key="${CSS.escape(turn.key)}"]`)
    : null
  if (!el) return
  stickToBottom.value = false
  el.scrollIntoView({ block: 'center' })
  // content-visibility: auto 的轮次先按估计高度排版，渲染后位置会变：下一帧再对一次
  requestAnimationFrame(() => {
    el.scrollIntoView({ block: 'center' })
    lastScrollTop = scrollEl.value?.scrollTop ?? 0
  })
  el.classList.remove('jump-flash')
  void el.offsetWidth
  el.classList.add('jump-flash')
  window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => el.classList.remove('jump-flash'), 2200)
}

/** 内容还撑不满一屏时（不会触发滚动事件）继续往前加载 */
async function fillViewport(): Promise<void> {
  await nextTick()
  const el = scrollEl.value
  if (el && hasMore.value && el.scrollHeight <= el.clientHeight + 400) void loadOlder()
}

let reloadTimer: ReturnType<typeof setTimeout> | null = null
function scheduleReload(): void {
  if (reloadTimer) return
  reloadTimer = setTimeout(() => {
    reloadTimer = null
    void refreshTail()
  }, 120)
}

/** 断线重连 / 页面回到前台：重新同步运行状态与消息（期间错过的推送不会补发） */
async function resync(): Promise<void> {
  try {
    runningIds.value = ((await window.cockpit.command('yaya.workflow-running')) ?? []) as string[]
  } catch {
    /* 下次事件再同步 */
  }
  await Promise.all([refreshTail(), refreshSnapshot()])
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
  hasMore.value = false
  pendingChunks.clear()
  loadingMessages.value = true
  await Promise.all([loadMessages(), refreshSnapshot()])
  loadingMessages.value = false
  void scrollToBottom(true)
}

function assistantAvatar(a: YayaAssistant): {
  image: string
  monogram: { text: string; hue: number } | null
} {
  const mode = a.profile?.assistantAvatarMode
  return {
    image: mode === 'custom' ? a.profile?.assistantAvatar || '' : '',
    monogram:
      mode === 'model' ? modelMonogram(a.activeModel || rawConfig.value?.activeModel || '') : null
  }
}

/**
 * 切换助手：记成新对话默认用的助手，并开一个新对话
 * （对话一旦开始就固定用它的助手，旧对话不受影响）
 */
async function switchAssistant(id: string): Promise<void> {
  if (!rawConfig.value) return
  if (activeSession.value) newChat()
  if (rawConfig.value.activeAssistantId !== id) {
    rawConfig.value.activeAssistantId = id
    await saveConfig()
  }
}

function newChat(): void {
  drawerOpen.value = false
  activeSessionId.value = null
  messages.value = []
  hasMore.value = false
  snapshot.value = null
  draftWorkflow.value = null
  // 触屏上不自动聚焦：会立刻弹出键盘、整页重排，用户想打字自己点输入框
  if (!matchMedia('(pointer: coarse)').matches) void nextTick(() => inputRef.value?.focus())
}

async function ensureSession(): Promise<string> {
  if (activeSessionId.value) return activeSessionId.value
  const s = (await window.cockpit.command('yaya.session-create', {
    title: t('yaya.new_chat', '新对话'),
    assistant: currentAssistantId.value,
    model: config.value?.activeModel,
    provider: config.value?.activeProviderId,
    workflow: draftWorkflow.value || undefined,
    reasoning: draftReasoning.value || undefined
  })) as Session
  sessions.value.unshift(s)
  activeSessionId.value = s.id
  return s.id
}

// ---- 发送 / 控制 ----
async function handleSend(
  prompt: string,
  attachments: MessageAttachment[],
  mentions: string[] = []
): Promise<void> {
  if (editTarget.value) return sendEdit(editTarget.value, prompt, attachments, mentions)
  try {
    const firstMessage = !activeSessionId.value || messages.value.length === 0
    const id = await ensureSession()
    if (firstMessage) {
      // #Secret("…") 的内容不能进标题（标题是明文存的）
      const title = (
        prompt
          .replace(/#Secret\(\s*("(?:[^"\\]|\\.)*"|“[^”]*”|'(?:[^'\\]|\\.)*')\s*\)/g, '🔒')
          .replace(/#Secret\(.*/g, '🔒') ||
        attachments[0]?.name ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
      if (title) {
        await window.cockpit.command('yaya.session-update', { id, title })
        const s = sessions.value.find((x) => x.id === id)
        if (s) s.title = title
      }
    }
    await window.cockpit.command('yaya.workflow-start', {
      session: id,
      prompt,
      attachments,
      ...(mentions.length ? { mentions } : {})
    })
    markRunning(id)
    await refreshTail()
    void scrollToBottom(true)
  } catch (e) {
    showNotice(te('yaya.send_failed', { error: errText(e) }, '发送失败：{error}'), true)
  }
}

/** 编辑：把消息的文字 / 附件 / 点名载入底部输入框，在那里改完再发 */
function startEdit(message: MessageNode): void {
  if (isRunning.value || !inputRef.value) return
  editTarget.value = message
  inputRef.value.loadForEdit({
    text: message.content,
    attachments: JSON.parse(JSON.stringify(message.attachments ?? [])),
    mentions: messageMentionRecords(message)
  })
}

async function sendEdit(
  message: MessageNode,
  prompt: string,
  attachments: MessageAttachment[],
  mentions: string[]
): Promise<void> {
  if (!activeSessionId.value) return
  editTarget.value = null
  try {
    await window.cockpit.command('yaya.workflow-start', {
      session: activeSessionId.value,
      prompt,
      attachments,
      parent: message.parentId,
      ...(mentions.length ? { mentions } : {})
    })
    markRunning(activeSessionId.value)
    await loadMessages()
    void scrollToBottom(true)
  } catch (e) {
    showNotice(te('yaya.send_failed', { error: errText(e) }, '发送失败：{error}'), true)
  }
}

watch(activeSessionId, () => (editTarget.value = null))

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
  await refreshTail()
}

async function handleApprove(
  approved: boolean,
  reason?: string,
  scope?: ApprovalScope
): Promise<void> {
  if (!activeSessionId.value) return
  await window.cockpit.command('yaya.workflow-approve', {
    session: activeSessionId.value,
    approved,
    ...(reason ? { reason } : {}),
    ...(scope ? { scope } : {})
  })
}

function messageMentionRecords(
  message: MessageNode
): { ref: string; label: string; kind: string }[] {
  const list = message.meta?.mentions
  if (!Array.isArray(list)) return []
  return list
    .map((m) => m as { ref?: unknown; label?: unknown; kind?: unknown })
    .filter((m): m is { ref: string; label?: unknown; kind?: unknown } => typeof m.ref === 'string')
    .map((m) => ({
      ref: m.ref,
      label: typeof m.label === 'string' ? m.label : m.ref,
      kind: typeof m.kind === 'string' ? m.kind : 'builtin'
    }))
}

/** 本对话被 @ 点名强制启用的插件 / 工具 */
const sessionMentionList = computed(() => {
  const list = activeSession.value?.meta?.mentions
  return Array.isArray(list) ? (list as { ref: string; label: string }[]) : []
})
function stopEvent(e: Event): void {
  e.stopPropagation()
}
async function removeSessionMention(ref: string): Promise<void> {
  const s = activeSession.value
  if (!s) return
  const list = (await window.cockpit.command('yaya.session-mentions', {
    id: s.id,
    remove: ref
  })) as unknown[]
  s.meta = { ...(s.meta ?? {}), mentions: list }
}

/** 本对话「都允许」免确认的工具 */
const approvedTools = computed(() => {
  const list = activeSession.value?.meta?.approvedTools
  return Array.isArray(list) ? (list as string[]) : []
})
async function clearApprovedTools(): Promise<void> {
  const s = activeSession.value
  if (!s) return
  await window.cockpit.command('yaya.session-approved-tools', { id: s.id, clear: true })
  s.meta = { ...(s.meta ?? {}), approvedTools: [] }
  showNotice(t('yaya.approved_cleared', '已撤销本对话的免确认，之后会重新询问'))
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

/** 对话树：查看某条分支（走到它最新的进展） */
async function treeView(turn: TreeTurn): Promise<void> {
  await handleSwitchBranch(turn.endId)
  void scrollToBottom(true)
}

/**
 * 对话树：从某个节点开新分支。回答 → 停在这轮回答末尾（下一条消息接在后面）；
 * 提问 → 回到它之前，并把原问题放回输入框（改完再发 = 新分支）。原来的对话都保留。
 */
async function treeBranch(turn: TreeTurn, parentEnd: string | null): Promise<void> {
  const session = activeSessionId.value
  if (!session) return
  try {
    let prefill: string | null = null
    if (turn.kind === 'user') {
      const msg = (await window.cockpit.command('yaya.message-get', {
        session,
        id: turn.id
      })) as { content: string }
      prefill = msg.content
    }
    await window.cockpit.command('yaya.session-switch-leaf', {
      session,
      leaf: turn.kind === 'user' ? (parentEnd ?? 'root') : turn.endId,
      exact: true
    })
    messages.value = []
    hasMore.value = false
    await loadMessages()
    void scrollToBottom(true)
    if (prefill !== null) {
      draft.value = prefill
      if (!matchMedia('(pointer: coarse)').matches) inputRef.value?.focus()
    }
    showNotice(
      t(
        'yaya.tree.branched',
        '已回到这里：接下来发送的消息会开一条新分支，原来的对话保留在对话树里'
      )
    )
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
    title: t(
      'yaya.import_title_any',
      '选择要导入的文件（ChatGPT / Claude / DeepSeek 导出，Rikkahub 备份）'
    ),
    filters: [
      { name: t('yaya.import_filter', '聊天记录导出'), extensions: ['json', 'zip', 'db'] },
      { name: 'JSON', extensions: ['json'] }
    ]
  })
  if (!path) return
  try {
    await window.cockpit.command('yaya.import', { path })
    showNotice(t('yaya.import_started', '已开始导入，进度见后台任务面板'))
  } catch (e) {
    showNotice(errText(e), true)
  }
}

async function exportSession(format: 'md' | 'jsonl'): Promise<void> {
  if (!activeSessionId.value) return
  const ext = format === 'md' ? 'md' : 'jsonl'
  const base = (activeSession.value?.title || 'chat').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60)
  const target = await pickExportTarget({
    title: t('yaya.export_title', '导出会话'),
    defaultPath: `${base}.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  })
  if (!target) return
  try {
    if (target.kind === 'clipboard') {
      const res = (await window.cockpit.command('yaya.session-export', {
        session: activeSessionId.value,
        format
      })) as { ok: boolean; content?: string; error?: string }
      if (!res.ok) throw new Error(res.error)
      await copyExportText(res.content ?? '')
      showNotice(t('yaya.exported_clipboard', '已复制到剪贴板'))
      return
    }
    await window.cockpit.command('yaya.session-export-file', {
      session: activeSessionId.value,
      format,
      out: target.path
    })
    showNotice(te('yaya.exported', { path: target.path }, '已导出到 {path}'))
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
  // 同时作为这个助手之后新对话的模型
  const assistant = currentAssistant.value
  if (assistant) {
    assistant.activeModel = model
    assistant.activeProviderId = providerId
    await saveConfig()
  }
}

async function handleAddCustomModel(payload: { model: string; providerId: string }): Promise<void> {
  const provider = rawConfig.value?.providers.find((p) => p.id === payload.providerId)
  if (!provider || provider.models.includes(payload.model)) return
  provider.models.push(payload.model)
  await saveConfig()
}

async function saveConfig(): Promise<void> {
  if (!rawConfig.value) return
  try {
    await window.cockpit.command('yaya.config-save', {
      config: JSON.parse(JSON.stringify(rawConfig.value))
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
  if (req.kind === 'assistant' && req.fullText && req.fullText !== req.text)
    items.push({
      key: 'copy-full',
      icon: 'mdi-content-copy',
      label: t('yaya.menu.copy_full', '复制完整过程（含思考与工具调用）')
    })
  items.push({
    key: 'select-text',
    icon: 'mdi-format-text',
    label: t('yaya.menu.select_text', '选择文字')
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
    case 'copy-full':
      await window.cockpit.copyText(req.fullText ?? req.text)
      break
    case 'select-text':
      selectText.value = { text: req.text, fullText: req.fullText }
      break
    case 'edit':
      {
        const target = messages.value.find((m) => m.id === req.messageId)
        if (target) startEdit(target)
      }
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
/**
 * 按 offset 追加：重复的块忽略，有缺口就重拉（拉取结果已叠加主进程缓冲）。
 * token 先攒在 `pendingChunks`，每 ~50ms 合并写入一次——每个 token 都改响应式数据会让
 * 整段回答每秒重渲染几十次。
 */
interface PendingChunk {
  node: MessageNode
  field: 'content' | 'reasoningContent'
  /** 攒的文本应该接在 node[field] 的哪个长度上 */
  base: number
  text: string
}
const pendingChunks = new Map<string, PendingChunk>()
let chunkTimer: ReturnType<typeof setTimeout> | null = null

function applyChunk(p: ChunkEvent, field: 'content' | 'reasoningContent', chunk: string): void {
  if (p.sessionId !== activeSessionId.value) return
  const target = messages.value.find((m) => m.id === p.messageId)
  if (!target) return scheduleReload()
  const key = `${p.messageId}:${field}`
  let pend = pendingChunks.get(key)
  if (pend && pend.node !== target) {
    pendingChunks.delete(key)
    pend = undefined
  }
  const length = (target[field] ?? '').length + (pend?.text.length ?? 0)
  if (length === p.offset) {
    if (pend) pend.text += chunk
    else
      pendingChunks.set(key, {
        node: target,
        field,
        base: (target[field] ?? '').length,
        text: chunk
      })
    if (!chunkTimer) chunkTimer = setTimeout(flushChunks, 50)
  } else if (length < p.offset) {
    scheduleReload()
  }
}

function flushChunks(): void {
  if (chunkTimer) clearTimeout(chunkTimer)
  chunkTimer = null
  for (const pend of pendingChunks.values()) {
    const current = pend.node[pend.field] ?? ''
    // 节点已被刷新替换 / 内容对不上：丢弃，刷新结果里已经包含主进程缓冲
    if (current.length !== pend.base || !messages.value.includes(pend.node)) continue
    pend.node[pend.field] = current + pend.text
    if (pend.node.status === 'pending') pend.node.status = 'streaming'
  }
  pendingChunks.clear()
  void scrollToBottom()
}

const unsubs: (() => void)[] = []

/** 分享到达时输入框可能还没挂载：先存着，输入框出现再交 */
let pendingShare: { paths?: string[]; text?: string } | null = null
function flushShare(): void {
  if (!pendingShare || !inputRef.value) return
  const share = pendingShare
  pendingShare = null
  void inputRef.value.acceptShare(share)
}
watch(inputRef, flushShare)

let pendingActivationSession: string | null = null
let activationReady = false
function onActivate(target: unknown): void {
  // 安卓 App 的系统分享（外壳经 shareTarget 交付）：放进当前对话的输入框
  const share = (target as { share?: unknown } | null)?.share
  if (share && typeof share === 'object') {
    pendingShare = share as { paths?: string[]; text?: string }
    void nextTick(flushShare)
    return
  }
  const id = (target as { session?: unknown } | null)?.session
  if (typeof id !== 'string' || !id) return
  pendingActivationSession = id
  if (activationReady) void loadSessions().then(() => selectSession(id))
}
defineExpose({ onActivate })

onMounted(async () => {
  ensurePluginMap()
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
      rawConfig.value = payload as YayaConfig
      // 插件开关可能变了：插件注入的工作流跟着出现 / 消失
      void loadWorkflows()
    }),
    window.cockpit.on('cockpit:yaya-plugins-changed', () => void loadWorkflows()),
    window.cockpit.on('cockpit:yaya-sessions-changed', () => {
      void loadSessions()
    }),
    window.cockpit.on('cockpit:yaya-context-changed', (payload: unknown) => {
      const p = payload as { sessionId: string; state: ContextState | null }
      sessions.value = sessions.value.map((s) => {
        if (s.id !== p.sessionId) return s
        const meta = { ...(s.meta ?? {}) } as Record<string, unknown>
        if (p.state) meta.context = p.state
        else delete meta.context
        return { ...s, meta }
      })
    }),
    // 网页版事件流断线重连：期间的 token / 状态推送都丢了，重新同步
    window.cockpit.on('cockpit:host-reconnected', () => {
      void resync()
    })
  )
  document.addEventListener('visibilitychange', onVisibility)

  await Promise.all([loadConfig(), loadWorkflows()])
  await loadSessions()
  runningIds.value = ((await window.cockpit.command('yaya.workflow-running').catch(() => [])) ??
    []) as string[]
  // 默认打开最近的会话；没有会话就停在新对话
  activationReady = true
  if (pendingActivationSession) await selectSession(pendingActivationSession)
  else if (visibleSessions.value.length > 0) await selectSession(visibleSessions.value[0].id)
})

// keep-alive：从别的页面切回来时同步一次（离开期间可能错过了推送）
let mountedOnce = false
onActivated(() => {
  if (mountedOnce && activeSessionId.value) void resync()
  mountedOnce = true
})

function onVisibility(): void {
  if (document.visibilityState === 'visible' && activeSessionId.value) void resync()
}

onBeforeUnmount(() => {
  window.clearTimeout(flashTimer)
  window.clearInterval(retryTicker)
  for (const off of unsubs) off()
  document.removeEventListener('visibilitychange', onVisibility)
  if (chunkTimer) clearTimeout(chunkTimer)
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
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
    <div v-if="!wide && drawerOpen" class="scrim" :style="scrimStyle" @click="drawerOpen = false" />
    <aside
      class="sidebar"
      :class="{
        'is-open': sidebarVisible,
        'is-overlay': !wide,
        'is-swipeable': !wide && drawerOpen
      }"
      :style="drawerStyle"
      :aria-hidden="!sidebarVisible"
      @pointerdown="onDrawerPointerDown"
      @pointermove="onDrawerPointerMove"
      @pointerup="onDrawerPointerEnd"
      @pointercancel="onDrawerPointerEnd"
      @lostpointercapture="onDrawerPointerEnd"
      @click.capture="onDrawerClick"
    >
      <ChatSessionList
        :sessions="visibleSessions"
        :assistant-names="sessionAssistantNames"
        :assistant-filter="multiAssistant ? assistantName : null"
        :show-all-assistants="showAllAssistants"
        :active-session-id="activeSessionId"
        :running-session-ids="runningIds"
        @select-session="selectSession"
        @open-hit="jumpToMessage"
        @create-session="newChat"
        @delete-session="handleDelete"
        @rename-session="handleRename"
        @import="handleImport"
        @toggle-all-assistants="toggleAllAssistants"
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
          <!-- 点助手名切换助手（新对话用它；当前对话已有内容时开一个新对话） -->
          <v-menu location="bottom start" :close-on-content-click="true">
            <template #activator="{ props: menuProps }">
              <button
                v-bind="menuProps"
                type="button"
                class="assistant-switch"
                :title="t('yaya.assistants.switch', '切换助手')"
                :aria-label="`${t('yaya.assistants.switch', '切换助手')}: ${assistantName}`"
              >
                <span class="assistant-name">{{ assistantName }}</span>
                <v-icon icon="mdi-chevron-down" size="18" class="flex-shrink-0" />
              </button>
            </template>
            <v-list density="compact" min-width="220" max-width="320" class="py-1 yaya-pop">
              <v-list-item
                v-for="a in rawConfig?.assistants ?? []"
                :key="a.id"
                :active="a.id === currentAssistantId"
                color="primary"
                @click="switchAssistant(a.id)"
              >
                <template #prepend>
                  <AvatarBadge v-bind="assistantAvatar(a)" :size="28" class="mr-3" />
                </template>
                <v-list-item-title>{{ a.assistantName }}</v-list-item-title>
              </v-list-item>
              <v-divider class="my-1" />
              <v-list-item
                prepend-icon="mdi-account-cog-outline"
                :title="t('yaya.assistants.manage', '管理助手')"
                @click="settings.open('yaya')"
              />
            </v-list>
          </v-menu>
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
          <v-list density="compact" min-width="190" class="yaya-menu yaya-pop">
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
            <v-list-item
              v-if="approvedTools.length"
              prepend-icon="mdi-shield-off-outline"
              :title="
                te(
                  'yaya.approved_clear',
                  { n: String(approvedTools.length) },
                  '撤销免确认（{n} 个工具）'
                )
              "
              :subtitle="approvedTools.join('、')"
              @click="clearApprovedTools"
            />
            <v-list-group v-if="sessionMentionList.length" value="mentions">
              <template #activator="{ props: groupProps }">
                <!-- 菜单默认点内容就关闭：展开分组这一下要拦住，不然看起来「点了没反应」 -->
                <v-list-item
                  v-bind="groupProps"
                  prepend-icon="mdi-at"
                  :title="
                    te(
                      'yaya.mention.session_title',
                      { n: String(sessionMentionList.length) },
                      '本对话点名启用（{n}）'
                    )
                  "
                  @click="stopEvent"
                />
              </template>
              <v-list-item
                v-for="m in sessionMentionList"
                :key="m.ref"
                :title="`@${m.label}`"
                :subtitle="t('yaya.mention.session_remove', '点击撤销（下一次运行起生效）')"
                @click="removeSessionMention(m.ref)"
              />
            </v-list-group>
            <v-list-item
              prepend-icon="mdi-file-tree-outline"
              :title="t('yaya.tree.title', '对话树')"
              :disabled="!activeSessionId"
              @click="showTree = true"
            />
            <v-list-item
              prepend-icon="mdi-chart-box-outline"
              :title="t('yaya.usage.title', '用量统计')"
              :disabled="!activeSessionId"
              @click="showUsage = true"
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

      <div ref="scrollEl" class="scroll" @scroll.passive="onScroll" @wheel.passive="onWheel">
        <div class="thread">
          <div v-if="hasMore && !loadingMessages" class="older">
            <v-progress-circular
              v-if="loadingOlder"
              indeterminate
              size="22"
              width="2"
              color="primary"
            />
            <v-btn v-else variant="text" prepend-icon="mdi-history" @click="loadOlder">
              {{ t('yaya.load_older', '加载更早的消息') }}
            </v-btn>
          </div>
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
            <ContextMarker
              v-if="
                turn.kind === 'user' &&
                contextBoundary &&
                turn.message.id === contextBoundary.boundaryId
              "
              :state="contextBoundary"
              @reset="resetContext"
            />
            <UserMessage
              v-if="turn.kind === 'user'"
              class="turn-item"
              :data-turn-key="turn.key"
              :message="turn.message"
              :busy="isRunning"
              :editing="editTarget?.id === turn.message.id"
              :profile="config?.profile"
              @switch-branch="handleSwitchBranch"
              @edit="startEdit(turn.message)"
              @menu="(req) => (menuRequest = req)"
            />
            <AssistantTurn
              v-else
              class="turn-item"
              :data-turn-key="turn.key"
              :turn="turn"
              :assistant-name="assistantName"
              :profile="config?.profile"
              :live="isRunning && turn.key === lastTurnKey"
              :pending-approval-id="turn.key === lastTurnKey ? pendingApprovalId : null"
              :is-last="turn.key === lastTurnKey"
              :preview-steps="processPreviewSteps"
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
        <transition name="fade">
          <div v-if="retry" class="retry-hint" role="status" :title="retry.error">
            <v-progress-circular indeterminate size="14" width="2" class="flex-shrink-0" />
            <span class="flex-shrink-0">{{ retryText }}</span>
            <span class="retry-reason text-medium-emphasis">{{ retry.error }}</span>
          </div>
        </transition>
        <div v-if="isPaused" class="paused-bar" role="status">
          <v-icon icon="mdi-pause-circle-outline" size="20" class="flex-shrink-0" />
          <span class="paused-text">{{
            te('yaya.paused_hint', { name: assistantName }, '{name} 已暂停，不会再执行新的步骤')
          }}</span>
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-play"
            @click="controlRun('resume')"
          >
            {{ t('yaya.resume', '继续') }}
          </v-btn>
        </div>
        <!-- 朗读播放器：悬浮窗被禁用时内嵌在输入框上方 -->
        <TtsPlayer v-if="tts.inline && tts.status !== 'idle'" inline />
        <ChatInputBox
          ref="inputRef"
          v-model="draft"
          v-model:workflow-id="currentWorkflowId"
          v-model:reasoning="currentReasoning"
          v-model:expanded="composerExpanded"
          :workflows="workflows"
          :is-running="isRunning"
          :session-id="activeSessionId || ''"
          :ensure-session="ensureSession"
          :assistant-name="assistantName"
          :editing="!!editTarget"
          @send="handleSend"
          @cancel-edit="editTarget = null"
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
      <v-card class="pa-2 yaya-pop">
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

    <SelectTextDialog
      :model-value="selectText !== null"
      :text="selectText?.text ?? ''"
      :full-text="selectText?.fullText"
      @update:model-value="(v: boolean) => !v && (selectText = null)"
    />
    <ConversationTree
      v-model="showTree"
      :session-id="activeSessionId || ''"
      :session-title="sessionTitle"
      @view="treeView"
      @branch="treeBranch"
      @jump="(turn: TreeTurn) => jumpToMessage(activeSessionId || '', turn.id)"
    />
    <UsageDialog
      v-model="showUsage"
      :session-id="activeSessionId || ''"
      :session-title="sessionTitle"
      @jump="(id: string) => jumpToMessage(activeSessionId || '', id)"
    />
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
  /* 子组件用 @container yaya (…) 按页面自身宽度收紧，不看窗口宽度（缩放 / 嵌入时也对） */
  container: yaya / inline-size;
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
  width: min(300px, 78%);
  transform: translateX(-100%);
  background: rgb(var(--v-theme-surface));
  box-shadow: 0 0 32px rgba(0, 0, 0, 0.3);
  transition: transform 0.22s ease;
}
.sidebar.is-overlay.is-open {
  transform: translateX(0);
}
/* 会话列表本身是滚动容器：触控手势只看到滚动容器为止，所以子孙也要禁横向平移，
   否则浏览器接管横划（pointercancel），收不回来 */
.sidebar.is-swipeable,
.sidebar.is-swipeable :deep(*) {
  touch-action: pan-y;
}
@media (pointer: coarse) {
  .sidebar.is-swipeable {
    user-select: none;
    -webkit-user-select: none;
  }
  .sidebar.is-swipeable input,
  .sidebar.is-swipeable textarea {
    user-select: text;
    -webkit-user-select: text;
  }
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
  /* basis 0：标题只用剩余空间，模型按钮优先显示完整 */
  flex: 1 1 0;
  min-width: 0;
  padding-left: 4px;
}
.assistant-switch {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  min-height: 28px;
  padding: 0 6px 0 0;
  border-radius: 8px;
  color: inherit;
  cursor: pointer;
}
.assistant-switch:hover {
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.assistant-name {
  min-width: 0;
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
.older {
  display: flex;
  justify-content: center;
  min-height: 44px;
  align-items: center;
}
/* 视口外的轮次跳过布局与绘制（长会话滚动不卡）；auto 记住渲染过的真实高度 */
.thread > .turn-item {
  content-visibility: auto;
  contain-intrinsic-size: auto 480px;
}
/* 跳转到的轮次：短暂高亮（搜索命中 / 用量统计） */
.thread > .turn-item.jump-flash {
  border-radius: 12px;
  animation: jump-flash 2.2s ease-out;
}
@keyframes jump-flash {
  0%,
  30% {
    box-shadow: 0 0 0 2px rgba(var(--v-theme-primary), 0.55);
    background: rgba(var(--v-theme-primary), 0.08);
  }
  100% {
    box-shadow: 0 0 0 2px rgba(var(--v-theme-primary), 0);
    background: rgba(var(--v-theme-primary), 0);
  }
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

/* ---- 小窗口（页面宽 ≤ 600px）：整体收紧 ---- */
@container yaya (max-width: 600px) {
  .topbar {
    min-height: 50px;
    padding: 4px 6px;
    gap: 2px;
  }
  .assistant-name {
    font-size: 0.95rem;
  }
  .session-title {
    font-size: 0.72rem;
  }
  .model-btn {
    max-width: 48%;
    min-height: 34px;
    padding: 2px 6px 2px 10px;
    gap: 6px;
    border-radius: 10px;
  }
  .model-name {
    font-size: 0.78rem;
  }
  .provider-name {
    display: none;
  }
  .thread {
    padding: 12px 10px 8px;
    gap: 14px;
  }
  .composer {
    padding: 4px 8px 8px;
  }
  .empty {
    padding-top: 3vh;
  }
  .empty-title {
    font-size: 1.2rem;
  }
  .empty-sub {
    font-size: 0.82rem;
    margin-bottom: 18px;
  }
  .suggestion {
    min-height: 44px;
    padding: 8px 12px;
    font-size: 0.82rem;
  }
}

.yaya-menu :deep(.v-list-item) {
  min-height: 40px;
}
.yaya-menu :deep(.v-list-item-title) {
  font-size: 0.875rem;
}
.yaya-menu :deep(.v-list-item__spacer) {
  width: 14px !important;
}

.retry-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 820px;
  margin: 0 auto 8px;
  padding: 6px 14px;
  border-radius: 999px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  font-size: 0.8125rem;
  min-width: 0;
}
.retry-reason {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.paused-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  max-width: 820px;
  margin: 0 auto 8px;
  padding: 8px 8px 8px 14px;
  border-radius: 12px;
  background: rgba(var(--v-theme-warning), 0.12);
  border: 1px solid rgba(var(--v-theme-warning), 0.35);
  font-size: 0.875rem;
}
.paused-text {
  flex: 1 1 auto;
  min-width: 0;
}
</style>
