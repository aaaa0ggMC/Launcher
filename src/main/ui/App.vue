<script setup lang="ts">
import {
  computed,
  provide,
  ref,
  shallowRef,
  markRaw,
  onMounted,
  onBeforeUnmount,
  watch,
  nextTick
} from 'vue'
import { useTheme } from 'vuetify'
import {
  applyUiScale as applyUiScaleFromConfig,
  applyFont as applyFontFromConfig
} from './appearance'
import type { Ability } from './ability'
import {
  getAbilityModules,
  resolveSidebarAbilities,
  buildSettingsSections,
  subscribeAbilityChanges,
  useDisabledAbilities,
  applyDisabledAbilities
} from './ability-registry'
import type { SettingsCategory, AbilityLoadReport } from './ability-registry'
import AbilityIcon from './components/AbilityIcon.vue'
import GameIcon from './components/GameIcon.vue'
import BackgroundTasksDialog from './components/BackgroundTasksDialog.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import HelpDialog from './components/HelpDialog.vue'
import { SETTINGS_API, normalizeTarget, type SettingsApi } from './composables/settings'
import BackgroundLayer from './components/BackgroundLayer.vue'
import FuseLayer from './components/FuseLayer.vue'
import AgentBar from './components/AgentBar.vue'
import { resolveAgentUi } from './composables/agentUi'
import AgentActivityOverlay from './components/AgentActivityOverlay.vue'
import { fileIconUrl } from './icon'
import { translate, translateTemplate } from './i18n'
import { resolveSchemeId } from './color_schemes'
import { filterByQuery, scoreFields, fields } from './composables/search'
import { getAllQuickActions, type QuickAction } from './quick-actions'
import { PAGE_TRANSITIONS } from './animations'
import type { HelpTreeResult } from '@shared/types'

// ---------------------------------------------------------------------------
// Ability loader: `src/abilities/index.ts` globs every ability's orchestrator
// (index.ts carries metadata only; the heavy View.vue loads on first show as
// an async component). Abilities are self-injecting: platform-filtered and
// alphabetically ordered here (category then name), no yaml/manifest order.
// This frame consumes the loaded registry and exposes it back to abilities for
// cross-scope control (see provide('cockpit:abilities')).
// ---------------------------------------------------------------------------
const sidebarReport = ref<AbilityLoadReport>(resolveSidebarAbilities(window.cockpit.platform))

interface SidebarAbility {
  id: string
  config: Record<string, unknown>
  name: string
  icon: string | null
  category: string
  keepAlive: boolean
  /** source folder under `abilities/` — the help namespace. */
  folder: string
  comp: Ability['component']
}

const runtimeConfig = ref<Record<string, unknown>>({})
const theme = useTheme()

const drawer = ref(true)
const rail = ref(true)
const searchText = ref('')
const currentId = ref<string | null>(null)
const isMaximized = ref(false)

function winMinimize(): void {
  window.cockpit.windowMinimize()
}
async function winToggleMaximize(): Promise<void> {
  isMaximized.value = await window.cockpit.windowToggleMaximize()
}

/**
 * AI 视图模式：主进程为每个 agent 会话开一个独立渲染进程，加载同一个 App（`?agent=<会话>&name=<客户端>`）。
 * 这个实例是 agent 的「工作台」：不写用户的界面状态 / 使用统计、不显示 AI 图标条。
 * 它可能在后台（1×1 宿主）、盖在用户的主窗口上（`main`，自带无边框外壳 + 「返回我的界面」）
 * 或在单独窗口里（`window`）——主进程经 `cockpit:agent-host` 告知。
 */
const agentView = (() => {
  const q = new URLSearchParams(window.location.search)
  const id = q.get('agent')
  return id ? { id, name: q.get('name') ?? '' } : null
})()
const agentHost = ref<'background' | 'main' | 'window'>('background')
/** 视图盖在用户主窗口上：用户靠这个实例里的按钮返回 / 关闭 */
const agentEmbedded = computed(() => !!agentView && agentHost.value === 'main')

function winClose(): void {
  // 盖在主窗口上时，关闭 = 先回到用户自己的界面，再由主窗口走它的关闭确认（后台任务提示等）
  if (agentEmbedded.value) void window.cockpit.agentViewControl('close-app')
  else window.cockpit.windowClose()
}
function agentBack(): void {
  void window.cockpit.agentViewControl('back')
}

/** Window prefs come from config.json (settings → 显示), applied on next launch. */
const isFrameless = computed(
  () =>
    // agent 视图的宿主始终无边框，外壳（窗口按钮）由 App 自己画
    !!agentView ||
    (runtimeConfig.value.window as { frameless?: boolean } | undefined)?.frameless !== false
)
const windowRounded = computed(
  () =>
    isFrameless.value &&
    (runtimeConfig.value.window as { rounded?: boolean } | undefined)?.rounded !== false &&
    !isMaximized.value
)

/** Window corner radius (px) — mirrors window.radius config; default 12. */
const windowRadius = computed(
  () => (runtimeConfig.value.window as { radius?: number } | undefined)?.radius ?? 12
)

/** Current active language from config. */
const agentUi = computed(() =>
  resolveAgentUi((runtimeConfig.value.agent as { ui?: unknown } | undefined)?.ui)
)
const lang = computed(() => (runtimeConfig.value.language as string) ?? 'zh')
provide('cockpit:lang', lang)

function t(key: string, fallback?: string): string {
  return translate(lang.value, key, fallback)
}
function te(key: string, vars: Record<string, string>, fallback?: string): string {
  return translateTemplate(lang.value, key, vars, fallback)
}

/** Sidebar icons: fill the rail in collapsed mode, larger in expanded. */
const sidebarIconSize = computed(() => (rail.value ? 32 : 28))

// ---------------------------------------------------------------------------
// Copy current view as markdown (for pasting into an AI etc.)
// ---------------------------------------------------------------------------
const abilityRef = ref<{
  $el?: Element
  toMarkdown?: () => string
  onActivate?: (target: unknown) => void
} | null>(null)
const copySnackOpen = ref(false)
const copySnackText = ref('')
const commandErrorOpen = ref(false)
const commandErrorText = ref('')

// ---------------------------------------------------------------------------
// Help dialog — renders the current ability's `help/` markdown (help.tree /
// help.read commands). Abilities without a help folder just get a notice.
// ---------------------------------------------------------------------------
const helpOpen = ref(false)
const helpAbility = ref<{ id: string; name: string; folder: string; icon: string | null } | null>(
  null
)
const helpTree = ref<HelpTreeResult | null>(null)
const helpSnackOpen = ref(false)
const helpSnackText = ref('')

