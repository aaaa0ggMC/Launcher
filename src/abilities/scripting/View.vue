<script setup lang="ts">
defineOptions({ name: 'cockpit-scripting' })

import {
  ref,
  computed,
  onMounted,
  onUnmounted,
  onActivated,
  onDeactivated,
  watch,
  nextTick,
  inject,
  type Ref
} from 'vue'
import { translate } from '@ui/i18n'
import type {
  ConsoleLine,
  ConsoleLineType,
  ScriptConfigSchema,
  ScriptItem,
  ScriptLanguage,
  ScriptRunStatus,
  ScriptTemplate
} from './types'
import { SCRIPT_TEMPLATES } from './templates'

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>

// ---------------------------------------------------------------------------
// Editor State & Persistence
// ---------------------------------------------------------------------------
const LAST_OPENED_FILE_KEY = 'cockpit:scripting:last-file-path'

function recordLastOpenedFile(path: string | null): void {
  try {
    if (path) {
      localStorage.setItem(LAST_OPENED_FILE_KEY, path)
    } else {
      localStorage.removeItem(LAST_OPENED_FILE_KEY)
    }
  } catch {
    // ignore
  }
}

const currentScriptId = ref<string>('')
const scriptName = ref<string>('untitled')
const scriptPath = ref<string>('')
const scriptCode = ref<string>(SCRIPT_TEMPLATES[0]?.code ?? '')
const scriptLang = ref<ScriptLanguage>('ts')
const isDirty = ref(false)

const savedScripts = ref<ScriptItem[]>([])
const templates = ref<ScriptTemplate[]>(SCRIPT_TEMPLATES)

// ---------------------------------------------------------------------------
// Search & Replace State
// ---------------------------------------------------------------------------
interface SearchMatch {
  index: number
  length: number
  line: number
}

const showSearchBar = ref(false)
const showReplace = ref(false)
const searchQuery = ref('')
const replaceQuery = ref('')
const searchCaseSensitive = ref(false)
const searchInputRef = ref<HTMLInputElement | null>(null)
const currentMatchIndex = ref(0)
const isViewActive = ref(true)

const matches = computed<SearchMatch[]>(() => {
  const q = searchQuery.value
  if (!q) return []
  const text = scriptCode.value
  const list: SearchMatch[] = []

  const target = searchCaseSensitive.value ? text : text.toLowerCase()
  const needle = searchCaseSensitive.value ? q : q.toLowerCase()
  const qLen = needle.length
  if (qLen === 0) return []

  let pos = 0
  while (pos < target.length) {
    const found = target.indexOf(needle, pos)
    if (found === -1) break
    const line = (text.slice(0, found).match(/\n/g) || []).length
    list.push({ index: found, length: qLen, line })
    pos = found + qLen
  }
  return list
})

const matchStatusText = computed(() => {
  if (!searchQuery.value) return ''
  if (matches.value.length === 0) {
    return translate(uiLang.value, 'scripting.search.noResults')
  }
  return `${currentMatchIndex.value + 1}/${matches.value.length}`
})

function scrollToMatch(match: SearchMatch): void {
  const textarea = editorTextareaRef.value
  if (!textarea) return

  textarea.setSelectionRange(match.index, match.index + match.length)

  const LINE_HEIGHT = 24 // 1.5rem
  const targetTop = match.line * LINE_HEIGHT
  const clientHeight = textarea.clientHeight || 300
  const currentScrollTop = textarea.scrollTop

  if (targetTop < currentScrollTop + 24 || targetTop > currentScrollTop + clientHeight - 48) {
    textarea.scrollTop = Math.max(0, targetTop - Math.floor(clientHeight / 2) + 12)
    syncEditorScroll()
  }
}

function goToNextMatch(): void {
  if (matches.value.length === 0) return
  currentMatchIndex.value = (currentMatchIndex.value + 1) % matches.value.length
  scrollToMatch(matches.value[currentMatchIndex.value])
}

function goToPrevMatch(): void {
  if (matches.value.length === 0) return
  currentMatchIndex.value =
    (currentMatchIndex.value - 1 + matches.value.length) % matches.value.length
  scrollToMatch(matches.value[currentMatchIndex.value])
}

function onSearchEnter(e: KeyboardEvent): void {
  e.preventDefault()
  if (e.shiftKey) {
    goToPrevMatch()
  } else {
    goToNextMatch()
  }
}

function openSearch(withReplace = false): void {
  showSearchBar.value = true
  if (withReplace) {
    showReplace.value = true
  }
  const textarea = editorTextareaRef.value
  if (textarea) {
    const selStart = textarea.selectionStart
    const selEnd = textarea.selectionEnd
    if (selEnd > selStart) {
      const selected = scriptCode.value.substring(selStart, selEnd)
      if (!selected.includes('\n') && selected.trim().length > 0) {
        searchQuery.value = selected
      }
    }
  }
  nextTick(() => {
    const inputEl = searchInputRef.value
    if (inputEl) {
      inputEl.focus()
      inputEl.select()
    }
    if (matches.value.length > 0) {
      const selStart = textarea ? textarea.selectionStart : 0
      const closestIdx = matches.value.findIndex((m) => m.index >= selStart)
      currentMatchIndex.value = closestIdx !== -1 ? closestIdx : 0
      scrollToMatch(matches.value[currentMatchIndex.value])
    }
  })
}

function closeSearch(): void {
  showSearchBar.value = false
  editorTextareaRef.value?.focus()
}

function replaceCurrent(): void {
  if (matches.value.length === 0) return
  const match = matches.value[currentMatchIndex.value]
  if (!match) return

  const before = scriptCode.value.substring(0, match.index)
  const after = scriptCode.value.substring(match.index + match.length)
  scriptCode.value = before + replaceQuery.value + after
  isDirty.value = true

  nextTick(() => {
    if (matches.value.length > 0) {
      if (currentMatchIndex.value >= matches.value.length) {
        currentMatchIndex.value = 0
      }
      scrollToMatch(matches.value[currentMatchIndex.value])
    }
  })
}

function replaceAll(): void {
  if (matches.value.length === 0) return
  const q = searchQuery.value
  if (!q) return

  if (searchCaseSensitive.value) {
    scriptCode.value = scriptCode.value.replaceAll(q, replaceQuery.value)
  } else {
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    scriptCode.value = scriptCode.value.replace(regex, replaceQuery.value)
  }
  isDirty.value = true
}

watch(searchQuery, () => {
  currentMatchIndex.value = 0
  if (matches.value.length > 0) {
    scrollToMatch(matches.value[0])
  }
})

watch(matches, (newMatches) => {
  if (newMatches.length === 0) {
    currentMatchIndex.value = 0
  } else if (currentMatchIndex.value >= newMatches.length) {
    currentMatchIndex.value = newMatches.length - 1
  }
})

// ---------------------------------------------------------------------------
// Config & Parameters State
// ---------------------------------------------------------------------------
const showConfigDrawer = ref(true)
const configSchema = ref<ScriptConfigSchema>({})
const userConfigValues = ref<Record<string, unknown>>({})
const showSecretMap = ref<Record<string, boolean>>({})

const configFieldKeys = computed(() => Object.keys(configSchema.value))
const hasConfigFields = computed(() => configFieldKeys.value.length > 0)

