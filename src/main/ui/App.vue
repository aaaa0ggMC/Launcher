<script setup lang="ts">
import { computed, provide, ref, shallowRef, onMounted, onBeforeUnmount, watch } from 'vue'
import { useTheme } from 'vuetify'
import type { Ability } from '@abilities/types'
import { getAbilityModuleEntries, buildSettingsSections } from '@abilities'
import type { SettingsCategory } from '@abilities'
import type { AbilitiesManifest, LaunchResult } from '@shared/types'
import type { AppAction, AppEntry, RiskLevel } from '@abilities/apps/types'
import AbilityIcon from './components/AbilityIcon.vue'
import GameIcon from './components/GameIcon.vue'
import TransformerModal from './components/TransformerModal.vue'
import BackgroundTasksDialog from './components/BackgroundTasksDialog.vue'
import BackgroundLayer from './components/BackgroundLayer.vue'
import FuseLayer from './components/FuseLayer.vue'
import { fileIconUrl } from './icon'
import { translate, translateTemplate, localize } from './i18n'
import { filterByQuery, scoreFields, fields } from './composables/search'
import { getEntryActions, type EntryAction } from './entry-actions'
import { PAGE_TRANSITIONS } from './animations'

// ---------------------------------------------------------------------------
// Ability loader: `src/abilities/index.ts` globs every ability's orchestrator
// (index.ts carries metadata only; the heavy View.vue loads on first show as
// an async component). This frame consumes the loaded registry and exposes it
// back to abilities for cross-scope control (see provide('cockpit:abilities')).
// ---------------------------------------------------------------------------
const abilityModules = getAbilityModuleEntries()

interface SidebarAbility {
  id: string
  order: number
  config: Record<string, unknown>
  name: string
  icon: string
  category: string
  keepAlive: boolean
  comp: Ability['component']
}

const manifest = shallowRef<AbilitiesManifest | null>(null)
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
const abilityRef = ref<{ $el?: Element; toMarkdown?: () => string } | null>(null)
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
  if (!manifest.value) return []
  return manifest.value.abilities
    .filter((a) => a.enabled)
    .sort((a, b) => a.order - b.order)
    .map((cfg) => {
      const mod = abilityModules[`./${cfg.id}/index.ts`]
      if (!mod) return null
      const meta = mod.default
      return {
        id: cfg.id,
        order: cfg.order,
        config: (cfg.config ?? {}) as Record<string, unknown>,
        name: t(`ability.${cfg.id}.name`, meta.name),
        icon: meta.icon ?? null,
        category: t(`ability.${cfg.id}.category`, meta.category),
        keepAlive: meta.keepAlive !== false,
        comp: meta.component
      }
    })
    .filter((x): x is SidebarAbility => x !== null)
})

const currentAbility = computed(() => abilities.value.find((a) => a.id === currentId.value) ?? null)

/**
 * Ability switch transition (设置 → 外观 → 界面动画). Empty name = off
 * (instant swap); otherwise the CSS class prefix for the active style.
 */
const pageTransitionName = computed(() => {
  const a =
    (runtimeConfig.value.animations as
      { enabled?: boolean; pageTransition?: string } | undefined) ?? {}
  if (a.enabled === false) return ''
  const known = PAGE_TRANSITIONS.some((t) => t.key === a.pageTransition)
  return `page-${known ? a.pageTransition : 'fade'}`
})

/**
 * Settings injection list — built from the same ability modules the sidebar
 * uses, then provided to the settings page so it never re-scans.
 */