/** Open help for the active ability; notify instead when it ships none. */
async function openHelp(): Promise<void> {
  const a = currentAbility.value
  if (!a) return
  try {
    const r = (await window.cockpit.command('help.tree', {
      ability: a.folder,
      lang: lang.value
    })) as HelpTreeResult | null
    if (!r?.hasHelp) {
      helpSnackText.value = te('help.none', { name: a.name }, `「${a.name}」暂无使用帮助`)
      helpSnackOpen.value = true
      return
    }
    helpTree.value = r
    helpAbility.value = { id: a.id, name: a.name, folder: a.folder, icon: a.icon }
    helpOpen.value = true
  } catch {
    helpSnackText.value = t('help.loadFailed', '无法加载帮助内容')
    helpSnackOpen.value = true
  }
}

/** Re-fetch the help tree in the new language if the help dialog is open. */
watch(lang, async () => {
  if (!helpOpen.value || !helpAbility.value) return
  try {
    const r = (await window.cockpit.command('help.tree', {
      ability: helpAbility.value.folder,
      lang: lang.value
    })) as HelpTreeResult | null
    if (r?.hasHelp) helpTree.value = r
  } catch {
    /* noop */
  }
})

// ---------------------------------------------------------------------------
// Background tasks (framework-level global panel)
// ---------------------------------------------------------------------------
const btOpen = ref(false)
const btRunning = ref(0)

/** Badge label: active running-task count, capped at "99+". */
const btBadge = computed(() => (btRunning.value > 99 ? '99+' : String(btRunning.value)))

/** Update the running-task badge from a `cockpit:bt` changed event. */
function onBtEvent(raw: unknown): void {
  const evt = raw as { type?: string; tasks?: { status?: string }[] } | null
  if (evt?.type === 'changed' && Array.isArray(evt.tasks)) {
    btRunning.value = evt.tasks.filter((x) => x.status === 'running').length
  }
}

// ---------------------------------------------------------------------------
// Quit confirmation — warn when background tasks are still running.
// ---------------------------------------------------------------------------
const quitConfirmOpen = ref(false)
const quitCount = ref(0)
const quitSuppress = ref(false)
const QUIT_SUPPRESS_KEY = 'cockpit-bt-quit-suppress'

/** Main asked whether it's OK to close despite running tasks. */
function onQuitConfirm(raw: unknown): void {
  const n = Number((raw as number) ?? 0)
  // If suppressed (or nothing running), close immediately.
  if (quitSuppress.value || n <= 0) {
    void window.cockpit.confirmWindowClose()
    return
  }
  quitCount.value = n
  quitConfirmOpen.value = true
}

function doConfirmQuit(): void {
  localStorage.setItem(QUIT_SUPPRESS_KEY, quitSuppress.value ? '1' : '0')
  quitConfirmOpen.value = false
  void window.cockpit.confirmWindowClose()
}

/** Generic DOM→markdown extraction of the current ability view. */
function viewToMarkdown(root: Element): string {
  const out: string[] = []
  const emit = (line: string): void => {
    const t = line.trim()
    if (t && out[out.length - 1] !== t) out.push(t)
  }
  const walk = (el: Element): void => {
    if (el instanceof HTMLElement && el.offsetParent === null && !el.closest('.v-dialog')) return
    if (
      el.matches(
        'button,a,input,textarea,select,[role="button"],.v-btn,.v-overlay,.v-menu,.v-slider,.v-switch'
      )
    )
      return
    const cls = typeof el.className === 'string' ? el.className : ''
    const hCls = /(?:^|\s)text-h([1-6])\b/.exec(cls)
    const isH = /^H[1-6]$/.test(el.tagName)
    if (hCls || isH) {
      const lvl = hCls ? Number(hCls[1]) : Number(el.tagName[1])
      const text = (el.textContent ?? '').trim()
      if (text) emit(`${'#'.repeat(Math.min(lvl + 1, 6))} ${text}`)
      return
    }
    if (el.matches('.v-card-title')) {
      const text = (el.textContent ?? '').trim()
      if (text) emit(`### ${text}`)
      return
    }
    if (el.matches('.v-list-item,li')) {
      const text = (el.textContent ?? '').trim()
      if (text) emit(`- ${text}`)
      return
    }
    if (el.children.length === 0) {
      const text = (el.textContent ?? '').trim()
      if (text) emit(text)
      return
    }
    for (const c of Array.from(el.children)) walk(c)
  }
  walk(root)
  return out.join('\n')
}

async function copyCurrentView(): Promise<void> {
  const ability = currentAbility.value
  if (!ability) return
  let md: string
  const inst = abilityRef.value
  if (inst && typeof inst.toMarkdown === 'function') {
    md = inst.toMarkdown()
  } else if (inst?.$el) {
    md = viewToMarkdown(inst.$el)
  } else {
    md = t('copy.failed')
  }
  const header = `# ${ability.name}\n\n> ${t('copy.exported')} · ${new Date().toLocaleString(lang.value)}\n\n`
  await window.cockpit.copyText(header + md)
  copySnackText.value = te('copy.copied', { name: ability.name })
  copySnackOpen.value = true
}

const UI_STATE_KEY = 'cockpit-ui-state'

function persistUiState(): void {
  if (agentView) return // 不覆盖用户的「上次停留页面」
  localStorage.setItem(
    UI_STATE_KEY,
    JSON.stringify({ rail: rail.value, currentId: currentId.value })
  )
}

function restoreUiState(): void {
  if (agentView) return // AI 视图从默认页面起步
  try {
    const raw = localStorage.getItem(UI_STATE_KEY)
    if (!raw) return
    const s = JSON.parse(raw)
    if (typeof s.rail === 'boolean') rail.value = s.rail
    if (typeof s.currentId === 'string') currentId.value = s.currentId
  } catch {
    // ignore corrupt state
  }
}

/** Sidebar sort rules — `config.json` `sidebar.sort`: 'alpha' (default,
 * category+name), 'frequency' (use count desc), 'recent' (last-used desc),
 * 'custom' (user custom order in sidebar-order.json). */
type SidebarSort = 'alpha' | 'frequency' | 'recent' | 'custom'
const sortMode = computed<SidebarSort>(() => {
  const s = (runtimeConfig.value.sidebar as { sort?: string } | undefined)?.sort
  return s === 'frequency' || s === 'recent' || s === 'custom' ? s : 'alpha'
})