function extractConfigLiteralFromCode(code: string): string | null {
  const match = /(?:export\s+)?(?:const|let|var)\s+config\s*=\s*\{/.exec(code)
  if (!match) return null
  const startIndex = match.index + match[0].length - 1
  let depth = 0
  let inString: string | null = null
  let escape = false
  for (let i = startIndex; i < code.length; i++) {
    const char = code[i]
    if (escape) {
      escape = false
      continue
    }
    if (char === '\\') {
      escape = true
      continue
    }
    if (inString) {
      if (char === inString) inString = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      inString = char
      continue
    }
    if (char === '{') depth++
    else if (char === '}') {
      depth--
      if (depth === 0) {
        return code.slice(startIndex, i + 1)
      }
    }
  }
  return null
}

function parseConfigClientSide(code: string): ScriptConfigSchema | null {
  const snippet = extractConfigLiteralFromCode(code)
  if (!snippet) return null
  try {
    const fn = new Function('cockpit', `return (${snippet})`)
    const res = fn({ env: {}, config: {} })
    if (res && typeof res === 'object' && !Array.isArray(res)) {
      return res as ScriptConfigSchema
    }
  } catch {
    // ignore
  }
  return null
}

async function updateConfigSchema(): Promise<void> {
  const local = parseConfigClientSide(scriptCode.value)
  if (local) {
    configSchema.value = local
    for (const [k, def] of Object.entries(local)) {
      if (userConfigValues.value[k] === undefined && def.default !== undefined) {
        userConfigValues.value[k] = def.default
      }
    }
    return
  }

  try {
    const schema = (await window.cockpit.command('scripting.parseConfig', {
      code: scriptCode.value,
      lang: scriptLang.value
    })) as ScriptConfigSchema
    if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
      configSchema.value = schema
      for (const [k, def] of Object.entries(schema)) {
        if (userConfigValues.value[k] === undefined && def.default !== undefined) {
          userConfigValues.value[k] = def.default
        }
      }
    } else {
      configSchema.value = {}
    }
  } catch {
    // ignore
  }
}

let parseConfigTimer: ReturnType<typeof setTimeout> | null = null

function scheduleConfigParse(): void {
  if (parseConfigTimer) clearTimeout(parseConfigTimer)
  parseConfigTimer = setTimeout(updateConfigSchema, 250)
}

function resetConfigDefaults(): void {
  for (const [k, def] of Object.entries(configSchema.value)) {
    if (def.default !== undefined) {
      userConfigValues.value[k] = def.default
    }
  }
  showToast(translate(uiLang.value, 'scripting.config.reset'))
}

async function pickPathForField(key: string): Promise<void> {
  const picked = await window.cockpit.pickFile({
    title: translate(uiLang.value, 'scripting.config.selectPath'),
    any: true
  })
  if (picked) {
    userConfigValues.value[key] = picked
  }
}

// ---------------------------------------------------------------------------
// Execution & Console State
// ---------------------------------------------------------------------------
const status = ref<ScriptRunStatus>('idle')
const consoleLines = ref<ConsoleLine[]>([])
const progressValue = ref<number | null>(null)
const progressMessage = ref<string>('')
const startedAt = ref<number | null>(null)
const endedAt = ref<number | null>(null)
const autoScroll = ref(true)
const returnValue = ref<unknown>(undefined)
const hasReturnValue = ref(false)

let activeAbortController: AbortController | null = null
let durationTimer: ReturnType<typeof setInterval> | null = null
const liveElapsedMs = ref(0)

// ---------------------------------------------------------------------------
// Splitter & Layout State
// ---------------------------------------------------------------------------
const containerRef = ref<HTMLElement | null>(null)
const editorTextareaRef = ref<HTMLTextAreaElement | null>(null)
const lineNumbersRef = ref<HTMLElement | null>(null)
const consoleOutputRef = ref<HTMLElement | null>(null)

const consoleHeight = ref<number>(200)
const isDraggingSplitter = ref(false)
const MIN_CONSOLE_HEIGHT = 100

// Toast / Notification
const toastText = ref('')
const toastVisible = ref(false)

function showToast(msg: string): void {
  toastText.value = msg
  toastVisible.value = true
}

// ---------------------------------------------------------------------------
// Computed Properties
// ---------------------------------------------------------------------------
const lineCount = computed(() => {
  return (scriptCode.value.match(/\n/g) || []).length + 1
})

const lineNumbers = computed(() => {
  const count = lineCount.value
  const arr: number[] = new Array(count)
  for (let i = 0; i < count; i++) arr[i] = i + 1
  return arr
})

const durationText = computed(() => {
  if (!startedAt.value) return '0.0s'
  const ms = endedAt.value ? endedAt.value - startedAt.value : liveElapsedMs.value
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
})

const statusColor = computed(() => {
  switch (status.value) {
    case 'running':
      return 'primary'
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'warning'
    default:
      return 'secondary'
  }
})

const statusLabel = computed(() => {
  switch (status.value) {
    case 'running':
      return translate(uiLang.value, 'scripting.console.running')
    case 'success':
      return translate(uiLang.value, 'scripting.console.success')
    case 'error':
      return translate(uiLang.value, 'scripting.console.error')
    case 'cancelled':
      return translate(uiLang.value, 'scripting.console.cancelled')
    default:
      return translate(uiLang.value, 'scripting.console.ready')
  }
})

// ---------------------------------------------------------------------------
// Console Logging Helpers
// ---------------------------------------------------------------------------
let logSeq = 0
let scriptOutputUnsub: (() => void) | null = null
let scriptOutputSingleUnsub: (() => void) | null = null
let scriptProgressUnsub: (() => void) | null = null
let scrollRaf: number | null = null

function triggerScroll(): void {
  if (!autoScroll.value) return
  if (scrollRaf !== null) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null
    scrollConsoleToBottom()
  })
}

function appendLogBatch(items: ConsoleLine[]): void {
  if (!items.length) return
  consoleLines.value.push(...items)
  if (consoleLines.value.length > 2000) {
    consoleLines.value.splice(0, consoleLines.value.length - 2000)
  }
  triggerScroll()
}

function appendLog(type: ConsoleLineType, text: string, time = Date.now()): void {
  appendLogBatch([
    {
      id: `log-${Date.now()}-${++logSeq}`,
      time,
      type,
      text
    }
  ])
}

function scrollConsoleToBottom(): void {
  if (consoleOutputRef.value) {
    consoleOutputRef.value.scrollTop = consoleOutputRef.value.scrollHeight
  }
}

function clearConsole(): void {
  consoleLines.value = []
  returnValue.value = undefined
  hasReturnValue.value = false
  progressValue.value = null
  progressMessage.value = ''
  if (status.value !== 'running') {
    status.value = 'idle'
    startedAt.value = null
    endedAt.value = null
    liveElapsedMs.value = 0
  }
}

async function copyConsoleOutput(): Promise<void> {
  const text = consoleLines.value.map((l) => `[${l.type}] ${l.text}`).join('\n')
  await window.cockpit.copyText(text)
  showToast(translate(uiLang.value, 'scripting.console.copied'))
}

// ---------------------------------------------------------------------------
// Script Management (Load / Save / Templates / New)
// ---------------------------------------------------------------------------
async function fetchSavedScripts(): Promise<void> {
  try {
    const list = (await window.cockpit.command('scripting.list')) as ScriptItem[]
    if (Array.isArray(list)) {
      savedScripts.value = list
    }
  } catch {
    // ignore
  }
}