const settingsSections = computed<SettingsCategory[]>(() =>
  buildSettingsSections(abilities.value, abilityModules)
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
function applyTheme(): void {
  const t = (runtimeConfig.value.theme as string) ?? 'dark'
  const resolved = t === 'system' || t === 'light' ? 'dark' : t
  theme.global.name.value = resolved === 'pureblack' ? 'pureblack' : 'dark'
}

function applyUiScale(): void {
  const scale = Number(runtimeConfig.value.uiScale)
  window.cockpit.setZoom(Number.isFinite(scale) && scale > 0 ? scale : 1.1)
}

function onConfigChanged(cfg: Record<string, unknown> | null): void {
  runtimeConfig.value = cfg ?? {}
  applyTheme()
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
// Shared launch flow (used by search quick-launch + abilities)
// ---------------------------------------------------------------------------
interface PendingLaunch {
  root: string
  id: string
  entry: AppEntry
  actionId?: string
  action?: AppAction
}

const pendingLaunch = shallowRef<PendingLaunch | null>(null)
const confirmOpen = ref(false)
const ackNow = ref(false)

const RISK_LEVEL = { low: 0, medium: 1, high: 2 }

function riskNeedsConfirm(entry: AppEntry): boolean {
  const level = RISK_LEVEL[entry.security?.risk ?? 'low']
  // Only medium/high risk needs confirmation (unless already acknowledged).
  // Low risk always launches directly, even with confirmBeforeLaunch enabled.
  if (level >= RISK_LEVEL.medium && !entry.security?.acknowledged) return true
  return false
}

async function launchApp(root: string, id: string, entry: AppEntry): Promise<LaunchResult | void> {
  if (riskNeedsConfirm(entry)) {
    pendingLaunch.value = { root, id, entry }
    ackNow.value = false
    confirmOpen.value = true
    return
  }
  const res = await window.cockpit.launch(root, id)
  openTransformer(res, entry)
  return res
}

/** Launch a clustered action; per-action risk overrides entry-level risk. */
async function launchActionApp(
  root: string,
  id: string,
  entry: AppEntry,
  actionId: string,
  action: AppAction
): Promise<LaunchResult | void> {
  const risk = action.risk ?? entry.security?.risk ?? 'low'
  const effective: AppEntry = { ...entry, security: { ...entry.security, risk } }
  if (riskNeedsConfirm(effective)) {
    pendingLaunch.value = { root, id, entry, actionId, action }
    ackNow.value = false
    confirmOpen.value = true
    return
  }
  const res = await window.cockpit.launchAction(root, id, actionId)
  openTransformer(res, entry)
  return res
}

async function doLaunch(): Promise<void> {
  const p = pendingLaunch.value
  if (!p) return
  confirmOpen.value = false
  if (ackNow.value) {
    await window.cockpit.updateEntry(p.root, p.id, {
      security: { ...(p.entry.security ?? {}), acknowledged: true } as AppEntry['security']
    })
  }
  const res =
    p.actionId && p.action
      ? await window.cockpit.launchAction(p.root, p.id, p.actionId)
      : await window.cockpit.launch(p.root, p.id)
  openTransformer(res, p.entry)
}

// -- live output transformer modal -----------------------------------------
const transformerOpen = ref(false)
const transformerEntry = shallowRef<AppEntry | null>(null)
const transformerPid = ref<number | null>(null)
let winUnsub: (() => void) | null = null

function openTransformer(res: LaunchResult | void, entry: AppEntry): void {
  if (!res || !res.ok) return
  // A launch converted into a background task → surface the global panel.
  if (res.taskId) {
    btOpen.value = true
    return
  }
  if (!res.monitor || !entry.transformer || !entry.transformer_display) return
  transformerEntry.value = entry
  transformerPid.value = res.pid ?? null
  transformerOpen.value = true
}

const pendingRisk = computed(() => {
  const p = pendingLaunch.value
  if (!p) return 'medium'
  return (p.action?.risk ?? p.entry.security?.risk ?? 'medium') as RiskLevel
})

const pendingTitle = computed(() => {
  const p = pendingLaunch.value
  if (!p) return ''
  return p.action ? `${p.entry.name} · ${p.action.name}` : p.entry.name
})

// ---------------------------------------------------------------------------
// Search: also quick-launch registry apps by name/alias/tag
// ---------------------------------------------------------------------------
interface SearchApp {
  id: string
  root: string
  entry: AppEntry
}

const searchApps = shallowRef<SearchApp[]>([])
const searchBusy = ref(false)

// -- quick-launch context menu: right-click a search result to pick any action
const ctxMenuOpen = ref(false)
const ctxMenuEl = ref<HTMLElement | null>(null)
const ctxApp = shallowRef<SearchApp | null>(null)

function openCtxMenu(e: MouseEvent, app: SearchApp): void {
  ctxMenuEl.value = e.currentTarget as HTMLElement
  ctxApp.value = app
  ctxMenuOpen.value = true
  // 快搜索数据可能是老快照（apps.json 可能已变更）——右键时重新拉取该条目
  // 最新数据，确保 action 列表/风险是最新的，而不是沿用搜索时的缓存。
  void window.cockpit.getEntry(app.root, app.id).then((fresh) => {
    if (fresh && ctxApp.value?.id === app.id) {
      ctxApp.value = { ...app, entry: fresh }
    }
  })
}
const ctxActions = computed<EntryAction[]>(() => {
  const app = ctxApp.value
  if (!app) return []
  const list: EntryAction[] = [{ kind: 'launch', id: '__launch', label: t('search.ctxLaunch') }]
  return list.concat(getEntryActions(app))
})

function ctxRun(action: EntryAction): void {
  const app = ctxApp.value
  if (!app) return
  ctxMenuOpen.value = false
  if (action.kind === 'launch') {
    void launchApp(app.root, app.id, app.entry)
  } else if (action.kind === 'action') {
    void launchActionApp(app.root, app.id, app.entry, action.id, action.action)
  } else {
    void window.cockpit.command(action.command, action.args ?? {})
  }
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
    void loadSearchApps()
    searchDebounce = null
  }, SEARCH_DEBOUNCE_MS)
}