/** Custom order loaded from sidebar-order.json */
const customOrder = ref<string[]>([])
async function loadSidebarOrder(): Promise<void> {
  try {
    const r = (await window.cockpit.command('sidebar.order.get').catch(() => null)) as {
      ok?: boolean
      order?: string[]
    } | null
    if (Array.isArray(r?.order)) {
      customOrder.value = r.order
    }
  } catch {
    /* noop */
  }
}

watch(
  sortMode,
  (mode) => {
    if (mode === 'custom') {
      void loadSidebarOrder()
    }
  },
  { immediate: true }
)

/** Per-entry usage stats from apps.csv (sidebar frequency / recent rules). */
const usageStats = ref<Record<string, { count: number; lastUsed: number }>>({})
async function loadUsage(): Promise<void> {
  const r = (await window.cockpit.command('stats.list')) as {
    ok?: boolean
    stats?: Record<string, { count: number; lastUsed: number }>
  } | null
  usageStats.value = r?.stats ?? {}
}
/** Record a sidebar-entry open / app launch; used by frequency + recent sorts. */
function recordOpen(id: string): void {
  if (agentView) return // AI 的导航不计入用户的使用频次
  void window.cockpit.command('stats.record', { id })
}

const abilities = computed<SidebarAbility[]>(() => {
  const mode = sortMode.value
  const score = (a: SidebarAbility): number => {
    const u = usageStats.value[a.id]
    return mode === 'recent' ? (u?.lastUsed ?? 0) : (u?.count ?? 0)
  }
  const order = customOrder.value
  return sidebarReport.value.loaded
    .map((meta) => ({
      id: meta.id,
      config: {} as Record<string, unknown>,
      name: t(`ability.${meta.id}.name`, meta.name),
      icon: meta.icon ?? null,
      category: t(`ability.${meta.id}.category`, meta.category),
      keepAlive: meta.keepAlive !== false,
      folder: meta.folder,
      comp: meta.component ? markRaw(meta.component) : undefined
    }))
    .sort((a, b) => {
      if (mode === 'custom') {
        const idxA = order.indexOf(a.id)
        const idxB = order.indexOf(b.id)
        const posA = idxA === -1 ? 999999 : idxA
        const posB = idxB === -1 ? 999999 : idxB
        if (posA !== posB) return posA - posB
        return a.name.localeCompare(b.name, lang.value)
      }
      if (mode !== 'alpha') {
        const d = score(b) - score(a)
        if (d !== 0) return d
      }
      const c = a.category.localeCompare(b.category, lang.value)
      return c !== 0 ? c : a.name.localeCompare(b.name, lang.value)
    })
})

const currentAbility = computed(() => abilities.value.find((a) => a.id === currentId.value) ?? null)

/**
 * 页面就绪标记（`data-ability-ready`）：能力页面是异步组件（按需加载），切换后要等代码加载完、
 * 挂载、过渡结束才算可用。inspector 的 ui.navigate / ui.snapshot 等这个标记，避免在空白占位上
 * 拍快照（加载期间 DOM 没变化，单靠「DOM 安静」判断不出来）。
 */
const readyAbility = ref('')
let readySeq = 0
watch(
  () => currentAbility.value,
  async (a) => {
    const seq = ++readySeq
    readyAbility.value = ''
    if (!a) return
    const loader = (a.comp as { __asyncLoader?: () => Promise<unknown> } | undefined)?.__asyncLoader
    try {
      await loader?.()
    } catch {
      /* load failure surfaces in the page itself */
    }
    await nextTick()
    // out-in 页面过渡：等新页面进入后再标记（动画关闭时立即完成）
    await new Promise((r) => setTimeout(r, pageTransitionName.value ? 350 : 0))
    if (seq === readySeq) readyAbility.value = a.id
  },
  { immediate: true }
)

/**
 * Ability switch transition (设置 → 外观 → 界面动画). Empty name = off
 * (instant swap); otherwise the CSS class prefix for the active style.
 */
const pageTransitionName = computed(() => {
  const a =
    (runtimeConfig.value.animations as
      { enabled?: boolean; pageTransition?: string; modernMotion?: boolean } | undefined) ?? {}
  // 现代动效 is the master switch: off → no page-switch motion either.
  if (a.modernMotion === false || a.enabled === false) return ''
  const known = PAGE_TRANSITIONS.some((t) => t.key === a.pageTransition)
  return `page-${known ? a.pageTransition : 'fade'}`
})

/**
 * Settings injection list — built from the same ability modules the sidebar
 * uses, then provided to the settings page so it never re-scans.
 */
const settingsSections = computed<SettingsCategory[]>(() =>
  buildSettingsSections(
    [
      ...abilities.value,
      // backend-only abilities (no page) can still inject settings (e.g. agent)
      ...sidebarReport.value.backendEligible.map((a) => ({
        id: a.id,
        name: t(`ability.${a.id}.name`, a.name),
        category: t(`ability.${a.id}.category`, a.category)
      }))
    ],
    getAbilityModules()
  )
)
// keep-alive caches only abilities that opted in (keepAlive !== false).
// Each cached page must declare a matching name via defineOptions.
const keepAliveNames = computed(() =>
  abilities.value.filter((a) => a.keepAlive).map((a) => `cockpit-${a.id}`)
)

const filteredAbilities = computed(() => {
  const q = searchText.value.trim()
  if (!q) return abilities.value
  return filterByQuery(abilities.value, q, (a) => [
    { text: a.name.toLowerCase(), weight: 3 },
    { text: a.id.toLowerCase(), weight: 2 },
    { text: a.category.toLowerCase(), weight: 1 }
  ])
})

interface Group {
  label: string
  items: SidebarAbility[]
}

const groups = computed<Group[]>(() => {
  const map = new Map<string, SidebarAbility[]>()
  for (const a of filteredAbilities.value) {
    const list = map.get(a.category) ?? []
    list.push(a)
    map.set(a.category, list)
  }
  const arr = [...map.entries()].map(([label, items]) => ({ label, items }))
  if (sortMode.value !== 'alpha') {
    // Keep category grouping; order the groups by their entries' usage.
    const score = (g: Group): number => {
      if (sortMode.value === 'recent')
        return Math.max(0, ...g.items.map((a) => usageStats.value[a.id]?.lastUsed ?? 0))
      return g.items.reduce((s, a) => s + (usageStats.value[a.id]?.count ?? 0), 0)
    }
    arr.sort((x, y) => score(y) - score(x))
  }
  return arr
})

