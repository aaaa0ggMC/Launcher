<script setup lang="ts">
import { computed, provide, ref, shallowRef, onMounted, onBeforeUnmount, watch } from 'vue'
import { useTheme } from 'vuetify'
import type { Ability } from './abilities/types'
import type { AbilitiesManifest, AppAction, AppEntry, LaunchResult, RiskLevel } from '@shared/types'
import AbilityIcon from './components/AbilityIcon.vue'
import GameIcon from './components/GameIcon.vue'
import TransformerModal from './components/TransformerModal.vue'
import BackgroundLayer from './components/BackgroundLayer.vue'
import FuseLayer from './components/FuseLayer.vue'
import { fileIconUrl } from './icon'

// ---------------------------------------------------------------------------
// Dynamic ability loading: one Vite chunk per ability folder. index.ts carries
// metadata only; the heavy View.vue loads on first show (async component).
// ---------------------------------------------------------------------------
const abilityModules = import.meta.glob<{ default: Ability }>('./abilities/*/index.ts', {
  eager: true
})

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

/** Sidebar icons: fill the rail in collapsed mode, larger in expanded. */
const sidebarIconSize = computed(() => (rail.value ? 26 : 24))

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
      const mod = abilityModules[`./abilities/${cfg.id}/index.ts`]
      if (!mod) return null
      const meta = mod.default
      return {
        id: cfg.id,
        order: cfg.order,
        config: (cfg.config ?? {}) as Record<string, unknown>,
        name: meta.name,
        icon: meta.icon ?? null,
        category: meta.category,
        keepAlive: meta.keepAlive !== false,
        comp: meta.component
      }
    })
    .filter((x): x is SidebarAbility => x !== null)
})

const currentAbility = computed(() => abilities.value.find((a) => a.id === currentId.value) ?? null)

// keep-alive caches only abilities that opted in (keepAlive !== false).
// Each cached page must declare a matching name via defineOptions.
const keepAliveNames = computed(() =>
  abilities.value.filter((a) => a.keepAlive).map((a) => `cockpit-${a.id}`)
)