async function loadSearchApps(): Promise<void> {
  if (!searchText.value.trim()) {
    searchApps.value = []
    return
  }
  searchBusy.value = true
  try {
    const res = await window.cockpit.listApps()
    const scored: { app: SearchApp; score: number }[] = []
    for (const [id, entry] of Object.entries(res.apps)) {
      if (!entry || entry.missing) continue
      const locName = localize(entry, 'name', lang.value) ?? entry.name
      const locAlias = localize(entry, 'alias', lang.value) ?? ''
      const locDesc = localize(entry, 'description', lang.value) ?? ''
      const tags = [...(entry.tags ?? []), ...(entry.tags_auto ?? [])]
      // tags 作为 weight-1 字段并入 AND 打分，保持联合语义：
      // "music bilibili" 不会因为单个 tag 命中就放行。
      const score = scoreFields(searchText.value, [
        ...fields(locName, locAlias, locDesc),
        ...(tags.length ? [{ text: tags.join(' ').toLowerCase(), weight: 1 }] : [])
      ])
      if (score > 0) scored.push({ app: { id, root: entry.root ?? '', entry }, score })
    }
    searchApps.value = scored
      .sort((x, y) => y.score - x.score)
      .slice(0, 12)
      .map((x) => x.app)
  } finally {
    searchBusy.value = false
  }
}

// ---------------------------------------------------------------------------
// Provide ability context (config + launch helper)
// ---------------------------------------------------------------------------
const abilityConfigs = computed(() => {
  const m: Record<string, Record<string, unknown>> = {}
  for (const a of abilities.value) m[a.id] = a.config
  return m
})