// ---------------------------------------------------------------------------
// Theme + UI zoom from config.json
// ---------------------------------------------------------------------------
const prefersDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches

/** 设置 → 外观 → 现代动效. Gates theme-tear + page transitions. */
function modernMotionEnabled(): boolean {
  const a = (runtimeConfig.value.animations as { modernMotion?: boolean } | undefined) ?? {}
  return a.modernMotion !== false
}

/**
 * Toggle a `motion-off` class on <html>. global.css uses it to neuter every
 * remaining CSS transition/animation app-wide (hover lifts, drawer items,
 * Vuetify internals) so "现代动效 关" really means no motion anywhere.
 */
function applyMotionClass(): void {
  if (modernMotionEnabled()) document.documentElement.classList.remove('motion-off')
  else document.documentElement.classList.add('motion-off')
}

function applyWindowRounded(): void {
  // Teleported overlays (v-dialog scrim) live on <body>, outside .win-rounded's
  // clip-path, so their full-screen colored scrim paints over the transparent
  // window corners → square corners on light backgrounds. Mirror the flag on
  // <body> so global.css can clip every overlay scrim to the same radius.
  // The radius itself is exposed as a CSS variable so window + scrim always
  // agree, and both follow the configured window.radius.
  document.documentElement.style.setProperty('--win-radius', `${windowRadius.value}px`)
  if (windowRounded.value) document.body.classList.add('win-rounded-body')
  else document.body.classList.remove('win-rounded-body')
}

/**
 * Apply the resolved scheme id. When 「现代动效」is on, the color swap is
 * wrapped in the View Transitions API and revealed with an accelerating
 * ripple that expands from the top-left corner to cover the whole area (see
 * the `::view-transition-*` rules in global.css). When off, swap instantly.
 */
function applyTheme(): void {
  const t = (runtimeConfig.value.theme as string) ?? null
  const resolved = resolveSchemeId(t, prefersDark())
  if (theme.name.value === resolved) return
  if (modernMotionEnabled() && typeof document.startViewTransition === 'function') {
    // Reveal origin: 'corner' (top-left, default) or 'cursor' (last pointer).
    const a = (runtimeConfig.value.animations as Record<string, unknown>) ?? {}
    const origin = a.themeTransition === 'cursor' ? lastPointer : { x: 0, y: 0 }
    document.documentElement.style.setProperty('--vt-origin-x', `${origin.x}px`)
    document.documentElement.style.setProperty('--vt-origin-y', `${origin.y}px`)
    const vt = document.startViewTransition(async () => {
      theme.change(resolved)
      await nextTick()
    })
    // A second theme change mid-transition skips the running one; swallowing
    // the rejection keeps the UI responsive instead of surfacing an error.
    vt.finished.catch(() => {})
  } else {
    theme.change(resolved)
  }
}

function applyUiScale(): void {
  applyUiScaleFromConfig(runtimeConfig.value.uiScale)
}

function applyFont(): void {
  applyFontFromConfig(runtimeConfig.value.font)
}

function onConfigChanged(cfg: Record<string, unknown> | null): void {
  runtimeConfig.value = cfg ?? {}
  applyTheme()
  applyMotionClass()
  applyWindowRounded()
  applyUiScale()
  applyFont()
  resolveBackgroundImage()
}

// ---------------------------------------------------------------------------
// Background / Fuse / Data layers — configurable via settings → 窗口
// ---------------------------------------------------------------------------
const backgroundMode = computed<'transparent' | 'image' | 'wallpaper'>(() => {
  const b =
    (runtimeConfig.value.window as { background?: string } | undefined)?.background ?? 'transparent'
  return (b === 'image' || b === 'wallpaper' ? b : 'transparent') as
    'transparent' | 'image' | 'wallpaper'
})
const fuseAlpha = computed(() => {
  const a = Number((runtimeConfig.value.window as { fuseAlpha?: number } | undefined)?.fuseAlpha)
  return Number.isFinite(a) ? a : 1
})
const fuseBlur = computed(() => {
  const b = Number((runtimeConfig.value.window as { fuseBlur?: number } | undefined)?.fuseBlur)
  return Number.isFinite(b) ? b : 28
})
const backgroundOpacity = computed(() => {
  const o = Number(
    (runtimeConfig.value.window as { backgroundOpacity?: number } | undefined)?.backgroundOpacity
  )
  return Number.isFinite(o) ? o : 1
})
const backgroundImage = ref('')

/** Resolve the background image for `image` / `wallpaper` presets. */
async function resolveBackgroundImage(): Promise<void> {
  const winCfg = runtimeConfig.value.window as { backgroundImage?: string } | undefined
  if (backgroundMode.value === 'transparent') {
    backgroundImage.value = ''
    return
  }
  if (backgroundMode.value === 'image') {
    // user-set image; nothing if no path configured
    backgroundImage.value = winCfg?.backgroundImage ? fileIconUrl(winCfg.backgroundImage) : ''
    return
  }
  // `wallpaper`: auto-resolve the KDE desktop wallpaper
  const wp = await window.cockpit.getWallpaper()
  backgroundImage.value = wp ? fileIconUrl(wp) : ''
}

let configUnsub: (() => void) | null = null
let navigateUnsub: (() => void) | null = null
function subscribeConfig(): void {
  configUnsub = window.cockpit.on('cockpit:config-changed', (cfg) => {
    if (cfg && typeof cfg === 'object') onConfigChanged(cfg as Record<string, unknown>)
  })
  // `ui.navigate`（inspector）：等价于点击侧栏条目；只接受侧栏里存在的能力
  navigateUnsub = window.cockpit.on('cockpit:navigate', (id) => {
    if (typeof id === 'string' && abilities.value.some((a) => a.id === id)) openAbility(id)
  })
}

/** Re-apply the theme when the OS color scheme flips (system mode). */
let schemeMedia: MediaQueryList | null = null
function onSchemeChange(): void {
  applyTheme()
}
function subscribeSchemeMedia(): void {
  if (typeof window.matchMedia !== 'function') return
  schemeMedia = window.matchMedia('(prefers-color-scheme: dark)')
  if (typeof schemeMedia.addEventListener === 'function') {
    schemeMedia.addEventListener('change', onSchemeChange)
  } else {
    ;(schemeMedia as MediaQueryList & { addListener?: (fn: () => void) => void }).addListener?.(
      onSchemeChange
    )
  }
}