function loadTemplate(tpl: ScriptTemplate): void {
  scriptCode.value = tpl.code
  scriptLang.value = tpl.language
  scriptName.value = tpl.name
  scriptPath.value = ''
  currentScriptId.value = ''
  isDirty.value = false
  userConfigValues.value = {}
  recordLastOpenedFile(null)
  updateConfigSchema()
  showToast(`${translate(uiLang.value, 'scripting.dialog.loadedSuccess')}: ${tpl.name}`)
}

function newScript(): void {
  scriptCode.value = `/**\n * ${translate(uiLang.value, 'scripting.toolbar.untitled')}\n */\n\ncockpit.log('Hello from Cockpit!')\n`
  scriptLang.value = 'ts'
  scriptName.value = 'untitled'
  scriptPath.value = ''
  currentScriptId.value = ''
  isDirty.value = false
  userConfigValues.value = {}
  recordLastOpenedFile(null)
  updateConfigSchema()
}

async function openLocalFile(): Promise<void> {
  const picked = await window.cockpit.pickFile({
    title: translate(uiLang.value, 'scripting.toolbar.openFile'),
    filters: [
      { name: 'Scripts (*.ts, *.js)', extensions: ['ts', 'js', 'mjs', 'cjs'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
  if (!picked) return

  try {
    const loaded = (await window.cockpit.command('scripting.load', {
      path: picked
    })) as ScriptItem
    if (loaded && loaded.code !== undefined) {
      scriptCode.value = loaded.code
      scriptLang.value = loaded.language || 'ts'
      scriptName.value = loaded.name || 'script'
      const finalPath = loaded.path || picked
      scriptPath.value = finalPath
      currentScriptId.value = loaded.id
      isDirty.value = false
      userConfigValues.value = {}
      recordLastOpenedFile(finalPath)
      updateConfigSchema()
      showToast(`${translate(uiLang.value, 'scripting.dialog.loadedSuccess')}: ${loaded.name}`)
    }
  } catch (err) {
    appendLog('error', `打开文件失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function reloadFromDisk(): Promise<void> {
  if (!scriptPath.value) return
  try {
    const loaded = (await window.cockpit.command('scripting.load', {
      path: scriptPath.value
    })) as ScriptItem
    if (loaded && loaded.code !== undefined) {
      scriptCode.value = loaded.code
      isDirty.value = false
      updateConfigSchema()
      showToast(`${translate(uiLang.value, 'scripting.toolbar.reloadFromDisk')}: ${loaded.name}`)
    }
  } catch (err) {
    appendLog('error', `重新加载失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function saveCurrentScript(saveAs = false): Promise<void> {
  let targetPath = scriptPath.value
  if (saveAs || !targetPath) {
    const defaultName = `${scriptName.value || 'script'}.${scriptLang.value}`
    const picked = await window.cockpit.pickSaveFile({
      title: translate(uiLang.value, 'scripting.toolbar.saveAs'),
      defaultPath: defaultName,
      filters: [
        {
          name: scriptLang.value === 'ts' ? 'TypeScript (*.ts)' : 'JavaScript (*.js)',
          extensions: [scriptLang.value]
        },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (!picked) return
    targetPath = picked
  }

  try {
    const saved = (await window.cockpit.command('scripting.save', {
      name: scriptName.value,
      code: scriptCode.value,
      lang: scriptLang.value,
      path: targetPath
    })) as ScriptItem
    if (saved) {
      const finalPath = saved.path || targetPath
      scriptPath.value = finalPath
      scriptName.value = saved.name || scriptName.value
      currentScriptId.value = saved.id
      isDirty.value = false
      recordLastOpenedFile(finalPath)
      await fetchSavedScripts()
      showToast(translate(uiLang.value, 'scripting.dialog.savedSuccess'))
    }
  } catch (err) {
    appendLog('error', `保存失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function deleteSavedScript(item: ScriptItem): Promise<void> {
  try {
    await window.cockpit.command('scripting.delete', { path: item.path || item.id })
    await fetchSavedScripts()
    if (scriptPath.value === item.path) {
      newScript()
    }
  } catch {
    // ignore
  }
}

function loadSavedScript(item: ScriptItem): void {
  scriptCode.value = item.code
  scriptLang.value = item.language
  scriptName.value = item.name
  scriptPath.value = item.path || ''
  currentScriptId.value = item.id
  isDirty.value = false
  userConfigValues.value = {}
  recordLastOpenedFile(item.path || null)
  updateConfigSchema()
  showToast(`${translate(uiLang.value, 'scripting.dialog.loadedSuccess')}: ${item.name}`)
}

// ---------------------------------------------------------------------------
// Code Snippets Injection
// ---------------------------------------------------------------------------
function insertSnippet(snippet: string): void {
  const textarea = editorTextareaRef.value
  if (!textarea) {
    scriptCode.value += `\n${snippet}\n`
    return
  }
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const before = scriptCode.value.substring(0, start)
  const after = scriptCode.value.substring(end)
  scriptCode.value = before + snippet + after
  isDirty.value = true
  nextTick(() => {
    textarea.focus()
    textarea.selectionStart = textarea.selectionEnd = start + snippet.length
  })
}

// ---------------------------------------------------------------------------
// Execution Control
// ---------------------------------------------------------------------------
async function runScript(): Promise<void> {
  if (status.value === 'running') return

  if (scriptPath.value && !isDirty.value) {
    try {
      const loaded = (await window.cockpit.command('scripting.load', {
        path: scriptPath.value
      })) as ScriptItem
      if (loaded && typeof loaded.code === 'string') {
        scriptCode.value = loaded.code
      }
    } catch {
      // ignore
    }
  }

  status.value = 'running'
  startedAt.value = Date.now()
  endedAt.value = null
  liveElapsedMs.value = 0
  progressValue.value = null
  progressMessage.value = ''
  returnValue.value = undefined
  hasReturnValue.value = false

  if (durationTimer) clearInterval(durationTimer)
  durationTimer = setInterval(() => {
    if (startedAt.value && !endedAt.value) {
      liveElapsedMs.value = Date.now() - startedAt.value
    }
  }, 100)

  appendLog('system', `=== ${new Date().toLocaleTimeString()} 脚本启动 ===`)

  activeAbortController = new AbortController()

  try {
    const res = (await window.cockpit.command('scripting.run', {
      code: scriptCode.value,
      lang: scriptLang.value,
      config: JSON.parse(JSON.stringify(userConfigValues.value))
    })) as {
      ok: boolean
      result?: unknown
      error?: string
      durationMs?: number
    }

    endedAt.value = Date.now()
    if (durationTimer) {
      clearInterval(durationTimer)
      durationTimer = null
    }

    if (res?.ok) {
      status.value = 'success'
      if (res.result !== undefined) {
        hasReturnValue.value = true
        returnValue.value = res.result
      }
      appendLog('system', `=== 脚本执行成功 (耗时 ${durationText.value}) ===`)
    } else {
      status.value = 'error'
      const errMsg = res?.error || '执行出错'
      if (!consoleLines.value.some((l) => l.type === 'error' && l.text.includes(errMsg))) {
        appendLog('error', errMsg)
      }
      appendLog('system', `=== 脚本执行终止 ===`)
    }
  } catch (err: unknown) {
    endedAt.value = Date.now()
    if (durationTimer) {
      clearInterval(durationTimer)
      durationTimer = null
    }
    status.value = 'error'
    const msg = err instanceof Error ? err.message : String(err)
    appendLog('error', msg)
    appendLog('system', `=== 脚本执行异常 ===`)
  } finally {
    activeAbortController = null
  }
}

async function stopScript(): Promise<void> {
  if (activeAbortController) {
    activeAbortController.abort()
    activeAbortController = null
  }
  status.value = 'cancelled'
  endedAt.value = Date.now()
  if (durationTimer) {
    clearInterval(durationTimer)
    durationTimer = null
  }
  appendLog('warn', '用户中止了脚本执行')
  try {
    await window.cockpit.command('scripting.stop')
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Editor Key & Scroll Handling
// ---------------------------------------------------------------------------
function handleEditorKeyDown(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault()
    runScript()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault()
    saveCurrentScript()
    return
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    openSearch(false)
    return
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) {
    e.preventDefault()
    openSearch(true)
    return
  }
  if (e.key === 'Escape' && showSearchBar.value) {
    e.preventDefault()
    closeSearch()
    return
  }

  // Handle Tab indent
  if (e.key === 'Tab') {
    e.preventDefault()
    const textarea = editorTextareaRef.value
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd

    if (!e.shiftKey) {
      const before = scriptCode.value.substring(0, start)
      const after = scriptCode.value.substring(end)
      scriptCode.value = before + '  ' + after
      isDirty.value = true
      nextTick(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 2
      })
    }
  }
}

function handleGlobalKeyDown(e: KeyboardEvent): void {
  if (!isViewActive.value) return
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    e.preventDefault()
    openSearch(false)
    return
  }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'h' || e.key === 'H')) {
    e.preventDefault()
    openSearch(true)
    return
  }
  if (e.key === 'Escape' && showSearchBar.value) {
    e.preventDefault()
    closeSearch()
  }
}

function syncEditorScroll(): void {
  if (editorTextareaRef.value && lineNumbersRef.value) {
    lineNumbersRef.value.scrollTop = editorTextareaRef.value.scrollTop
  }
}

watch(scriptCode, () => {
  isDirty.value = true
  scheduleConfigParse()
})

watch(scriptLang, () => {
  scheduleConfigParse()
})

// ---------------------------------------------------------------------------
// Splitter Drag Resizing
// ---------------------------------------------------------------------------
function startSplitterDrag(e: MouseEvent): void {
  isDraggingSplitter.value = true
  const startY = e.clientY
  const startHeight = consoleHeight.value

  const onMouseMove = (moveEvt: MouseEvent): void => {
    if (!isDraggingSplitter.value) return
    const deltaY = moveEvt.clientY - startY
    const containerHeight = containerRef.value?.clientHeight ?? 600
    const maxConsoleHeight = containerHeight - 140
    const newH = Math.min(
      Math.max(startHeight - deltaY, MIN_CONSOLE_HEIGHT),
      Math.max(maxConsoleHeight, MIN_CONSOLE_HEIGHT)
    )
    consoleHeight.value = newH
  }

  const onMouseUp = (): void => {
    isDraggingSplitter.value = false
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }

  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
onMounted(async () => {
  await fetchSavedScripts()
  const lastPath = localStorage.getItem(LAST_OPENED_FILE_KEY)
  if (lastPath) {
    try {
      const loaded = (await window.cockpit.command('scripting.load', {
        path: lastPath
      })) as ScriptItem
      if (loaded && loaded.code !== undefined) {
        scriptCode.value = loaded.code
        scriptLang.value = loaded.language || 'ts'
        scriptName.value = loaded.name || 'script'
        scriptPath.value = loaded.path || lastPath
        currentScriptId.value = loaded.id
        isDirty.value = false
        userConfigValues.value = {}
      } else {
        recordLastOpenedFile(null)
      }
    } catch {
      recordLastOpenedFile(null)
    }
  }
  await updateConfigSchema()
  window.addEventListener('keydown', handleGlobalKeyDown)

  scriptOutputUnsub = window.cockpit.on('cockpit:script-output-batch', (payload: unknown) => {
    const lines = payload as ConsoleLine[]
    if (Array.isArray(lines) && lines.length > 0) {
      appendLogBatch(lines)
    }
  })

  scriptOutputSingleUnsub = window.cockpit.on('cockpit:script-output', (payload: unknown) => {
    const line = payload as ConsoleLine
    if (line && typeof line.text === 'string') {
      appendLog(line.type, line.text, line.time)
    }
  })

  scriptProgressUnsub = window.cockpit.on('cockpit:script-progress', (payload: unknown) => {
    const data = payload as { pct: number; message?: string }
    if (data && typeof data.pct === 'number') {
      progressValue.value = data.pct
      if (data.message) progressMessage.value = data.message
    }
  })
})

onActivated(() => {
  isViewActive.value = true
})

onDeactivated(() => {
  isViewActive.value = false
})

onUnmounted(() => {
  if (scrollRaf !== null) {
    cancelAnimationFrame(scrollRaf)
    scrollRaf = null
  }
  scriptOutputUnsub?.()
  scriptOutputUnsub = null
  scriptOutputSingleUnsub?.()
  scriptOutputSingleUnsub = null
  scriptProgressUnsub?.()
  scriptProgressUnsub = null
  window.removeEventListener('keydown', handleGlobalKeyDown)
  if (durationTimer) clearInterval(durationTimer)
  if (parseConfigTimer) clearTimeout(parseConfigTimer)
})
</script>

<template>
  <div ref="containerRef" class="scripting-ide-root">
    <!-- Top Action Toolbar (Single Compact Row with Default Density Buttons) -->
    <div class="d-flex align-center justify-space-between pb-3 pt-1 flex-nowrap ga-3 ide-top-bar">
      <!-- Left: File breadcrumb & Language badge -->
      <div class="d-flex align-center ga-3 flex-shrink-0">
        <div class="d-flex align-center px-3 py-1.5 rounded-lg ide-breadcrumb ga-2">
          <v-icon icon="mdi-code-braces" size="20" class="text-primary" />
          <span class="text-subtitle-2 font-weight-bold font-family-mono">
            {{ scriptName }}.{{ scriptLang }}
          </span>
          <span v-if="isDirty" class="text-primary font-weight-bold">•</span>
        </div>

        <v-btn-toggle
          v-model="scriptLang"
          mandatory
          rounded="lg"
          variant="tonal"
          density="compact"
          class="ide-lang-toggle"
        >
          <v-btn value="ts" size="small" class="text-none font-weight-bold px-2">TS</v-btn>
          <v-btn value="js" size="small" class="text-none font-weight-bold px-2">JS</v-btn>
        </v-btn-toggle>
      </div>

      <!-- Center: Clean Action Buttons Group -->
      <div class="d-flex align-center ga-2 flex-wrap justify-center">
        <!-- New Script (Icon-only allowed size="small") -->
        <v-tooltip :text="translate(uiLang, 'scripting.toolbar.newScript')" location="bottom">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              icon="mdi-file-plus-outline"
              size="small"
              variant="text"
              @click="newScript"
            />
          </template>
        </v-tooltip>

        <!-- Open File -->
        <v-tooltip :text="translate(uiLang, 'scripting.toolbar.openFile')" location="bottom">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              icon="mdi-folder-open-outline"
              size="small"
              variant="text"
              @click="openLocalFile"
            />
          </template>
        </v-tooltip>

        <!-- Reload from disk -->
        <v-tooltip
          v-if="scriptPath"
          :text="translate(uiLang, 'scripting.toolbar.reloadFromDisk')"
          location="bottom"
        >
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              icon="mdi-reload"
              size="small"
              variant="text"
              @click="reloadFromDisk"
            />
          </template>
        </v-tooltip>

        <!-- Save File -->
        <v-tooltip :text="translate(uiLang, 'scripting.toolbar.shortcutSave')" location="bottom">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              icon="mdi-content-save-outline"
              size="small"
              variant="text"
              @click="saveCurrentScript(false)"
            />
          </template>
        </v-tooltip>

        <!-- Search Code (Ctrl+F) -->
        <v-tooltip :text="translate(uiLang, 'scripting.toolbar.search')" location="bottom">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              icon="mdi-magnify"
              size="small"
              variant="text"
              @click="openSearch(false)"
            />
          </template>
        </v-tooltip>

        <!-- Presets & Templates Menu (Text button: default density) -->
        <v-menu location="bottom center">
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              variant="text"
              class="text-none px-3"
              prepend-icon="mdi-code-json"
              append-icon="mdi-chevron-down"
            >
              {{ translate(uiLang, 'scripting.toolbar.templates') }}
            </v-btn>
          </template>
          <v-list density="compact" rounded="lg" class="script-menu-list">
            <v-list-item
              v-for="t in templates"
              :key="t.id"
              :title="t.name"
              :subtitle="t.description"
              @click="loadTemplate(t)"
            >
              <template #prepend>
                <v-icon icon="mdi-file-code-outline" size="small" class="text-primary mr-2" />
              </template>
            </v-list-item>
          </v-list>
        </v-menu>

        <!-- Saved Scripts Menu (if any) -->
        <v-menu v-if="savedScripts.length > 0" location="bottom center">
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              variant="text"
              class="text-none px-3"
              prepend-icon="mdi-folder-text-outline"
              append-icon="mdi-chevron-down"
            >
              {{ translate(uiLang, 'scripting.toolbar.scriptList') }}
              <span class="opacity-60 ml-1">({{ savedScripts.length }})</span>
            </v-btn>
          </template>
          <v-list density="compact" rounded="lg" class="script-menu-list">
            <v-list-item
              v-for="s in savedScripts"
              :key="s.id"
              :title="s.name"
              :subtitle="s.path || s.id"
              @click="loadSavedScript(s)"
            >
              <template #prepend>
                <v-icon icon="mdi-file-document-outline" size="small" class="text-primary mr-2" />
              </template>
              <template #append>
                <v-btn
                  icon="mdi-trash-can-outline"
                  size="small"
                  variant="text"
                  color="error"
                  @click.stop="deleteSavedScript(s)"
                />
              </template>
            </v-list-item>
          </v-list>
        </v-menu>

        <!-- Snippets Dropdown (Text button: default density) -->
        <v-menu location="bottom center">
          <template #activator="{ props: menuProps }">
            <v-btn
              v-bind="menuProps"
              variant="text"
              class="text-none px-3"
              prepend-icon="mdi-lightning-bolt-outline"
              append-icon="mdi-chevron-down"
            >
              {{ translate(uiLang, 'scripting.toolbar.snippets') }}
            </v-btn>
          </template>
          <v-list density="compact" rounded="lg" class="script-menu-list">
            <v-list-item
              :title="translate(uiLang, 'scripting.snippets.declareConfig')"
              subtitle="export const config = { ... }"
              @click="
                insertSnippet(
                  `export const config = {\n  targetDir: { type: 'path', label: '目标路径', default: '/tmp' },\n  enableLog: { type: 'boolean', label: '启用日志', default: true },\n  concurrency: { type: 'slider', label: '并发数', min: 1, max: 8, default: 2 }\n}\n`
                )
              "
            />
            <v-list-item
              :title="translate(uiLang, 'scripting.snippets.callCommand')"
              subtitle="await cockpit.command('name', args)"
              @click="
                insertSnippet(
                  `const res = await cockpit.command('dashboard.stats')\ncockpit.log(res)`
                )
              "
            />
            <v-list-item
              :title="translate(uiLang, 'scripting.snippets.execShell')"
              subtitle="await cockpit.sh('uname -a')"
              @click="insertSnippet(`const out = await cockpit.sh('echo $USER')\ncockpit.log(out)`)"
            />
            <v-list-item
              :title="translate(uiLang, 'scripting.snippets.readFile')"
              subtitle="await cockpit.fs.readFile(path)"
              @click="
                insertSnippet(
                  `const content = await cockpit.fs.readFile('/etc/os-release')\ncockpit.log(content)`
                )
              "
            />
            <v-list-item
              :title="translate(uiLang, 'scripting.snippets.writeFile')"
              subtitle="await cockpit.fs.writeFile(path, content)"
              @click="
                insertSnippet(
                  `await cockpit.fs.writeFile('/tmp/cockpit-test.txt', 'Hello Cockpit!')`
                )
              "
            />
            <v-list-item
              :title="translate(uiLang, 'scripting.snippets.fetchNetwork')"
              subtitle="await cockpit.fetch(url) or fetch(url)"
              @click="
                insertSnippet(
                  `const res = await cockpit.fetch('https://api.github.com/zen')\nconst text = await res.text()\ncockpit.log('GitHub Zen:', text)`
                )
              "
            />
            <v-list-item
              :title="translate(uiLang, 'scripting.snippets.sleep')"
              subtitle="await cockpit.sleep(ms)"
              @click="insertSnippet(`await cockpit.sleep(1000)`)"
            />
            <v-list-item
              :title="translate(uiLang, 'scripting.snippets.notify')"
              subtitle="await cockpit.notify(title, body)"
              @click="insertSnippet(`await cockpit.notify('工作流提醒', '任务已顺利完成')`)"
            />
            <v-list-item
              :title="translate(uiLang, 'scripting.snippets.storage')"
              subtitle="await cockpit.storage.set/get"
              @click="
                insertSnippet(
                  `await cockpit.storage.set('lastRun', Date.now())\nconst prev = await cockpit.storage.get('lastRun')`
                )
              "
            />
          </v-list>
        </v-menu>

        <!-- Toggle Parameters Panel (Text button: default density) -->
        <v-btn
          :variant="showConfigDrawer ? 'tonal' : 'text'"
          :color="showConfigDrawer ? 'primary' : undefined"
          class="text-none px-3"
          prepend-icon="mdi-tune-variant"
          @click="showConfigDrawer = !showConfigDrawer"
        >
          {{ translate(uiLang, 'scripting.toolbar.config') }}
          <v-badge
            v-if="hasConfigFields"
            :content="configFieldKeys.length"
            color="primary"
            inline
            class="ml-1"
          />
        </v-btn>
      </div>

      <!-- Right: Main Run Action (Text button: default density) -->
      <div class="d-flex align-center ga-2 flex-shrink-0">
        <v-btn
          v-if="status === 'running'"
          color="error"
          variant="tonal"
          class="text-none px-5"
          prepend-icon="mdi-stop"
          @click="stopScript"
        >
          {{ translate(uiLang, 'scripting.toolbar.stop') }}
        </v-btn>
        <v-btn
          v-else
          color="primary"
          variant="flat"
          class="text-none px-5 font-weight-bold"
          prepend-icon="mdi-play"
          @click="runScript"
        >
          {{ translate(uiLang, 'scripting.toolbar.run') }}
          <span class="text-caption ml-1 opacity-75 font-weight-regular">(Ctrl+↵)</span>
        </v-btn>
      </div>
    </div>

    <!-- Main Workspace Container -->
    <div class="d-flex ide-workspace-wrapper overflow-hidden ga-3">
      <!-- Left Area: Editor + Splitter + Console -->
      <div class="d-flex flex-column ide-main-pane rounded-lg">
        <!-- Editor Header Info Bar -->
        <div
          class="d-flex align-center justify-space-between px-3 py-2 text-caption on-surface-variant ide-editor-topbar"
        >
          <div class="d-flex align-center ga-2 text-truncate">
            <span class="font-family-mono opacity-80">
              {{ scriptPath || `${scriptName}.${scriptLang}` }}
            </span>
          </div>
          <div class="d-flex align-center ga-3">
            <v-tooltip :text="translate(uiLang, 'scripting.toolbar.search')" location="bottom">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  icon="mdi-magnify"
                  size="small"
                  variant="text"
                  density="compact"
                  @click="openSearch(false)"
                />
              </template>
            </v-tooltip>
            <div class="font-family-mono opacity-80">
              {{ lineCount }} {{ translate(uiLang, 'scripting.editor.lineCount') }}
            </div>
          </div>
        </div>

        <!-- Upper Editor Body: Line Numbers + Textarea -->
        <div class="ide-code-wrapper">
          <!-- Floating Search & Replace Bar -->
          <v-fade-transition>
            <div
              v-if="showSearchBar"
              class="ide-search-box elevation-6 rounded-lg pa-2 d-flex flex-column ga-1"
            >
              <!-- Search Row -->
              <div class="d-flex align-center ga-1">
                <v-btn
                  icon="mdi-chevron-down"
                  size="small"
                  variant="text"
                  density="compact"
                  :class="{ 'rotate-180': showReplace }"
                  :title="translate(uiLang, 'scripting.search.toggleReplace')"
                  @click="showReplace = !showReplace"
                />
                <div class="ide-search-input-box">
                  <input
                    ref="searchInputRef"
                    v-model="searchQuery"
                    type="text"
                    class="ide-search-native-input font-family-mono"
                    :placeholder="translate(uiLang, 'scripting.search.placeholder')"
                    @keydown.enter="onSearchEnter"
                    @keydown.esc.stop="closeSearch"
                  />
                  <span class="search-count-text text-caption opacity-70 font-family-mono">
                    {{ matchStatusText }}
                  </span>
                </div>

                <v-btn
                  icon="mdi-format-letter-case"
                  size="small"
                  density="compact"
                  :variant="searchCaseSensitive ? 'tonal' : 'text'"
                  :color="searchCaseSensitive ? 'primary' : undefined"
                  :title="translate(uiLang, 'scripting.search.caseSensitive')"
                  @click="searchCaseSensitive = !searchCaseSensitive"
                />
                <v-btn
                  icon="mdi-arrow-up"
                  size="small"
                  variant="text"
                  density="compact"
                  :disabled="matches.length === 0"
                  :title="translate(uiLang, 'scripting.search.prev')"
                  @click="goToPrevMatch"
                />
                <v-btn
                  icon="mdi-arrow-down"
                  size="small"
                  variant="text"
                  density="compact"
                  :disabled="matches.length === 0"
                  :title="translate(uiLang, 'scripting.search.next')"
                  @click="goToNextMatch"
                />
                <v-btn
                  icon="mdi-close"
                  size="small"
                  variant="text"
                  density="compact"
                  :title="translate(uiLang, 'scripting.search.close')"
                  @click="closeSearch"
                />
              </div>

              <!-- Replace Row -->
              <div v-if="showReplace" class="d-flex align-center ga-1 pl-7">
                <div class="ide-search-input-box">
                  <input
                    v-model="replaceQuery"
                    type="text"
                    class="ide-search-native-input font-family-mono"
                    :placeholder="translate(uiLang, 'scripting.search.replacePlaceholder')"
                    @keydown.enter="replaceCurrent"
                    @keydown.esc.stop="closeSearch"
                  />
                </div>
                <v-btn
                  icon="mdi-find-replace"
                  size="small"
                  variant="text"
                  density="compact"
                  :disabled="matches.length === 0"
                  :title="translate(uiLang, 'scripting.search.replace')"
                  @click="replaceCurrent"
                />
                <v-btn
                  icon="mdi-file-replace-outline"
                  size="small"
                  variant="text"
                  density="compact"
                  :disabled="matches.length === 0"
                  :title="translate(uiLang, 'scripting.search.replaceAll')"
                  @click="replaceAll"
                />
              </div>
            </div>
          </v-fade-transition>

          <div
            ref="lineNumbersRef"
            class="ide-gutter py-2 px-2 text-right unselectable font-family-mono text-caption on-surface-variant"
          >
            <div v-for="n in lineNumbers" :key="n" class="ide-line-no">{{ n }}</div>
          </div>

          <textarea
            ref="editorTextareaRef"
            v-model="scriptCode"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            class="ide-textarea pa-2 font-family-mono text-body-2"
            :placeholder="translate(uiLang, 'scripting.editor.placeholder')"
            @keydown="handleEditorKeyDown"
            @scroll="syncEditorScroll"
          />
        </div>

        <!-- Draggable Splitter Divider -->
        <div
          class="ide-splitter-handle d-flex align-center justify-center"
          :class="{ 'ide-splitter-active': isDraggingSplitter }"
          @mousedown="startSplitterDrag"
        >
          <div class="ide-splitter-bar" />
          <v-icon icon="mdi-drag-horizontal" size="small" class="opacity-40" />
          <div class="ide-splitter-bar" />
        </div>

        <!-- Lower Console Window -->
        <div
          class="ide-console-card d-flex flex-column overflow-hidden"
          :style="{ height: `${consoleHeight}px`, minHeight: `${MIN_CONSOLE_HEIGHT}px` }"
        >
          <!-- Console Toolbar -->
          <div
            class="d-flex align-center justify-space-between px-3 py-2 ide-console-topbar flex-wrap ga-2"
          >
            <div class="d-flex align-center ga-2">
              <span class="text-caption font-weight-bold">
                {{ translate(uiLang, 'scripting.console.title') }}
              </span>
              <v-chip
                :color="statusColor"
                variant="tonal"
                class="ide-status-chip font-weight-medium px-3"
              >
                <v-icon
                  v-if="status === 'running'"
                  icon="mdi-loading"
                  size="small"
                  class="animate-spin mr-1"
                />
                {{ statusLabel }}
              </v-chip>

              <span
                v-if="startedAt"
                class="text-caption on-surface-variant opacity-80 font-family-mono"
              >
                {{
                  translate(uiLang, 'scripting.console.duration').replace('{time}', durationText)
                }}
              </span>

              <span
                v-if="consoleLines.length > 0"
                class="text-caption on-surface-variant opacity-60 font-family-mono"
              >
                • {{ consoleLines.length }} {{ translate(uiLang, 'scripting.console.lines') }}
              </span>
            </div>

            <!-- Console Icon Tools (size="small" allowed for icons) -->
            <div class="d-flex align-center ga-1">
              <v-tooltip :text="translate(uiLang, 'scripting.console.autoScroll')" location="top">
                <template #activator="{ props }">
                  <v-btn
                    v-bind="props"
                    icon="mdi-arrow-collapse-down"
                    size="small"
                    variant="text"
                    :color="autoScroll ? 'primary' : undefined"
                    @click="autoScroll = !autoScroll"
                  />
                </template>
              </v-tooltip>

              <v-tooltip :text="translate(uiLang, 'scripting.console.copy')" location="top">
                <template #activator="{ props }">
                  <v-btn
                    v-bind="props"
                    icon="mdi-content-copy"
                    size="small"
                    variant="text"
                    @click="copyConsoleOutput"
                  />
                </template>
              </v-tooltip>

              <v-tooltip :text="translate(uiLang, 'scripting.console.clear')" location="top">
                <template #activator="{ props }">
                  <v-btn
                    v-bind="props"
                    icon="mdi-delete-sweep-outline"
                    size="small"
                    variant="text"
                    @click="clearConsole"
                  />
                </template>
              </v-tooltip>
            </div>
          </div>

          <!-- Progress Linear Indicator -->
          <v-progress-linear
            v-if="status === 'running' || progressValue !== null"
            :indeterminate="progressValue === null"
            :model-value="progressValue ?? undefined"
            color="primary"
            height="3"
          />

          <!-- Console Stream Output Body -->
          <div
            ref="consoleOutputRef"
            class="ide-console-output flex-grow-1 overflow-y-auto pa-3 font-family-mono text-caption"
          >
            <div
              v-if="consoleLines.length === 0"
              class="d-flex align-center justify-center fill-height on-surface-variant opacity-60 text-caption"
            >
              {{ translate(uiLang, 'scripting.console.empty') }}
            </div>

            <div
              v-for="line in consoleLines"
              :key="line.id"
              class="ide-console-line mb-0.5"
              :class="`line-type-${line.type}`"
            >
              <span class="line-time opacity-40 mr-1.5 unselectable">
                {{ new Date(line.time).toLocaleTimeString() }}
              </span>
              <span class="line-tag font-weight-bold mr-1.5 unselectable">[{{ line.type }}]</span>
              <span class="line-content">{{ line.text }}</span>
            </div>

            <!-- Return Value Preview -->
            <div v-if="hasReturnValue" class="ide-return-box pa-3 mt-2 rounded-lg">
              <div class="text-caption font-weight-bold text-success mb-1">
                {{ translate(uiLang, 'scripting.console.returnValue') }}
              </div>
              <pre class="font-family-mono text-caption overflow-x-auto">{{
                JSON.stringify(returnValue, null, 2)
              }}</pre>
            </div>
          </div>
        </div>
      </div>

      <!-- Right Area: Parameter Inspector Panel (DESIGN.md compliant card) -->
      <div v-if="showConfigDrawer" class="ide-config-panel rounded-lg">
        <!-- Config Panel Header -->
        <div class="d-flex align-center justify-space-between px-4 py-3 ide-config-topbar">
          <div class="d-flex align-center ga-2">
            <v-icon icon="mdi-tune" size="small" class="text-primary" />
            <span class="text-subtitle-2 font-weight-bold">
              {{ translate(uiLang, 'scripting.config.title') }}
            </span>
          </div>

          <div class="d-flex align-center ga-1">
            <v-tooltip :text="translate(uiLang, 'scripting.config.reset')" location="top">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  icon="mdi-restore"
                  size="small"
                  variant="text"
                  @click="resetConfigDefaults"
                />
              </template>
            </v-tooltip>
            <v-btn icon="mdi-close" size="small" variant="text" @click="showConfigDrawer = false" />
          </div>
        </div>

        <!-- Config Form Content -->
        <div class="ide-config-body pa-4 overflow-y-auto">
          <!-- Empty State -->
          <div
            v-if="!hasConfigFields"
            class="d-flex flex-column align-center text-center py-8 px-3 ga-3 on-surface-variant opacity-80"
          >
            <v-icon icon="mdi-tune-variant" size="36" class="opacity-40 mb-1" />
            <div class="text-subtitle-2 font-weight-bold">
              {{ translate(uiLang, 'scripting.config.noConfig') }}
            </div>
            <div class="text-caption opacity-75">
              {{ translate(uiLang, 'scripting.config.noConfigHint') }}
            </div>
            <v-btn
              variant="tonal"
              color="primary"
              class="text-none mt-2"
              prepend-icon="mdi-plus"
              @click="
                insertSnippet(
                  `\nexport const config = {\n  exampleParam: {\n    type: 'string',\n    label: '示例参数',\n    default: 'Hello'\n  }\n}\n`
                )
              "
            >
              {{ translate(uiLang, 'scripting.config.addConfig') }}
            </v-btn>
          </div>

          <!-- Dynamic Form Controls -->
          <div v-else class="d-flex flex-column ga-4">
            <div
              v-for="(def, key) in configSchema"
              :key="key"
              class="ide-config-field pa-3 rounded-lg"
            >
              <div class="d-flex align-center justify-space-between mb-1.5">
                <span class="text-subtitle-2 font-weight-bold">
                  {{ def.label || key }}
                </span>
                <span
                  v-if="def.type === 'slider'"
                  class="text-caption font-family-mono font-weight-bold text-primary px-2 py-0.5 rounded"
                  style="background: rgba(var(--v-theme-surface), 0.6)"
                >
                  {{ userConfigValues[key] ?? def.default ?? 0 }}
                </span>
                <span v-else class="text-caption font-family-mono opacity-50">{{ key }}</span>
              </div>
              <div v-if="def.description" class="text-caption on-surface-variant mb-2 opacity-75">
                {{ def.description }}
              </div>

              <!-- Boolean (Switch) -->
              <div v-if="def.type === 'boolean'" class="px-1 py-1">
                <v-switch
                  :model-value="Boolean(userConfigValues[key])"
                  color="primary"
                  density="comfortable"
                  hide-details
                  inset
                  :label="userConfigValues[key] ? '开启' : '关闭'"
                  @update:model-value="(val) => (userConfigValues[key] = val)"
                />
              </div>

              <!-- Select -->
              <v-select
                v-else-if="def.type === 'select'"
                :model-value="userConfigValues[key] as any"
                :items="def.options || []"
                item-title="label"
                item-value="value"
                density="comfortable"
                variant="outlined"
                hide-details
                rounded="lg"
                @update:model-value="(val) => (userConfigValues[key] = val)"
              />

              <!-- Slider -->
              <div v-else-if="def.type === 'slider'" class="px-1 pt-1 pb-1">
                <v-slider
                  :model-value="Number(userConfigValues[key] ?? def.default ?? 0)"
                  :min="def.min ?? 0"
                  :max="def.max ?? 100"
                  :step="def.step ?? 1"
                  color="primary"
                  density="comfortable"
                  hide-details
                  @update:model-value="(val) => (userConfigValues[key] = val)"
                />
              </div>

              <!-- Secret -->
              <v-text-field
                v-else-if="def.type === 'secret'"
                :model-value="String(userConfigValues[key] ?? '')"
                :type="showSecretMap[key] ? 'text' : 'password'"
                density="comfortable"
                variant="outlined"
                hide-details
                rounded="lg"
                :append-inner-icon="showSecretMap[key] ? 'mdi-eye-off' : 'mdi-eye'"
                @click:append-inner="showSecretMap[key] = !showSecretMap[key]"
                @update:model-value="(val) => (userConfigValues[key] = val)"
              />

              <!-- Path -->
              <v-text-field
                v-else-if="def.type === 'path'"
                :model-value="String(userConfigValues[key] ?? '')"
                density="comfortable"
                variant="outlined"
                hide-details
                rounded="lg"
                append-inner-icon="mdi-folder-open-outline"
                @click:append-inner="pickPathForField(String(key))"
                @update:model-value="(val) => (userConfigValues[key] = val)"
              />

              <!-- Number -->
              <v-text-field
                v-else-if="def.type === 'number'"
                :model-value="
                  userConfigValues[key] !== undefined ? Number(userConfigValues[key]) : undefined
                "
                type="number"
                :min="def.min"
                :max="def.max"
                :step="def.step"
                density="comfortable"
                variant="outlined"
                hide-details
                rounded="lg"
                @update:model-value="(val) => (userConfigValues[key] = Number(val))"
              />

              <!-- String -->
              <v-text-field
                v-else
                :model-value="String(userConfigValues[key] ?? '')"
                :placeholder="def.placeholder"
                density="comfortable"
                variant="outlined"
                hide-details
                rounded="lg"
                @update:model-value="(val) => (userConfigValues[key] = val)"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Toast Notification -->
    <v-snackbar v-model="toastVisible" :timeout="2000" location="bottom" rounded="lg">
      {{ toastText }}
    </v-snackbar>
  </div>
</template>

<style scoped>
.scripting-ide-root {
  position: absolute;
  top: 16px;
  bottom: 16px;
  left: 16px;
  right: 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-sizing: border-box;
}

.unselectable {
  user-select: none;
}

.font-family-mono {
  font-family: 'Noto Sans Mono CJK SC', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
}

/* Toolbar */
.ide-top-bar {
  flex: 0 0 auto;
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}

.ide-breadcrumb {
  background: rgba(var(--v-theme-surface), 0.5);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}

.ide-lang-toggle {
  height: 32px;
}

/* Main Workspace */
.ide-workspace-wrapper {
  flex: 1 1 0%;
  min-height: 0;
  height: 100%;
  display: flex;
  gap: 12px;
  overflow: hidden;
  padding-top: 6px;
}

.ide-main-pane {
  flex: 1 1 0%;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: rgba(var(--v-theme-surface), 0.4);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}

.ide-editor-topbar {
  flex: 0 0 36px;
  height: 36px;
  background: rgba(var(--v-theme-surface), 0.3);
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06);
}

.ide-code-wrapper {
  flex: 1 1 auto;
  min-height: 80px;
  position: relative;
  overflow: hidden;
  width: 100%;
}

.ide-gutter {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 48px;
  background: rgba(var(--v-theme-surface), 0.2);
  border-right: 1px solid rgba(var(--v-theme-on-surface), 0.06);
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  padding: 10px 0;
  line-height: 1.5rem;
}

.ide-line-no {
  height: 1.5rem;
  line-height: 1.5rem;
  text-align: right;
  padding-right: 10px;
}

.ide-textarea {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 48px;
  right: 0;
  width: calc(100% - 48px);
  height: 100%;
  padding: 10px;
  box-sizing: border-box;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  color: rgb(var(--v-theme-on-surface));
  line-height: 1.5rem;
  caret-color: rgb(var(--v-theme-primary));
  tab-size: 2;
  white-space: pre;
  overflow-y: auto;
  overflow-x: auto;
}

.ide-textarea::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.35);
}

/* Splitter */
.ide-splitter-handle {
  flex: 0 0 8px;
  height: 8px;
  cursor: row-resize;
  user-select: none;
  gap: 8px;
  background: rgba(var(--v-theme-surface), 0.25);
  transition: background 0.2s;
}

.ide-splitter-handle:hover,
.ide-splitter-active {
  background: rgba(var(--v-theme-primary), 0.25);
}

.ide-splitter-bar {
  flex: 1;
  height: 1px;
  background: rgba(var(--v-theme-on-surface), 0.12);
}

/* Console */
.ide-console-card {
  flex: 0 0 auto;
  min-height: 100px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: rgba(var(--v-theme-background), 0.7);
  border-top: 1px solid rgba(var(--v-theme-on-surface), 0.06);
}

.ide-console-topbar {
  flex: 0 0 40px;
  height: 40px;
  background: rgba(var(--v-theme-surface), 0.25);
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06);
}

.ide-status-chip {
  padding-block: 4px;
  min-height: 24px;
}

.ide-console-output {
  flex: 1 1 0%;
  min-height: 0;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.25);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}

/* Line Colors */
.line-type-system {
  color: rgb(var(--v-theme-primary));
}
.line-type-log {
  color: rgba(var(--v-theme-on-surface), 0.9);
}
.line-type-info {
  color: rgb(var(--v-theme-info));
}
.line-type-warn {
  color: rgb(var(--v-theme-warning));
}
.line-type-error,
.line-type-stderr {
  color: rgb(var(--v-theme-error));
}
.line-type-stdout {
  color: rgba(var(--v-theme-on-surface), 0.85);
}
.line-type-result {
  color: rgb(var(--v-theme-success));
}

.ide-return-box {
  background: rgba(var(--v-theme-surface), 0.5);
  border: 1px solid rgba(var(--v-theme-success), 0.3);
}

/* Right Config Inspector */
.ide-config-panel {
  flex: 0 0 320px;
  width: 320px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: rgba(var(--v-theme-surface), 0.4);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}

.ide-config-topbar {
  flex: 0 0 44px;
  height: 44px;
  background: rgba(var(--v-theme-surface), 0.3);
  border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.06);
}

.ide-config-body {
  flex: 1 1 0%;
  min-height: 0;
  overflow-y: auto;
  background: rgba(var(--v-theme-surface), 0.15);
}

.ide-config-field {
  background: rgba(var(--v-theme-surface), 0.3);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.06);
}

.script-menu-list {
  max-height: 380px;
  overflow-y: auto;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.animate-spin {
  animation: spin 1s linear infinite;
}

/* In-Editor Search & Replace Box */
.ide-search-box {
  position: absolute;
  top: 8px;
  right: 18px;
  z-index: 20;
  min-width: 320px;
  max-width: 440px;
  background: rgba(var(--v-theme-surface), 0.95);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.14);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(12px);
}

.ide-search-input-box {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  background: rgba(var(--v-theme-surface-variant), 0.35);
  border: 1px solid rgba(var(--v-theme-on-surface), 0.12);
  border-radius: 6px;
  padding: 2px 8px;
  min-height: 28px;
  transition: border-color 0.2s;
}

.ide-search-input-box:focus-within {
  border-color: rgb(var(--v-theme-primary));
}

.ide-search-native-input {
  flex: 1 1 auto;
  background: transparent;
  border: none;
  outline: none;
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.8125rem;
  line-height: 1.4;
  min-width: 60px;
}

.ide-search-native-input::placeholder {
  color: rgba(var(--v-theme-on-surface), 0.38);
}

.search-count-text {
  flex-shrink: 0;
  white-space: nowrap;
  font-size: 0.75rem;
  padding-left: 6px;
  user-select: none;
}

.rotate-180 {
  transform: rotate(180deg);
}
</style>
