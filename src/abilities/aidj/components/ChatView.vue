<script setup lang="ts">
import {
  ref,
  inject,
  type Ref,
  computed,
  onMounted,
  onActivated,
  onDeactivated,
  nextTick,
  watch
} from 'vue'
import { translate } from '../../../main/ui/i18n'
import type { ChatMessage, PlayerStatus } from '../types'
import ChatMessageVue from './ChatMessage.vue'
import ContextMenu from './ContextMenu.vue'
import ModelSelect from './ModelSelect.vue'

defineOptions({ name: 'cockpit-aidj-chat' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

const messages = ref<ChatMessage[]>([])
const inputText = ref('')
const thinking = ref(false)
const persistentTaskId = ref('')
const sending = ref(false)
const pendingText = ref('')
const expanded = ref(false)
const chatContainer = ref<HTMLElement | null>(null)

// Session-load animation + sliding window: only the trailing `windowSize`
// messages are rendered; scrolling to the top loads older ones incrementally.
const loadingSession = ref(false)
const sessionProgress = ref(0)
const windowSize = ref(60)
const windowLoading = ref(false)
const visibleMessages = computed(() => messages.value.slice(-windowSize.value))
const contentRef = ref<HTMLElement | null>(null)
let overlayRO: ResizeObserver | null = null

const collapsedH = ref(132)
const overlayStyle = computed(() => ({
  height: expanded.value ? '80%' : `${collapsedH.value}px`
}))

// The command popup floats ABOVE the input overlay (absolute, out of flow), so
// it never affects the document layout. bottom is pinned to the overlay's live
// height (collapsed or expanded) so it always sits just above the input bar.
const overlayEl = ref<HTMLElement | null>(null)
const overlayH = ref(132)
let overlayHRO: ResizeObserver | null = null
function setupOverlayH(): void {
  if (overlayHRO || !overlayEl.value) return
  overlayHRO = new ResizeObserver(() => {
    overlayH.value = overlayEl.value?.offsetHeight ?? 0
  })
  overlayHRO.observe(overlayEl.value)
}
const cmdPopupStyle = computed(() => ({
  bottom: `${overlayH.value + 8}px`
}))

function setupOverlayMeasure(): void {
  if (overlayRO || !contentRef.value) return
  overlayRO = new ResizeObserver(() => {
    if (expanded.value) return
    const el = contentRef.value
    if (!el) return
    const h = Array.from(el.children).reduce((acc, c) => acc + (c as HTMLElement).offsetHeight, 0)
    if (h > 0) collapsedH.value = h
  })
  overlayRO.observe(contentRef.value)
}

let msgSeq = 0
function makeUid(): number {
  return ++msgSeq
}

// ---------------------------------------------------------------------------
// Chat slash-commands — typing a leading `/` shows a hint popup; Tab completes,
// Up/Down navigate. Commands run without the AI (e.g. `/random N`).
// ---------------------------------------------------------------------------
interface ChatCommandDef {
  name: string
  args: string
  descKey: string
  descFallback: string
}
const CHAT_COMMANDS: ChatCommandDef[] = [
  {
    name: 'random',
    args: '<number>',
    descKey: 'aidj.cmd.random.desc',
    descFallback: '随机选取 N 首歌曲'
  },
  {
    name: 'pr',
    args: '<number>',
    descKey: 'aidj.cmd.pr.desc',
    descFallback: 'AI 从随机候选中精选歌单'
  },
  {
    name: 'explore',
    args: '<number>',
    descKey: 'aidj.cmd.explore.desc',
    descFallback: '发现未听过/最少播放的歌曲'
  },
  {
    name: 'ftop',
    args: '<N | -N | A B>',
    descKey: 'aidj.cmd.ftop.desc',
    descFallback: '推送播放次数 Top/倒数/区间'
  },
  {
    name: 'analyse',
    args: '<language|emotion|genre|loudness>',
    descKey: 'aidj.cmd.analyse.desc',
    descFallback: '元数据分布统计（system 消息）'
  },
  {
    name: 'filter',
    args: '[--count] [--compare] [--ignorecase] <表达式>',
    descKey: 'aidj.cmd.filter.desc',
    descFallback: '按表达式过滤曲库（title/lyrics/all）'
  },
  {
    name: 'persist',
    args: '<消息>',
    descKey: 'aidj.cmd.persist.desc',
    descFallback: '分支当前会话为持久会话并后台自动播放'
  },
  {
    name: 'persist-stop',
    args: '',
    descKey: 'aidj.cmd.persistStop.desc',
    descFallback: '停止运行中的持久会话'
  }
]

const cmdActive = ref(0)
const cmdDismissed = ref(false)
const cmdFiltered = computed(() => {
  const raw = inputText.value
  if (!raw.startsWith('/')) return []
  // The first token is the command name (may be a partial prefix).
  const first = raw.slice(1).split(/\s+/)[0].toLowerCase()
  const matched = CHAT_COMMANDS.filter((c) => c.name.startsWith(first))
  if (matched.length === 0) return []
  // Once a command is exactly identified (a space follows it — user is typing
  // its arguments), keep the popup pinned on that command so it can be
  // referenced while filling in the args.
  const exact = CHAT_COMMANDS.find((c) => c.name === first)
  if (exact && /\s/.test(raw.slice(1))) return [exact]
  return matched
})
const cmdVisible = computed(() => !cmdDismissed.value && cmdFiltered.value.length > 0)
watch(inputText, () => {
  cmdActive.value = 0
  cmdDismissed.value = false
})

function cmdApply(): void {
  const c = cmdFiltered.value[cmdActive.value]
  if (c) inputText.value = `/${c.name} `
}

/** Run a "push playlist" command and render the assistant result (like /random). */
async function runPushCommand(
  command: string,
  args: Record<string, unknown>,
  userText: string
): Promise<void> {
  messages.value.push({ role: 'user', content: userText, timestamp: Date.now(), uid: makeUid() })
  try {
    const r = (await window.cockpit.command(command, args)) as {
      ok?: boolean
      intro?: string
      playlist?: { name: string; path: string }[]
      error?: string
    }
    if (r?.ok) {
      messages.value.push({
        role: 'assistant',
        content: r.intro || '',
        playlist: (r.playlist ?? []) as ChatMessage['playlist'],
        timestamp: Date.now(),
        uid: makeUid()
      })
    } else {
      messages.value.push({
        role: 'assistant',
        content: `错误: ${r?.error || '请求失败'}`,
        timestamp: Date.now(),
        uid: makeUid()
      })
    }
  } catch (e) {
    messages.value.push({
      role: 'assistant',
      content: `错误: ${e instanceof Error ? e.message : String(e)}`,
      timestamp: Date.now(),
      uid: makeUid()
    })
  }
  scrollToBottom()
}

/** /pr — AI curates from random candidates. Shows the pulsing thinking bubble
 *  while the AI works, then replaces it with the curated intro + playlist. */
async function runCurateCommand(count: number, userText: string): Promise<void> {
  messages.value.push({ role: 'user', content: userText, timestamp: Date.now(), uid: makeUid() })
  const placeholderIdx = messages.value.length
  messages.value.push({ role: 'assistant', content: '...', timestamp: Date.now(), uid: makeUid() })
  thinking.value = true
  sending.value = true
  scrollToBottom()

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
    const r = (await window.cockpit.command('aidj.curate', { count })) as {
      ok?: boolean
      intro?: string
      playlist?: { name: string; path: string }[]
      error?: string
    }
    if (messages.value[placeholderIdx] == null) return
    if (r?.ok) {
      const placeholderUid = messages.value[placeholderIdx]?.uid
      messages.value[placeholderIdx] = {
        role: 'assistant',
        content: r.intro || t('aidj.cmd.pr.done', '精选歌单'),
        playlist: (r.playlist ?? []) as ChatMessage['playlist'],
        timestamp: Date.now(),
        uid: placeholderUid ?? makeUid()
      }
    } else {
      messages.value[placeholderIdx] = {
        role: 'assistant',
        content: `错误: ${r?.error || '请求失败'}`,
        timestamp: Date.now(),
        uid: messages.value[placeholderIdx]?.uid ?? makeUid()
      }
    }
  } catch (e) {
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
    thinking.value = false
    scrollToBottom()
  }
}

async function handleCommand(text: string): Promise<void> {
  const parts = text.slice(1).trim().split(/\s+/)
  const cmd = (parts[0] || '').toLowerCase()

  if (cmd === 'random') {
    const count = Number(parts[1])
    if (!Number.isFinite(count) || count <= 0) {
      showSnack(t('aidj.cmd.random.usage', '/random <number> — 请输入正整数'), 'warning')
      return
    }
    await runPushCommand('aidj.random', { count }, text)
    return
  }

  if (cmd === 'pr') {
    const count = Number(parts[1])
    if (!Number.isFinite(count) || count <= 0) {
      showSnack(t('aidj.cmd.pr.usage', '/pr <number> — 请输入正整数'), 'warning')
      return
    }
    await runCurateCommand(count, text)
    return
  }

  if (cmd === 'explore') {
    const count = Number(parts[1])
    if (!Number.isFinite(count) || count <= 0) {
      showSnack(t('aidj.cmd.explore.usage', '/explore <number> — 请输入正整数'), 'warning')
      return
    }
    await runPushCommand('aidj.explore', { count }, text)
    return
  }

  if (cmd === 'ftop') {
    const a = Number(parts[1])
    const b = Number(parts[2])
    let args: Record<string, unknown>
    if (Number.isFinite(a) && Number.isFinite(b)) {
      args = { from: a, to: b, text }
    } else if (Number.isFinite(a)) {
      args = a < 0 ? { count: Math.abs(a), bottom: true, text } : { count: a, text }
    } else {
      showSnack(t('aidj.cmd.ftop.usage', '/ftop <N> | -<N> | <A> <B>'), 'warning')
      return
    }
    await runPushCommand('aidj.ftop', args, text)
    return
  }

  if (cmd === 'analyse') {
    const field = (parts[1] || 'language').toLowerCase()
    if (!['language', 'emotion', 'genre', 'loudness'].includes(field)) {
      showSnack(
        t('aidj.cmd.analyse.usage', '/analyse <language|emotion|genre|loudness>'),
        'warning'
      )
      return
    }
    messages.value.push({ role: 'user', content: text, timestamp: Date.now(), uid: makeUid() })
    try {
      const r = (await window.cockpit.command('aidj.analyse', { field })) as {
        ok?: boolean
        total?: number
        distribution?: { label: string; count: number; pct: number }[]
        error?: string
      }
      if (r?.ok && Array.isArray(r.distribution)) {
        const lines = [
          `📊 ${field} 分布（${r.total ?? 0} 首）`,
          ...r.distribution.map((x) => `- ${x.label}: ${x.count}（${x.pct}%）`)
        ]
        messages.value.push({
          role: 'system',
          content: lines.join('\n'),
          timestamp: Date.now(),
          uid: makeUid()
        })
      } else {
        messages.value.push({
          role: 'system',
          content: `错误: ${r?.error || '分析失败'}`,
          timestamp: Date.now(),
          uid: makeUid()
        })
      }
    } catch (e) {
      messages.value.push({
        role: 'system',
        content: `错误: ${e instanceof Error ? e.message : String(e)}`,
        timestamp: Date.now(),
        uid: makeUid()
      })
    }
    scrollToBottom()
    return
  }

  if (cmd === 'filter') {
    const query = text.slice('/filter'.length).trim()
    if (!query) {
      showSnack(
        t(
          'aidj.cmd.filter.usage',
          '/filter [--count=100] [--compare=title|lyrics|all] [--ignorecase] <表达式>'
        ),
        'warning'
      )
      return
    }
    await runFilterCommand(query, text)
    return
  }

  if (cmd === 'persist' || cmd === 'pc') {
    const msg = text.slice(cmd === 'pc' ? 3 : 8).trim()
    await runPersistCommand(msg, text)
    return
  }

  if (cmd === 'persist-stop' || cmd === 'pc-stop') {
    await stopPersistent()
    return
  }

  showSnack(`${t('aidj.cmd.unknown', '未知命令')}: /${cmd}`, 'warning')
}

/**
 * /filter — boolean-expression library filter (title / lyrics / all).
 * Lyrics queries are slow (full lyric text scan), so like the AI thinking
 * bubble it first shows a 「系统正在查询…」system message, then replaces it
 * with the matching playlist (or an error / empty result).
 */
async function runFilterCommand(query: string, userText: string): Promise<void> {
  messages.value.push({ role: 'user', content: userText, timestamp: Date.now(), uid: makeUid() })
  const placeholderIdx = messages.value.length
  messages.value.push({
    role: 'system',
    content: t('aidj.cmd.filter.querying', '系统正在查询…'),
    timestamp: Date.now(),
    uid: makeUid()
  })
  thinking.value = true
  sending.value = true
  scrollToBottom()
  try {
    const r = (await window.cockpit.command('aidj.filter', { query })) as {
      ok?: boolean
      results?: { name: string; path: string }[]
      total?: number
      error?: string
    }
    if (messages.value[placeholderIdx] == null) return
    const uid = messages.value[placeholderIdx]?.uid
    if (r?.ok) {
      const pl = (r.results ?? []) as { name: string; path: string }[]
      messages.value[placeholderIdx] = pl.length
        ? {
            role: 'assistant',
            content: t('aidj.cmd.filter.result', '筛选结果：{n} 首').replace(
              '{n}',
              String(pl.length)
            ),
            playlist: pl,
            timestamp: Date.now(),
            uid: uid ?? makeUid()
          }
        : {
            role: 'system',
            content: t('aidj.cmd.filter.empty', '没有匹配的歌曲'),
            timestamp: Date.now(),
            uid: uid ?? makeUid()
          }
    } else {
      messages.value[placeholderIdx] = {
        role: 'system',
        content: `错误: ${r?.error || '查询失败'}`,
        timestamp: Date.now(),
        uid: uid ?? makeUid()
      }
    }
  } catch (e) {
    if (messages.value[placeholderIdx] == null) return
    messages.value[placeholderIdx] = {
      role: 'system',
      content: `错误: ${e instanceof Error ? e.message : String(e)}`,
      timestamp: Date.now(),
      uid: messages.value[placeholderIdx]?.uid ?? makeUid()
    }
  } finally {
    sending.value = false
    thinking.value = false
    scrollToBottom()
  }
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
  setupOverlayMeasure()
  setupOverlayH()
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
  setupOverlayMeasure()
  setupOverlayH()
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
  if (overlayRO) {
    overlayRO.disconnect()
    overlayRO = null
  }
  if (overlayHRO) {
    overlayHRO.disconnect()
    overlayHRO = null
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

const trackText = computed(() => {
  const t = playerStatus.value.track
  if (!t) return '—'
  return t.length > 8 ? t.slice(0, 8) + '…' : t
})

function onKeydown(e: KeyboardEvent): void {
  if (cmdVisible.value && cmdFiltered.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      cmdActive.value = (cmdActive.value + 1) % cmdFiltered.value.length
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      cmdActive.value = (cmdActive.value - 1 + cmdFiltered.value.length) % cmdFiltered.value.length
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      cmdApply()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      cmdDismissed.value = true
      return
    }
  }
  if (e.shiftKey && e.key === 'Enter' && !sending.value && !thinking.value) {
    e.preventDefault()
    sendMessage()
  }
}

async function sendMessage(): Promise<void> {
  const text = inputText.value.trim()
  if (!text || sending.value || thinking.value) return

  // Slash-commands run without the AI.
  if (text.startsWith('/')) {
    inputText.value = ''
    await handleCommand(text)
    return
  }

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
      if (result.tokens) lastTokens.value = result.tokens as { prompt: number; completion: number }
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
          content: t('aidj.no_match_hint'),
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
/** /persist — fork the current conversation into a `(Copy)` session and run it
 *  persistently in the background (auto-generates and pushes to the continuous
 *  player). The forked session shows up in the session list; the persistent
 *  task's live chat lives in the background panel. */
async function runPersistCommand(prompt: string, userText: string): Promise<void> {
  messages.value.push({ role: 'user', content: userText, timestamp: Date.now(), uid: makeUid() })
  try {
    // Fork the backend's current session (named `(Copy) <orig>`); when there's
    // no session yet (fresh chat) the chat job falls back to a new one.
    let sessionId = ''
    const fork = (await window.cockpit.command('aidj.session-fork')) as {
      ok?: boolean
      sessionId?: string
    } | null
    if (fork?.ok && fork.sessionId) sessionId = fork.sessionId

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
      sessionId,
      player: player || '__auto__',
      view: 'chat'
    })) as Record<string, unknown>
    if (result?.task || result?.ok) {
      const task = result.task as { id?: string } | undefined
      if (task?.id) persistentTaskId.value = task.id
      showSnack(
        sessionId
          ? '已分支当前会话并启动持久播放（可在后台面板继续对话）'
          : '已在后台启动持续会话，可打开后台面板继续对话'
      )
    } else {
      showSnack(`启动持续会话失败: ${(result?.error as string) || '未知错误'}`, 'error')
    }
  } catch (e: unknown) {
    showSnack(`启动持续会话失败: ${e instanceof Error ? e.message : String(e)}`, 'error')
  }
}