// Command-not-found toast: the main process broadcasts the exact command name
// when a UI call references a command whose backing ability was removed.
let commandErrorUnsub: (() => void) | null = null
function subscribeCommandErrors(): void {
  commandErrorUnsub = window.cockpit.on('cockpit:command-error', (name) => {
    commandErrorText.value = te('commandError.notFound', { name: String(name) })
    commandErrorOpen.value = true
  })
}

// ---------------------------------------------------------------------------
// Ability activation — quick-launch is generic. Clicking a quick action just
// navigates to the owning ability page and hands its view an opaque `target`
// (the ability's `onActivate` decides what it means and owns its own
// confirm/transformer UI). The shell never interprets ability payloads.
// ---------------------------------------------------------------------------
const pendingActivate = ref<{ ability: string; target: Record<string, unknown> } | null>(null)

function deliverActivate(
  inst: { onActivate?: (target: unknown) => void } | null,
  target: Record<string, unknown>
): void {
  inst?.onActivate?.(target)
}

/** Navigate to an ability from the sidebar; records the open for frequency /
 * recent sorting. */
function openAbility(id: string): void {
  if (id !== currentId.value) recordOpen(id)
  currentId.value = id
}

function activate(abilityId: string, target: Record<string, unknown>): void {
  if (currentId.value !== abilityId) {
    recordOpen(abilityId)
    pendingActivate.value = { ability: abilityId, target }
    currentId.value = abilityId
    // Fallback: if the ref-watch missed the mount (transition timing), retry
    // once shortly after navigation. Idempotent — only delivers while the
    // request is still pending and a real view is mounted.
    setTimeout(() => {
      const p = pendingActivate.value
      if (p && currentId.value === p.ability && abilityRef.value) {
        pendingActivate.value = null
        deliverActivate(abilityRef.value, p.target)
      }
    }, 600)
    return
  }
  deliverActivate(abilityRef.value, target)
}

// Deliver a pending activation once the target ability's view has actually
// mounted. NOTE: with the out-in page transition `abilityRef` passes through
// null (old leaves) before the new view enters — never consume the pending
// request on that null hop, or the activation is lost.
watch(abilityRef, (inst) => {
  const p = pendingActivate.value
  if (p && inst && currentId.value === p.ability) {
    pendingActivate.value = null
    deliverActivate(inst, p.target)
  }
})

// ---------------------------------------------------------------------------
// Search: filter sidebar abilities + surface ability-registered quick actions
// ---------------------------------------------------------------------------
const searchQuick = shallowRef<QuickAction[]>([])
const searchBusy = ref(false)

// -- quick-launch context menu: right-click a search result to pick an action
const ctxMenuOpen = ref(false)
const ctxMenuEl = ref<HTMLElement | null>(null)
const ctxAction = shallowRef<QuickAction | null>(null)

function openCtxMenu(e: MouseEvent, action: QuickAction): void {
  ctxMenuEl.value = e.currentTarget as HTMLElement
  ctxAction.value = action
  ctxMenuOpen.value = true
}

/** Menu items: the action itself (main launch) + any registered children. */
const ctxMenuItems = computed<QuickAction[]>(() => {
  const a = ctxAction.value
  if (!a) return []
  return [a, ...(a.children ?? [])]
})

function runQuickAction(action: QuickAction): void {
  ctxMenuOpen.value = false
  activate(action.ability, action.target)
}

async function openFirstQuickAction(): Promise<void> {
  const query = searchText.value.trim()
  if (!query) return
  await loadSearchQuick()
  if (searchText.value.trim() !== query) return
  const first = searchQuick.value[0]
  if (first) runQuickAction(first)
}

/**
 * Debounce search input: keystrokes only schedule a fetch; the actual (possibly
 * IO-heavy) provider query runs after the user pauses. This keeps per-keystroke
 * cost near-zero regardless of how heavy a registered search provider is.
 */
let searchDebounce: ReturnType<typeof setTimeout> | null = null
const SEARCH_DEBOUNCE_MS = 200

function scheduleSearchApps(): void {
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => {
    void loadSearchQuick()
    searchDebounce = null
  }, SEARCH_DEBOUNCE_MS)
}

async function loadSearchQuick(): Promise<void> {
  if (!searchText.value.trim()) {
    searchQuick.value = []
    return
  }
  searchBusy.value = true
  try {
    const all = await getAllQuickActions()
    const scored: { q: QuickAction; score: number }[] = []
    for (const q of all) {
      const score = scoreFields(
        searchText.value,
        fields(q.label, q.description ?? '', q.id).concat(
          (q.keywords ?? []).map((k) => ({ text: k.toLowerCase(), weight: 1 }))
        )
      )
      if (score > 0) scored.push({ q, score })
    }
    searchQuick.value = scored
      .sort((x, y) => y.score - x.score)
      .slice(0, 12)
      .map((x) => x.q)
  } finally {
    searchBusy.value = false
  }
}

// ---------------------------------------------------------------------------
// Provide ability context (config + cross-ability activation)
// ---------------------------------------------------------------------------
const abilityConfigs = computed(() => {
  const m: Record<string, Record<string, unknown>> = {}
  for (const a of abilities.value) m[a.id] = a.config
  return m
})

provide('cockpit:config', runtimeConfig)
provide('cockpit:settings', settingsSections)