provide('cockpit:config', runtimeConfig)
provide('cockpit:settings', settingsSections)
// Cross-scope exposure: every ability can reach the full loaded registry
// (sidebar list, configs, launch helpers, command list) via this single key.
provide('cockpit:abilities', {
  list: abilities,
  current: currentAbility,
  configs: abilityConfigs,
  launch: launchApp,
  launchAction: launchActionApp,
  listCommands: (): Promise<{ name: string; description: string; usage?: string }[]> =>
    window.cockpit.listCommands()
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let unsub: (() => void) | null = null
let btUnsub: (() => void) | null = null
let quitUnsub: (() => void) | null = null

onMounted(async () => {
  const [cfg, mani] = await Promise.all([window.cockpit.getConfig(), window.cockpit.getManifest()])
  onConfigChanged(cfg)
  manifest.value = mani
  const def = mani?.sidebar.default
  if (!currentId.value || !abilities.value.some((a) => a.id === currentId.value)) {
    currentId.value = def && abilities.value.some((a) => a.id === def) ? def : null
  }
  restoreUiState()
  unsub = window.cockpit.on('cockpit:apps-changed', () => {
    if (searchDebounce) {
      clearTimeout(searchDebounce)
      searchDebounce = null
    }
    void loadSearchApps()
  })
  window.cockpit.isMaximized().then((v) => (isMaximized.value = v))
  winUnsub = window.cockpit.on('cockpit:window-maximized', (v) => {
    isMaximized.value = Boolean(v)
  })
  subscribeConfig()
  subscribeCommandErrors()
  resolveBackgroundImage()
  btUnsub = window.cockpit.on('cockpit:bt', onBtEvent)
  quitUnsub = window.cockpit.on('cockpit:confirm-quit', onQuitConfirm)
  // restore the "don't remind me again" preference
  quitSuppress.value = localStorage.getItem(QUIT_SUPPRESS_KEY) === '1'
})

watch(currentId, () => persistUiState(), { flush: 'post' })
watch(rail, () => persistUiState())

onBeforeUnmount(() => {
  unsub?.()
  winUnsub?.()
  configUnsub?.()
  commandErrorUnsub?.()
  btUnsub?.()
  quitUnsub?.()
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
          @input="scheduleSearchApps"
        />
      </div>

      <v-list v-if="!rail && searchText.trim()" density="compact" class="px-2">
        <v-list-subheader>{{ t('search.appsHeader') }}</v-list-subheader>
        <v-list-item
          v-for="app in searchApps"
          :key="app.id"
          :title="localize(app.entry, 'name', lang) || app.entry.name"
          :subtitle="localize(app.entry, 'description', lang) || app.entry.description"
          :append-icon="'mdi-play'"
          density="compact"
          rounded="lg"
          @click="launchApp(app.root, app.id, app.entry)"
          @contextmenu.prevent="openCtxMenu($event, app)"
        />
        <v-list-item v-if="searchApps.length === 0 && !searchBusy">
          <v-list-item-subtitle>{{ t('search.noMatch') }}</v-list-item-subtitle>
        </v-list-item>
      </v-list>

      <!-- Quick-launch context menu: main launch + any ability-injected actions -->
      <v-menu
        v-model="ctxMenuOpen"
        :activator="ctxMenuEl ?? undefined"
        :close-on-content-click="false"
        :close-on-back="true"
        offset="0"
      >
        <v-list density="compact" class="pa-1">
          <v-list-subheader v-if="ctxApp" class="px-3">
            {{ localize(ctxApp.entry, 'name', lang) || ctxApp.entry.name }}
          </v-list-subheader>
          <v-list-item
            v-for="action in ctxActions"
            :key="action.id"
            density="compact"
            rounded="lg"
            @click="ctxRun(action)"
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

    <!-- Confirm-before-launch dialog -->
    <v-dialog v-model="confirmOpen" width="480">
      <v-card rounded="lg">
        <v-card-title class="d-flex align-center ga-2 text-subtitle-1">
          <v-icon color="warning">mdi-shield-alert-outline</v-icon>
          {{ te('confirm.title', { name: pendingTitle }) }}
        </v-card-title>
        <v-card-text>
          <v-alert
            v-if="pendingLaunch?.entry.security?.auto_note || pendingLaunch?.entry.security?.note"
            :type="pendingRisk === 'high' ? 'error' : 'warning'"
            variant="tonal"
            class="mb-3"
            density="compact"
          >
            <template v-if="pendingLaunch?.entry.security?.auto_note">
              {{ t('confirm.detected') }} {{ pendingLaunch.entry.security.auto_note }}
            </template>
            <template v-if="pendingLaunch?.entry.security?.note">
              <div>{{ t('confirm.note') }} {{ pendingLaunch.entry.security.note }}</div>
            </template>
          </v-alert>
          <div class="text-body-2 mb-2">
            {{ te('confirm.aboutToLaunch', { name: pendingTitle }) }}
            <v-chip
              size="x-small"
              :color="pendingRisk === 'high' ? 'error' : 'warning'"
              variant="tonal"
              class="ml-1"
            >
              {{ pendingRisk }}
            </v-chip>
          </div>
          <v-checkbox v-model="ackNow" :label="t('confirm.ack')" density="compact" hide-details />
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="confirmOpen = false">{{ t('confirm.cancel') }}</v-btn>
          <v-btn color="primary" @click="doLaunch">{{ t('confirm.launch') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Live output transformer modal -->
    <TransformerModal v-model="transformerOpen" :entry="transformerEntry" :pid="transformerPid" />

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
