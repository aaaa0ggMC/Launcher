<script setup lang="ts">
import { computed, provide, ref, shallowRef, onMounted, onBeforeUnmount } from 'vue'
import { useTheme } from 'vuetify'
import type { Ability } from './abilities/types'
import { FALLBACK_ICON } from './abilities/types'
import type { AbilitiesManifest, AppEntry, LaunchResult } from '@shared/types'

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
  comp: Ability['component']
}

const manifest = shallowRef<AbilitiesManifest | null>(null)
const runtimeConfig = ref<Record<string, unknown>>({})
const theme = useTheme()

const drawer = ref(true)
const rail = ref(false)
const searchText = ref('')
const currentId = ref<string | null>(null)

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
        icon: meta.icon ?? FALLBACK_ICON,
        category: meta.category,
        comp: meta.component
      }
    })
    .filter((x): x is SidebarAbility => x !== null)
})

const currentAbility = computed(
  () => abilities.value.find((a) => a.id === currentId.value) ?? null
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
// Theme switching from config.json (dark | pureblack | light | system)
// ---------------------------------------------------------------------------
function applyTheme(): void {
  const t = (runtimeConfig.value.theme as string) ?? 'dark'
  const resolved = t === 'system' || t === 'light' ? 'dark' : t
  theme.global.name.value = resolved === 'pureblack' ? 'pureblack' : 'dark'
}

function onConfigChanged(cfg: Record<string, unknown> | null): void {
  runtimeConfig.value = cfg ?? {}
  applyTheme()
}

// ---------------------------------------------------------------------------
// Shared launch flow (used by search quick-launch + abilities)
// ---------------------------------------------------------------------------
interface PendingLaunch {
  root: string
  id: string
  entry: AppEntry
}

const pendingLaunch = shallowRef<PendingLaunch | null>(null)
const confirmOpen = ref(false)
const ackNow = ref(false)

const RISK_LEVEL = { low: 0, medium: 1, high: 2 }

function riskNeedsConfirm(entry: AppEntry): boolean {
  const cfg = runtimeConfig.value.runtime as { confirmBeforeLaunch?: boolean } | undefined
  if (cfg?.confirmBeforeLaunch) return true
  const level = RISK_LEVEL[entry.security?.risk ?? 'low']
  return level >= RISK_LEVEL.medium && !entry.security?.acknowledged
}

async function launchApp(root: string, id: string, entry: AppEntry): Promise<LaunchResult | void> {
  if (riskNeedsConfirm(entry)) {
    pendingLaunch.value = { root, id, entry }
    ackNow.value = false
    confirmOpen.value = true
    return
  }
  return await window.cockpit.launch(root, id)
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
  await window.cockpit.launch(p.root, p.id)
}

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
provide('cockpit:abilities', { configs: abilityConfigs, launch: launchApp })

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
let unsub: (() => void) | null = null

onMounted(async () => {
  const [cfg, mani] = await Promise.all([
    window.cockpit.getConfig(),
    window.cockpit.getManifest()
  ])
  onConfigChanged(cfg)
  manifest.value = mani
  const def = mani?.sidebar.default
  currentId.value = def && abilities.value.some((a) => a.id === def) ? def : null
  unsub = window.cockpit.on('cockpit:apps-changed', () => loadSearchApps())
})

onBeforeUnmount(() => {
  unsub?.()
})
</script>

<template>
  <v-app>
    <v-navigation-drawer
      v-model="drawer"
      :rail="rail"
      permanent
      width="264"
      color="surface-variant"
    >
      <template #prepend>
        <div class="px-4 py-3 d-flex align-center ga-2">
          <v-icon color="primary" size="28">mdi-console-line</v-icon>
          <span v-if="!rail" class="text-subtitle-1 font-weight-medium on-surface">Linux Cockpit</span>
        </div>
      </template>

      <!-- Top search box (expanded only) -->
      <div v-if="!rail" class="px-3 pb-1">
        <v-text-field
          v-model="searchText"
          @input="loadSearchApps"
          prepend-inner-icon="mdi-magnify"
          placeholder="搜索能力 / 应用别名"
          density="compact"
          variant="solo-filled"
          hide-details
          clearable
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
          @click="launchApp(app.root, app.id, app.entry)"
        />
        <v-list-item v-if="searchApps.length === 0 && !searchBusy">
          <v-list-item-subtitle>无匹配应用</v-list-item-subtitle>
        </v-list-item>
      </v-list>

      <v-divider v-if="!rail && searchText.trim()" class="my-2" />

      <template v-if="!rail">
        <v-list density="compact" nav class="px-2">
          <template v-for="g in groups" :key="g.label">
            <v-list-subheader class="text-caption">{{ g.label }}</v-list-subheader>
            <v-list-item
              v-for="a in g.items"
              :key="a.id"
              :title="a.name"
              density="compact"
              :active="currentId === a.id"
              @click="currentId = a.id"
            >
              <template #prepend>
                <span class="ability-icon">{{ a.icon }}</span>
              </template>
            </v-list-item>
          </template>
        </v-list>
      </template>

      <!-- Collapsed rail: icon-only buttons -->
      <template v-else>
        <v-list density="compact" nav class="px-2">
          <v-tooltip v-for="a in abilities" :key="a.id" location="end">
            <template #activator="{ props }">
              <v-list-item
                v-bind="props"
                :active="currentId === a.id"
                density="compact"
                @click="currentId = a.id"
              >
                <template #prepend>
                  <span class="ability-icon">{{ a.icon }}</span>
                </template>
              </v-list-item>
            </template>
            <span>{{ a.name }}</span>
          </v-tooltip>
        </v-list>
      </template>

      <template #append>
        <div class="pa-3">
          <v-btn
            block
            variant="tonal"
            size="small"
            :icon="rail ? 'mdi-chevron-right' : 'mdi-chevron-left'"
            @click="rail = !rail"
          />
        </div>
      </template>
    </v-navigation-drawer>

    <v-app-bar color="surface" flat border>
      <v-app-bar-title>
        <span class="text-subtitle-1">{{ currentAbility?.name ?? 'Linux Cockpit' }}</span>
      </v-app-bar-title>
      <v-spacer />
      <v-btn icon="mdi-cog-outline" variant="text" @click="currentId = 'settings'" />
    </v-app-bar>

    <v-main class="content-bg">
      <v-container fluid class="pa-4">
        <div class="d-flex flex-column" style="min-height: calc(100vh - 64px)">
          <component :is="currentAbility?.comp" v-if="currentAbility" class="flex-grow-1" />
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
        <v-card-title class="d-flex align-center ga-2">
          <v-icon>mdi-shield-alert-outline</v-icon>
          确认启动「{{ pendingLaunch?.entry.name }}」？
        </v-card-title>
        <v-card-text>
          <v-alert
            :type="pendingLaunch?.entry.security?.risk === 'high' ? 'error' : 'warning'"
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
          <v-checkbox
            v-model="ackNow"
            label="知道了，以后不再提醒"
            density="compact"
            hide-details
          />
        </v-card-text>
        <v-card-actions class="pa-4 pt-0">
          <v-spacer />
          <v-btn variant="text" @click="confirmOpen = false">取消</v-btn>
          <v-btn color="primary" @click="doLaunch">启动</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-app>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
}

.ability-icon {
  font-size: 18px;
  line-height: 1;
  width: 24px;
  text-align: center;
  display: inline-block;
}
</style>