// ---------------------------------------------------------------------------
// useSettings().open(...) — jump to an ability's own settings category. With
// the settings page present → navigate there; without it (removed / disabled)
// → show that ability's injected settings in a dialog, so abilities never
// depend on the settings ability existing.
// ---------------------------------------------------------------------------
const settingsDialog = ref<{
  open: boolean
  categories: SettingsCategory[]
  highlight: string | null
}>({ open: false, categories: [], highlight: null })
const hasSettingsPage = computed(() => abilities.value.some((a) => a.id === 'settings'))
const settingsApi: SettingsApi = {
  has: (ability, category) =>
    settingsSections.value.some(
      (c) => c.abilityId === ability && (!category || c.id === `${ability}.${category}`)
    ),
  open: (raw) => {
    const target = normalizeTarget(raw)
    const cats = settingsSections.value.filter((c) => c.abilityId === target.ability)
    const category = target.category
      ? cats.find((c) => c.id === `${target.ability}.${target.category}`)
      : cats[0]
    if (!category) return 'none'
    const item = target.item ? `${category.id}.${target.item}` : undefined
    if (hasSettingsPage.value) {
      activate('settings', { category: category.id, ...(item ? { item } : {}) })
      return 'page'
    }
    settingsDialog.value = {
      open: true,
      categories: target.category ? [category] : cats,
      highlight: item ?? null
    }
    return 'dialog'
  }
}
provide(SETTINGS_API, settingsApi)
// Ability 可调用以打开全局面板 (BackgroundTasksDialog)，如后台任务已在运行。
provide('cockpit:open-bt', (): void => {
  btOpen.value = true
})
// Cross-scope exposure: every ability can reach the full loaded registry
// (sidebar list, configs, activation, command list) via this single key.
provide('cockpit:abilities', {
  list: abilities,
  current: currentAbility,
  configs: abilityConfigs,
  activate,
  listCommands: (): Promise<{ name: string; description: string; usage?: string }[]> =>
    window.cockpit.listCommands()
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let unsub: (() => void) | null = null
let winUnsub: (() => void) | null = null
let btUnsub: (() => void) | null = null
let quitUnsub: (() => void) | null = null
let usageUnsub: (() => void) | null = null
let hostUnsub: (() => void) | null = null
let coverUnsub: (() => void) | null = null
/** 有 AI 视图盖在本窗口上：本窗口的标题栏拖拽区要关掉，否则会吞掉上层视图里的按钮点击 */
const agentCovered = ref(false)
let abilityUnsub: (() => void) | null = null
let orderUnsub: (() => void) | null = null

/** Pull the authoritative disabled set from the main process (a renderer reload
 *  must not resurrect abilities that were disabled earlier this session). */
async function loadAbilityStates(): Promise<void> {
  try {
    const r = (await window.cockpit.command('ability.list')) as {
      ok?: boolean
      disabled?: string[]
    } | null
    if (r?.ok && Array.isArray(r.disabled)) {
      applyDisabledAbilities(r.disabled.map(String))
    }
  } catch {
    /* noop */
  }
}

/** Re-resolve the sidebar when the disabled set changes; bail out of a page
 *  that was just disabled (its component stays cached, but no longer reachable). */
watch(
  () => useDisabledAbilities.value,
  () => {
    sidebarReport.value = resolveSidebarAbilities(window.cockpit.platform)
    if (currentId.value && !abilities.value.some((a) => a.id === currentId.value)) {
      currentId.value = abilities.value[0]?.id ?? null
    }
  }
)

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  onConfigChanged(cfg)
  // Default page comes from config.json (sidebar.default); fall back to the
  // first ability in the active sort order when missing/invalid (or no config).
  const def = (cfg as Record<string, unknown> | null)?.sidebar?.['default'] ?? null
  const fallback = abilities.value[0]?.id ?? null
  const valid = (id: string | null): boolean => !!id && abilities.value.some((a) => a.id === id)
  if (!valid(currentId.value)) currentId.value = valid(def) ? def : fallback
  restoreUiState()
  unsub = window.cockpit.on('cockpit:apps-changed', () => {
    if (searchDebounce) {
      clearTimeout(searchDebounce)
      searchDebounce = null
    }
    void loadSearchQuick()
  })
  // Usage stats drive the sidebar frequency / recent sort; reload on change
  // so a click re-sorts the sidebar live.
  usageUnsub = window.cockpit.on('cockpit:usage-changed', () => void loadUsage())
  // Custom sidebar order changed via sidebar.order.set
  orderUnsub = window.cockpit.on('cockpit:sidebar-order-changed', (order) => {
    if (Array.isArray(order)) customOrder.value = order.map(String)
  })
  // Runtime ability enable/disable — re-resolve the sidebar live and bail out
  // of a page that was just disabled.
  abilityUnsub = subscribeAbilityChanges()
  void loadAbilityStates()
  void loadUsage()
  void loadSidebarOrder()
  window.cockpit.isMaximized().then((v) => (isMaximized.value = v))
  winUnsub = window.cockpit.on('cockpit:window-maximized', (v) => {
    isMaximized.value = Boolean(v)
  })
  subscribeConfig()
  subscribeSchemeMedia()
  subscribeCommandErrors()
  resolveBackgroundImage()
  btUnsub = window.cockpit.on('cockpit:bt', onBtEvent)
  if (!agentView) {
    quitUnsub = window.cockpit.on('cockpit:confirm-quit', onQuitConfirm)
    coverUnsub = window.cockpit.on('cockpit:agent-cover', (c) => {
      agentCovered.value = c === true
    })
  } else {
    hostUnsub = window.cockpit.on('cockpit:agent-host', (m) => {
      if (m === 'main' || m === 'window' || m === 'background') agentHost.value = m
    })
  }
  // restore the "don't remind me again" preference
  quitSuppress.value = localStorage.getItem(QUIT_SUPPRESS_KEY) === '1'
  // Track the last pointer position so the theme reveal can originate from
  // the cursor (`animations.themeTransition = 'cursor'`).
  window.addEventListener('pointermove', onPointerMove, { passive: true })
})

let lastPointer = { x: 0, y: 0 }
function onPointerMove(e: PointerEvent): void {
  lastPointer.x = e.clientX
  lastPointer.y = e.clientY
}

watch(currentId, () => persistUiState(), { flush: 'post' })
// AI 视图把自己当前所在页面报给主进程（标题栏图标悬停提示用）
watch(
  currentId,
  (id) => {
    if (agentView && id) void window.cockpit.command('agent.report-page', { page: id })
  },
  { flush: 'post', immediate: true }
)
watch(rail, () => persistUiState())

onBeforeUnmount(() => {
  unsub?.()
  usageUnsub?.()
  hostUnsub?.()
  coverUnsub?.()
  abilityUnsub?.()
  orderUnsub?.()
  winUnsub?.()
  configUnsub?.()
  navigateUnsub?.()
  commandErrorUnsub?.()
  schemeMedia?.removeEventListener?.('change', onSchemeChange)
  btUnsub?.()
  quitUnsub?.()
  window.removeEventListener('pointermove', onPointerMove)
  if (searchDebounce) {
    clearTimeout(searchDebounce)
    searchDebounce = null
  }
})
</script>

