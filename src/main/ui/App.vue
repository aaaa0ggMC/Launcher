<script setup lang="ts">
import {
  computed,
  provide,
  ref,
  shallowRef,
  onMounted,
  onBeforeUnmount,
  watch,
  nextTick
} from 'vue'
import { useTheme } from 'vuetify'
import type { Ability } from '@abilities/types'
import { getAbilityModules, resolveSidebarAbilities, buildSettingsSections } from '@abilities'
import type { SettingsCategory } from '@abilities'
import AbilityIcon from './components/AbilityIcon.vue'
import GameIcon from './components/GameIcon.vue'
import BackgroundTasksDialog from './components/BackgroundTasksDialog.vue'
import BackgroundLayer from './components/BackgroundLayer.vue'
import FuseLayer from './components/FuseLayer.vue'
import { fileIconUrl } from './icon'
import { translate, translateTemplate } from './i18n'
import { resolveSchemeId } from './color_schemes'
import { filterByQuery, scoreFields, fields } from './composables/search'
import { getAllQuickActions, type QuickAction } from './quick-actions'
import { PAGE_TRANSITIONS } from './animations'

// ---------------------------------------------------------------------------
// Ability loader: `src/abilities/index.ts` globs every ability's orchestrator
// (index.ts carries metadata only; the heavy View.vue loads on first show as
// an async component). Abilities are self-injecting: platform-filtered and
// alphabetically ordered here (category then name), no yaml/manifest order.
// This frame consumes the loaded registry and exposes it back to abilities for
// cross-scope control (see provide('cockpit:abilities')).
// ---------------------------------------------------------------------------
const sidebarReport = resolveSidebarAbilities(window.cockpit.platform)

interface SidebarAbility {
  id: string
  config: Record<string, unknown>
  name: string
  icon: string | null
  category: string
  keepAlive: boolean
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
function winClose(): void {
  window.cockpit.windowClose()
}

/** Window prefs come from config.json (settings → 显示), applied on next launch. */
const isFrameless = computed(
  () => (runtimeConfig.value.window as { frameless?: boolean } | undefined)?.frameless !== false
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
  localStorage.setItem(
    UI_STATE_KEY,
    JSON.stringify({ rail: rail.value, currentId: currentId.value })
  )
}

function restoreUiState(): void {
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

const abilities = computed<SidebarAbility[]>(() => {
  return sidebarReport.loaded
    .map((meta) => ({
      id: meta.id,
      config: {} as Record<string, unknown>,
      name: t(`ability.${meta.id}.name`, meta.name),
      icon: meta.icon ?? null,
      category: t(`ability.${meta.id}.category`, meta.category),
      keepAlive: meta.keepAlive !== false,
      comp: meta.component
    }))
    .sort((a, b) => {
      const c = a.category.localeCompare(b.category, lang.value)
      return c !== 0 ? c : a.name.localeCompare(b.name, lang.value)
    })
})

const currentAbility = computed(() => abilities.value.find((a) => a.id === currentId.value) ?? null)

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
  buildSettingsSections(abilities.value, getAbilityModules())
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
  return [...map.entries()].map(([label, items]) => ({ label, items }))
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
  const scale = Number(runtimeConfig.value.uiScale)
  window.cockpit.setZoom(Number.isFinite(scale) && scale > 0 ? scale : 1.1)
}

function onConfigChanged(cfg: Record<string, unknown> | null): void {
  runtimeConfig.value = cfg ?? {}
  applyTheme()
  applyMotionClass()
  applyWindowRounded()
  applyUiScale()
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
function subscribeConfig(): void {
  configUnsub = window.cockpit.on('cockpit:config-changed', (cfg) => {
    if (cfg && typeof cfg === 'object') onConfigChanged(cfg as Record<string, unknown>)
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

function activate(abilityId: string, target: Record<string, unknown>): void {
  if (currentId.value !== abilityId) {
    pendingActivate.value = { ability: abilityId, target }
    currentId.value = abilityId
    return
  }
  deliverActivate(abilityRef.value, target)
}

// Deliver a pending activation once the target ability's view has mounted.
watch(abilityRef, (inst) => {
  const p = pendingActivate.value
  if (p && currentId.value === p.ability) {
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
      const score = scoreFields(searchText.value, fields(q.label, q.description ?? '', q.id))
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

onMounted(async () => {
  const cfg = await window.cockpit.getConfig()
  onConfigChanged(cfg)
  // Default page comes from config.json (sidebar.default); fall back to the
  // first alphabetical ability when missing/invalid (or no config at all).
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
  window.cockpit.isMaximized().then((v) => (isMaximized.value = v))
  winUnsub = window.cockpit.on('cockpit:window-maximized', (v) => {
    isMaximized.value = Boolean(v)
  })
  subscribeConfig()
  subscribeSchemeMedia()
  subscribeCommandErrors()
  resolveBackgroundImage()
  btUnsub = window.cockpit.on('cockpit:bt', onBtEvent)
  quitUnsub = window.cockpit.on('cockpit:confirm-quit', onQuitConfirm)
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
watch(rail, () => persistUiState())

onBeforeUnmount(() => {
  unsub?.()
  winUnsub?.()
  configUnsub?.()
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
  <v-app :class="windowRounded ? 'win-rounded' : ''">
    <BackgroundLayer
      :mode="backgroundMode"
      :image-url="backgroundImage"
      :blur="fuseBlur"
      :opacity="backgroundOpacity"
    />
    <FuseLayer :alpha="fuseAlpha" />
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
          @click:clear="searchText = ''"
          rounded="lg"
          @input="scheduleSearchApps"
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
          <template v-for="g in groups" :key="g.label">
            <v-list-subheader>{{ g.label }}</v-list-subheader>
            <v-list-item
              v-for="a in g.items"
              :key="a.id"
              :title="a.name"
              density="compact"
              :active="currentId === a.id"
              rounded="lg"
              @click="currentId = a.id"
            >
              <template #prepend>
                <AbilityIcon :icon="a.icon" :size="sidebarIconSize" />
              </template>
            </v-list-item>
          </template>
        </v-list>
      </template>

      <!-- Collapsed rail: icon-only buttons -->
      <template v-else>
        <v-list density="compact" nav class="px-1">
          <v-tooltip v-for="a in abilities" :key="a.id" location="end">
            <template #activator="{ props }">
              <v-list-item
                v-bind="props"
                :active="currentId === a.id"
                density="compact"
                rounded="lg"
                @click="currentId = a.id"
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

    <v-app-bar color="surface" flat border :class="isFrameless ? 'cockpit-app-bar' : ''">
      <v-app-bar-title @dblclick="isFrameless ? winToggleMaximize : undefined">
        <span class="text-subtitle-1 font-weight-medium">{{
          currentAbility?.name ?? 'Linux Cockpit'
        }}</span>
      </v-app-bar-title>
      <v-spacer />
      <v-btn icon="mdi-cog-outline" variant="text" @click="currentId = 'settings'" />
      <template v-if="isFrameless">
        <v-btn icon="mdi-window-minimize" variant="text" @click="winMinimize" />
        <v-btn
          :icon="isMaximized ? 'mdi-window-restore' : 'mdi-window-maximize'"
          variant="text"
          @click="winToggleMaximize"
        />
        <v-btn icon="mdi-close" variant="text" class="win-close" @click="winClose" />
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
</style>