/** /persist-stop — stop the running persistent chat task. */
async function stopPersistent(): Promise<void> {
  if (persistentTaskId.value) {
    await window.cockpit.command('background.stop', { id: persistentTaskId.value }).catch(() => {})
    persistentTaskId.value = ''
    showSnack('已停止持久会话')
  } else {
    showSnack('没有运行中的持久会话', 'warning')
  }
}

function scrollToBottom(): void {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight
    }
  })
}

/** Scrolling near the top of the chat area expands the rendered window
 *  upward (load older messages) while keeping the visible position stable. */
async function onChatScroll(): Promise<void> {
  const el = chatContainer.value
  if (!el || windowLoading.value) return
  if (el.scrollTop > 48 || windowSize.value >= messages.value.length) return
  windowLoading.value = true
  const h0 = el.scrollHeight
  const st0 = el.scrollTop
  windowSize.value = Math.min(messages.value.length, windowSize.value + 60)
  await nextTick()
  // Content prepended above → the previous viewport shifted down by the delta.
  el.scrollTop = st0 + (el.scrollHeight - h0)
  windowLoading.value = false
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

/** Context-menu 「从此处分支」— fork the current session, keeping only the
 *  conversation up to (not including) the clicked message, and switch to it. */
async function doFork(): Promise<void> {
  const idx = ctxMsgIndex.value
  if (idx < 0) return
  ctxMenu.value = false
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
  const r = (await window.cockpit.command('aidj.session-fork', {
    keep,
    become: true
  })) as {
    ok?: boolean
    sessionId?: string
    title?: string
    messages?: ChatMessage[]
    error?: string
  }
  if (!r?.ok) {
    showSnack(r?.error || '分支失败', 'error')
    return
  }
  messages.value = (r.messages ?? []).map((m) => ({ ...m, uid: makeUid() }))
  windowSize.value = 60
  inputText.value = ''
  sending.value = false
  scrollToBottom()
  showSnack(`已分支为「${r.title || 'Copy'}」，从此处继续`)
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

/** Load a saved session into the active chat. Exposed to the shell View.
 *  Parsing a long history is slow on the main process, so show a centered
 *  animated loader + parse progress bar instead of a frozen list. */
async function loadSession(sessionId: string): Promise<boolean> {
  loadingSession.value = true
  sessionProgress.value = 0
  const unsub = window.cockpit.on('cockpit:aidj-session-progress', (evt) => {
    const e = evt as { id?: string; done?: number; total?: number }
    if (e.id === sessionId && e.total) {
      sessionProgress.value = Math.round(((e.done ?? 0) / e.total) * 100)
    }
  })
  try {
    const result = (await window.cockpit.command('aidj.sessions.open', {
      id: sessionId
    })) as { ok?: boolean; error?: string; messages?: ChatMessage[] }
    if (!result?.ok) {
      showSnack(result?.error || '会话加载失败', 'error')
      return false
    }
    messages.value = (result.messages ?? []).map((m) => ({
      ...m,
      uid: makeUid()
    }))
    windowSize.value = 60
    sending.value = false
    inputText.value = ''
    expanded.value = false
    scrollToBottom()
    showSnack('已载入会话')
    return true
  } catch (e) {
    showSnack(`会话加载失败: ${e instanceof Error ? e.message : String(e)}`, 'error')
    return false
  } finally {
    unsub()
    loadingSession.value = false
    sessionProgress.value = 0
  }
}

/** New chat (page-menu 「新建会话」): stop any running persistent task, reset
 *  the backend session so the next message starts a fresh conversation, and
 *  clear the view. The new conversation is persisted as a new session and
 *  shows up in the session list afterwards. */
async function newChat(): Promise<void> {
  if (persistentTaskId.value) {
    await window.cockpit.command('background.stop', { id: persistentTaskId.value }).catch(() => {})
    persistentTaskId.value = ''
  }
  await window.cockpit.command('aidj.session-new').catch(() => {})
  messages.value = []
  windowSize.value = 60
  inputText.value = ''
  pendingText.value = ''
  expanded.value = false
  sending.value = false
  thinking.value = false
  scrollToBottom()
  showSnack(t('aidj.chat_new', '已新建会话'))
}

defineExpose({ toMarkdown, loadSession, newChat })
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
          <span class="text-body-2 track-name text-truncate" :title="playerStatus.track || ''">{{
            trackText
          }}</span>
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
      @scroll="onChatScroll"
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
          v-for="(msg, idx) in visibleMessages"
          :key="msg.uid ?? msg.timestamp"
          :message="msg"
          :index="messages.length - visibleMessages.length + idx"
          @play-all="handlePlayAll"
          @play-one="handlePlayOne"
          @reorder="
            (songs: any) => handleReorder(messages.length - visibleMessages.length + idx, songs)
          "
          @context-menu="handleContextMenu"
          @continuous="handleContinuous"
        />
      </TransitionGroup>

      <!-- Session-loading overlay: centered three-dot pulse + parse progress. -->
      <div v-if="loadingSession" class="session-loading">
        <div class="loading-dots" aria-hidden="true"><span></span><span></span><span></span></div>
        <div class="text-caption text-medium-emphasis mt-2">{{ t('aidj.session_loading') }}</div>
        <v-progress-linear
          :model-value="sessionProgress"
          color="primary"
          class="mt-3 session-progress"
          height="4"
          rounded
        />
      </div>
    </div>

    <v-divider />

    <div
      ref="overlayEl"
      class="input-overlay"
      :class="{ 'input-expanded': expanded }"
      :style="overlayStyle"
    >
      <div ref="contentRef" class="overlay-content">
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
              :title="'点击清空已播记忆'"
              @click="memoryConfirm = true"
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
              :title="sbVolbal.enabled ? '点击关闭响度平衡' : '点击开启响度平衡'"
              @click="toggleVolbal"
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
              :title="sbRecordFreq ? '点击关闭频率记录' : '点击开启频率记录'"
              @click="toggleRecordFreq"
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

        <div v-if="!expanded" class="input-bar d-flex ga-2 align-center px-4 pb-3">
          <ModelSelect class="model-select-inline flex-shrink-0" />

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
              :title="t('aidj.expand')"
              @click="expanded = true"
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

        <div v-else class="expanded-panel d-flex flex-column flex-grow-1">
          <div class="d-flex align-center ga-2 px-4 pt-1">
            <ModelSelect class="model-select-inline flex-shrink-0" />

            <v-spacer />

            <v-btn
              variant="text"
              class="flex-shrink-0"
              :title="t('aidj.collapse')"
              @click="expanded = false"
            >
              <v-icon start>mdi-chevron-down</v-icon>
              {{ t('aidj.collapse') }}
            </v-btn>

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
        </div>
      </div>
    </div>

    <Transition name="cmd-pop">
      <div v-if="cmdVisible" class="cmd-popup" :style="cmdPopupStyle">
        <div
          v-for="(c, i) in cmdFiltered"
          :key="c.name"
          class="cmd-item"
          :class="{ 'is-active': i === cmdActive }"
          @mousedown.prevent="cmdApply"
          @mouseenter="cmdActive = i"
        >
          <span class="cmd-name"
            >/{{ c.name }} <span class="cmd-args">{{ c.args }}</span></span
          >
          <span class="cmd-desc">{{ t(c.descKey, c.descFallback) }}</span>
        </div>
      </div>
    </Transition>

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

    <v-snackbar
      v-model="snackOpen"
      :timeout="2500"
      :color="snackColor"
      location="top"
      class="aidj-snackbar"
    >
      <div class="d-flex align-center ga-2">
        <span class="flex-grow-1">{{ snackText }}</span>
        <v-btn icon="mdi-close" size="small" variant="text" @click="snackOpen = false" />
      </div>
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
      @fork="doFork"
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
  display: flex;
  flex-direction: column;
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border-top: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  transition: height 0.28s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}
.cmd-popup {
  position: absolute;
  left: 16px;
  right: 16px;
  z-index: 30;
  max-height: 168px;
  overflow-y: auto;
  border-radius: 10px;
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.25);
  padding: 4px;
}
.cmd-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.82rem;
}
.cmd-item.is-active {
  background: rgba(var(--v-theme-primary), 0.15);
}
.cmd-name {
  font-family: monospace;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  white-space: nowrap;
}
.cmd-args {
  color: rgb(var(--v-theme-on-surface-variant));
  font-weight: 400;
}
.cmd-desc {
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cmd-pop-enter-active,
.cmd-pop-leave-active {
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
}
.cmd-pop-enter-from,
.cmd-pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
.input-overlay.input-expanded {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.35);
}
.overlay-content {
  display: flex;
  flex-direction: column;
  flex: 1 0 auto;
  min-height: 0;
}
.aidj-status-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  width: 100%;
  padding: 6px 16px 10px;
  flex-shrink: 0;
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
.model-select-inline {
  width: 180px;
}
.session-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: rgba(var(--v-theme-surface), 0.35);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  z-index: 5;
}
.loading-dots {
  display: flex;
  gap: 8px;
}
.loading-dots span {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: rgb(var(--v-theme-primary));
  animation: aidj-dot-bounce 1.1s infinite ease-in-out;
}
.loading-dots span:nth-child(2) {
  animation-delay: 0.15s;
}
.loading-dots span:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes aidj-dot-bounce {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  30% {
    transform: translateY(-8px);
    opacity: 1;
  }
}
.session-progress {
  width: min(280px, 60%);
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
.input-bar {
  flex-shrink: 0;
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

.expanded-panel {
  min-height: 0;
  flex-shrink: 0;
}
</style>