<template>
  <v-app
    :class="[windowRounded ? 'win-rounded' : '', agentEmbedded ? 'ai-embedded' : '']"
    :data-current-ability="currentId"
    :data-ability-ready="readyAbility"
  >
    <BackgroundLayer
      :mode="backgroundMode"
      :image-url="backgroundImage"
      :blur="fuseBlur"
      :opacity="backgroundOpacity"
    />
    <FuseLayer :alpha="fuseAlpha" />
    <AgentActivityOverlay
      v-if="!agentView && agentUi.outline"
      :idle-ms="agentUi.busyTimeoutSec * 1000"
    />
    <v-navigation-drawer
      v-model="drawer"
      :rail="rail"
      permanent
      width="264"
      rail-width="64"
      color="surface-variant"
    >
      <template #prepend>
        <div
          class="brand-header"
          :class="rail ? 'brand-header--rail' : 'px-4 py-3 d-flex align-center ga-2'"
          @click="rail = !rail"
        >
          <div class="brand-logo">
            <GameIcon name="boss" :size="30" />
          </div>
          <div v-if="!rail" class="d-flex flex-column">
            <span class="text-subtitle-2 font-weight-bold on-surface">Linux Cockpit</span>
            <span class="text-caption on-surface-variant brand-sub">{{ t('app.brandSub') }}</span>
          </div>
        </div>
      </template>

      <!-- Top search box (expanded only) -->
      <div v-if="!rail" class="px-3 pb-2">
        <v-text-field
          v-model="searchText"
          prepend-inner-icon="mdi-magnify"
          :placeholder="t('search.placeholder')"
          density="compact"
          variant="solo-filled"
          flat
          hide-details
          clearable
          rounded="lg"
          @click:clear="searchText = ''"
          @input="scheduleSearchApps"
          @keydown.enter.prevent="openFirstQuickAction"
        />
      </div>

      <v-list v-if="!rail && searchText.trim()" density="compact" class="px-2">
        <v-list-subheader>{{ t('search.appsHeader') }}</v-list-subheader>
        <v-list-item
          v-for="qa in searchQuick"
          :key="qa.id"
          :title="qa.label"
          :subtitle="qa.description"
          :append-icon="'mdi-play'"
          density="compact"
          rounded="lg"
          @click="runQuickAction(qa)"
          @contextmenu.prevent="openCtxMenu($event, qa)"
        />
        <v-list-item v-if="searchQuick.length === 0 && !searchBusy">
          <v-list-item-subtitle>{{ t('search.noMatch') }}</v-list-item-subtitle>
        </v-list-item>
      </v-list>

      <!-- Quick-launch context menu: the action itself + ability-registered children -->
      <v-menu
        v-model="ctxMenuOpen"
        :activator="ctxMenuEl ?? undefined"
        :close-on-content-click="false"
        :close-on-back="true"
        offset="0"
      >
        <v-list density="compact" class="pa-1">
          <v-list-item
            v-for="action in ctxMenuItems"
            :key="action.id"
            density="compact"
            rounded="lg"
            @click="runQuickAction(action)"
          >
            <template #prepend>
              <AbilityIcon :icon="action.icon ?? null" :size="16" />
            </template>
            <v-list-item-title class="text-body-2">{{ action.label }}</v-list-item-title>
          </v-list-item>
        </v-list>
      </v-menu>

      <v-divider v-if="!rail && searchText.trim()" class="my-2 mx-2" />

      <template v-if="!rail">
        <v-list density="compact" nav class="px-2">
          <template v-if="sortMode === 'custom'">
            <v-list-item
              v-for="a in filteredAbilities"
              :key="a.id"
              :data-ability-id="a.id"
              :title="a.name"
              density="compact"
              :active="currentId === a.id"
              rounded="lg"
              @click="openAbility(a.id)"
            >
              <template #prepend>
                <AbilityIcon :icon="a.icon" :size="sidebarIconSize" />
              </template>
            </v-list-item>
          </template>
          <template v-else>
            <template v-for="g in groups" :key="g.label">
              <v-list-subheader>{{ g.label }}</v-list-subheader>
              <v-list-item
                v-for="a in g.items"
                :key="a.id"
                :data-ability-id="a.id"
                :title="a.name"
                density="compact"
                :active="currentId === a.id"
                rounded="lg"
                @click="openAbility(a.id)"
              >
                <template #prepend>
                  <AbilityIcon :icon="a.icon" :size="sidebarIconSize" />
                </template>
              </v-list-item>
            </template>
          </template>
        </v-list>
      </template>

      <!-- Collapsed rail: icon-only buttons -->
      <template v-else>
        <v-list density="compact" nav class="px-1">
          <v-tooltip v-for="a in abilities" :key="a.id" location="end">
            <template #activator="{ props }">
              <!-- 纯图标：aria-label 给无障碍树 / inspector 快照一个名字 -->
              <v-list-item
                v-bind="props"
                :data-ability-id="a.id"
                :aria-label="a.name"
                :active="currentId === a.id"
                density="compact"
                rounded="lg"
                @click="openAbility(a.id)"
              >
                <template #prepend>
                  <AbilityIcon :icon="a.icon" :size="sidebarIconSize" />
                </template>
              </v-list-item>
            </template>
            <span>{{ a.name }}</span>
          </v-tooltip>
        </v-list>
      </template>

      <template #append>
        <div class="pa-3 d-flex justify-center ga-2" :class="rail ? 'flex-column' : ''">
          <v-tooltip :text="t('appbar.btTooltip')" location="end">
            <template #activator="{ props: tp }">
              <v-badge
                class="bt-nav-badge"
                :model-value="btRunning > 0"
                :content="btBadge"
                color="primary"
              >
                <v-btn v-bind="tp" variant="tonal" icon @click="btOpen = true">
                  <v-icon>mdi-tray-full</v-icon>
                </v-btn>
              </v-badge>
            </template>
          </v-tooltip>
          <v-tooltip :text="t('appbar.copyTooltip')" location="end">
            <template #activator="{ props: tp }">
              <v-btn
                v-bind="tp"
                variant="tonal"
                icon
                :disabled="!currentAbility"
                @click="copyCurrentView"
              >
                <AbilityIcon icon="default/document" :size="20" />
              </v-btn>
            </template>
          </v-tooltip>
          <v-tooltip :text="t('appbar.helpTooltip')" location="end">
            <template #activator="{ props: tp }">
              <v-btn
                v-bind="tp"
                variant="tonal"
                icon
                :disabled="!currentAbility"
                :aria-label="t('appbar.helpTooltip')"
                @click="openHelp"
              >
                <v-icon>mdi-help-circle-outline</v-icon>
              </v-btn>
            </template>
          </v-tooltip>
          <v-btn
            variant="tonal"
            icon
            :aria-label="rail ? t('sidebar.expand') : t('sidebar.collapse')"
            @click="rail = !rail"
          >
            <v-icon>{{ rail ? 'mdi-chevron-right' : 'mdi-chevron-left' }}</v-icon>
          </v-btn>
        </div>
      </template>
    </v-navigation-drawer>

    <v-app-bar
      color="surface"
      flat
      border
      :class="isFrameless && !agentCovered ? 'cockpit-app-bar' : ''"
    >
      <v-app-bar-title @dblclick="isFrameless ? winToggleMaximize : undefined">
        <span class="text-subtitle-1 font-weight-medium">{{
          currentAbility?.name ?? 'Linux Cockpit'
        }}</span>
      </v-app-bar-title>
      <v-chip
        v-if="agentView"
        class="ai-view-chip"
        color="primary"
        variant="tonal"
        prepend-icon="mdi-robot-happy-outline"
        :title="t('agent.view.hint', '这是 AI 的独立视图：你在这里的操作会和 AI 互相影响')"
        >{{ t('agent.view.chip', 'AI 视图')
        }}{{ agentView.name ? ` · ${agentView.name}` : '' }}</v-chip
      >
      <AgentBar
        v-if="!agentView && agentUi.showBar"
        :lang="lang"
        :ui="agentUi"
        :current-id="currentId"
        :ability-name="(id) => abilities.find((a) => a.id === id)?.name ?? ''"
      />
      <v-spacer />
      <v-btn
        v-if="agentEmbedded"
        v-agent-forbidden
        class="text-none mr-2"
        color="primary"
        variant="flat"
        prepend-icon="mdi-arrow-left"
        @click="agentBack"
      >
        {{ t('agent.view.back', '返回我的界面') }}
      </v-btn>
      <v-btn
        v-if="hasSettingsPage"
        icon="mdi-cog-outline"
        variant="text"
        :aria-label="t('ability.settings.name', '设置')"
        @click="openAbility('settings')"
      />
      <template v-if="isFrameless">
        <v-btn
          v-agent-forbidden="!!agentView"
          icon="mdi-window-minimize"
          variant="text"
          :aria-label="t('window.minimize', '最小化')"
          @click="winMinimize"
        />
        <v-btn
          v-agent-forbidden="!!agentView"
          :icon="isMaximized ? 'mdi-window-restore' : 'mdi-window-maximize'"
          variant="text"
          @click="winToggleMaximize"
        />
        <v-btn
          v-agent-forbidden="!!agentView"
          icon="mdi-close"
          variant="text"
          class="win-close"
          :aria-label="t('window.close', '关闭')"
          @click="winClose"
        />
      </template>
    </v-app-bar>

    <v-main scrollable class="content-bg">
      <v-container fluid class="pa-4">
        <div class="d-flex flex-column" style="min-height: calc(100vh - 64px - 32px)">
          <!-- keep-alive: only abilities that opted in are cached (by name);
               the rest remount fresh each visit. Wrapped in <transition> for
               the configurable out-in page switch animation. -->
          <transition :name="pageTransitionName" mode="out-in">
            <keep-alive v-if="currentAbility" :include="keepAliveNames">
              <component :is="currentAbility.comp" ref="abilityRef" class="flex-grow-1" />
            </keep-alive>
            <v-empty-state
              v-else
              icon="mdi-view-dashboard-outline"
              :title="t('appbar.selectTitle')"
              :text="t('appbar.selectText')"
              class="align-self-center mt-8"
            />
          </transition>
        </div>
      </v-container>
    </v-main>

    <!-- Background tasks panel (framework-level) -->
    <BackgroundTasksDialog v-model="btOpen" />
    <SettingsDialog
      v-model="settingsDialog.open"
      :categories="settingsDialog.categories"
      :highlight="settingsDialog.highlight"
    />
    <HelpDialog v-model="helpOpen" :ability="helpAbility" :tree="helpTree" />

    <!-- Quit confirmation when background tasks are still running -->
    <v-dialog v-model="quitConfirmOpen" width="440" persistent>
      <v-card rounded="lg">
        <v-card-title class="d-flex align-center ga-2 text-subtitle-1">
          <v-icon color="warning">mdi-tray-full</v-icon>
          {{ t('quit.title') }}
        </v-card-title>
        <v-card-text>
          <div class="text-body-2 mb-3">
            {{ te('quit.text', { n: String(quitCount) }) }}
          </div>
          <v-checkbox
            v-model="quitSuppress"
            :label="t('quit.suppress')"
            density="compact"
            hide-details
          />
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="quitConfirmOpen = false">{{ t('quit.cancel') }}</v-btn>
          <v-btn color="error" prepend-icon="mdi-power" @click="doConfirmQuit">
            {{ t('quit.confirm') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-snackbar v-model="copySnackOpen" :timeout="2500" color="success" location="top">
      {{ copySnackText }}
    </v-snackbar>

    <v-snackbar v-model="commandErrorOpen" :timeout="4000" color="error" location="top">
      {{ commandErrorText }}
    </v-snackbar>

    <v-snackbar v-model="helpSnackOpen" :timeout="2600" color="info" location="top">
      {{ helpSnackText }}
    </v-snackbar>
  </v-app>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
}

.brand-header {
  gap: 10px;
  cursor: pointer;
}

.brand-header--rail {
  padding: 12px 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-logo {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  background: rgba(var(--v-theme-primary), 0.14);
  color: rgb(var(--v-theme-primary));
  flex-shrink: 0;
}

.brand-sub {
  font-size: 0.68rem;
  letter-spacing: 0.04em;
  opacity: 0.7;
}

/* Background-task count badge in the nav drawer. Vuetify's default "top end"
   places the badge OUTSIDE the wrapper corner (bottom/left calc), which spills
   past the 64px rail. Reposition it onto the button's top-right corner. */
.bt-nav-badge {
  position: relative;
}
.bt-nav-badge .v-badge__wrapper {
  position: relative;
}
.bt-nav-badge .v-badge__badge {
  position: absolute;
  top: -6px;
  right: -6px;
  bottom: auto;
  left: auto;
  transform: none;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  font-size: 0.68rem;
  line-height: 18px;
}

.ai-embedded::after {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 3500;
  pointer-events: none;
  border-radius: inherit;
  box-shadow: inset 0 0 0 2px rgb(var(--v-theme-primary));
}
.ai-view-chip {
  padding-block: 4px;
  min-height: 24px;
  /* 相对整条标题栏居中（和 AgentBar 一致），而不是跟在标题后面 */
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  /* 标题栏是拖拽区；chip 本身不需要点击，保持可拖动 */
}
</style>