const filteredAbilities = computed(() => {
  const q = searchText.value.trim().toLowerCase()
  if (!q) return abilities.value
  return abilities.value.filter(
    (a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q)
  )
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
  if (!res || !res.ok || !res.monitor || !entry.transformer || !entry.transformer_display) return
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

async function loadSearchApps(): Promise<void> {
  if (!searchText.value.trim()) {
    searchApps.value = []
    return
  }
  searchBusy.value = true
  try {
    const res = await window.cockpit.listApps()
    const q = searchText.value.trim().toLowerCase()
    const hits: SearchApp[] = []
    for (const [id, entry] of Object.entries(res.apps)) {
      if (!entry || entry.missing) continue
      const alias = entry.alias ?? ''
      const tags = [...(entry.tags ?? []), ...(entry.tags_auto ?? [])]
      if (
        entry.name.toLowerCase().includes(q) ||
        alias.toLowerCase().includes(q) ||
        tags.some((t) => t.toLowerCase().includes(q))
      ) {
        hits.push({ id, root: entry.root ?? '', entry })
      }
    }
    searchApps.value = hits.slice(0, 12)
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
provide('cockpit:abilities', {
  configs: abilityConfigs,
  launch: launchApp,
  launchAction: launchActionApp
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let unsub: (() => void) | null = null

onMounted(async () => {
  const [cfg, mani] = await Promise.all([window.cockpit.getConfig(), window.cockpit.getManifest()])
  onConfigChanged(cfg)
  manifest.value = mani
  const def = mani?.sidebar.default
  if (!currentId.value || !abilities.value.some((a) => a.id === currentId.value)) {
    currentId.value = def && abilities.value.some((a) => a.id === def) ? def : null
  }
  restoreUiState()
  unsub = window.cockpit.on('cockpit:apps-changed', () => loadSearchApps())
  window.cockpit.isMaximized().then((v) => (isMaximized.value = v))
  winUnsub = window.cockpit.on('cockpit:window-maximized', (v) => {
    isMaximized.value = Boolean(v)
  })
  subscribeConfig()
  resolveBackgroundImage()
})

watch(currentId, () => persistUiState(), { flush: 'post' })
watch(rail, () => persistUiState())

onBeforeUnmount(() => {
  unsub?.()
  winUnsub?.()
  configUnsub?.()
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
            <GameIcon name="dashboard" :size="26" />
          </div>
          <div v-if="!rail" class="d-flex flex-column">
            <span class="text-subtitle-2 font-weight-bold on-surface">Linux Cockpit</span>
            <span class="text-caption on-surface-variant brand-sub">System Control Center</span>
          </div>
        </div>
      </template>

      <!-- Top search box (expanded only) -->
      <div v-if="!rail" class="px-3 pb-2">
        <v-text-field
          v-model="searchText"
          prepend-inner-icon="mdi-magnify"
          placeholder="搜索能力 / 应用别名"
          density="compact"
          variant="solo-filled"
          flat
          hide-details
          clearable
          rounded="lg"
          @input="loadSearchApps"
        />
      </div>

      <v-list v-if="!rail && searchText.trim()" density="compact" class="px-2">
        <v-list-subheader>应用</v-list-subheader>
        <v-list-item
          v-for="app in searchApps"
          :key="app.id"
          :title="app.entry.name"
          :subtitle="app.entry.description"
          :append-icon="'mdi-play'"
          density="compact"
          rounded="lg"
          @click="launchApp(app.root, app.id, app.entry)"
        />
        <v-list-item v-if="searchApps.length === 0 && !searchBusy">
          <v-list-item-subtitle>无匹配应用</v-list-item-subtitle>
        </v-list-item>
      </v-list>

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
        <div class="pa-3 d-flex justify-center">
          <v-btn
            variant="tonal"
            icon
            size="small"
            :aria-label="rail ? '展开侧边栏' : '收起侧边栏'"
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
        <div class="d-flex flex-column" style="min-height: calc(100vh - 64px)">
          <!-- keep-alive: only abilities that opted in are cached (by name);
               the rest remount fresh each visit. -->
          <keep-alive v-if="currentAbility" :include="keepAliveNames">
            <component :is="currentAbility.comp" class="flex-grow-1" />
          </keep-alive>
          <v-empty-state
            v-else
            icon="mdi-view-dashboard-outline"
            title="选择一个功能"
            text="从左侧边栏选择功能，或使用顶部搜索框。"
            class="align-self-center mt-8"
          />
        </div>
      </v-container>
    </v-main>

    <!-- Confirm-before-launch dialog -->
    <v-dialog v-model="confirmOpen" width="480">
      <v-card rounded="lg">
        <v-card-title class="d-flex align-center ga-2 text-subtitle-1">
          <v-icon color="warning">mdi-shield-alert-outline</v-icon>
          确认启动「{{ pendingTitle }}」？
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
              检测: {{ pendingLaunch.entry.security.auto_note }}
            </template>
            <template v-if="pendingLaunch?.entry.security?.note">
              <div>备注: {{ pendingLaunch.entry.security.note }}</div>
            </template>
          </v-alert>
          <div class="text-body-2 mb-2">
            即将启动「{{ pendingTitle }}」
            <v-chip
              size="x-small"
              :color="pendingRisk === 'high' ? 'error' : 'warning'"
              variant="tonal"
              class="ml-1"
            >
              {{ pendingRisk }}
            </v-chip>
          </div>
          <v-checkbox
            v-model="ackNow"
            label="知道了，以后不再提醒"
            density="compact"
            hide-details
          />
        </v-card-text>
        <v-card-actions class="px-4 pb-4 pt-2">
          <v-spacer />
          <v-btn variant="text" @click="confirmOpen = false">取消</v-btn>
          <v-btn color="primary" @click="doLaunch">启动</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Live output transformer modal -->
    <TransformerModal v-model="transformerOpen" :entry="transformerEntry" :pid="transformerPid" />
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
</style>
