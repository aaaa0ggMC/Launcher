<script setup lang="ts">
import {
  ref,
  inject,
  watch,
  onMounted,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
  type Ref,
  computed
} from 'vue'
import { translate, translateTemplate } from '../../main/ui/i18n'

defineOptions({ name: 'cockpit-aidj-player' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)
const tt = (key: string, vars: Record<string, string | number>, fallback?: string): string =>
  translateTemplate(
    uiLang.value,
    key,
    Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, String(v)])) as Record<
      string,
      string
    >,
    fallback
  )

// -- state (shared commands + unified player-state, works in dbus & web) ------
const mode = ref<'dbus' | 'web'>('dbus')
const status = ref('Unknown')
const track = ref('')
const positionMs = ref(0)
const lengthMs = ref(0)
const volume = ref<number | null>(null)
const queueIndex = ref(-1)
const queueTotal = ref(0)
const queueTracks = ref<string[]>([])
const coverUrl = ref('')
const coverPath = ref('')

// -- page menu (mirrors the aidj main page: top-center handle → subpages) -----
const menuOpen = ref(false)
const menuStep = ref<'main' | 'queue'>('main')
const pageMenuRef = ref<HTMLElement | null>(null)
let menuCleanup: (() => void) | null = null

// -- continuous-playback auxiliaries (volbal / anchor rebase) -----------------
const volbal = ref<{
  enabled: boolean
  method: string
  anchor: number | null
  baseVolume: number
}>({ enabled: false, method: 'lufs', anchor: null, baseVolume: 0.5 })

let stateTimer: ReturnType<typeof setInterval> | null = null
let modeTimer: ReturnType<typeof setInterval> | null = null
let modeUnsub: (() => void) | null = null

function formatMs(ms: number | null | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

async function pollMode(): Promise<void> {
  try {
    const r = (await window.cockpit.command('aidj.status')) as Record<string, unknown>
    if (r?.mode === 'dbus' || r?.mode === 'web') mode.value = r.mode
    if (r?.status && typeof r.status === 'object') {
      const s = r.status as Record<string, unknown>
      if (typeof s.status === 'string') status.value = s.status
      if (typeof s.track === 'string') track.value = s.track
    }
  } catch {
    /* noop */
  }
}

async function pollState(): Promise<void> {
  try {
    const r = (await window.cockpit.command('aidj.player-state')) as Record<string, unknown>
    if (r?.ok && r.state && typeof r.state === 'object') {
      const s = r.state as Record<string, unknown>
      if (typeof s.status === 'string') status.value = s.status
      if (typeof s.track === 'string') track.value = s.track
      positionMs.value = Number(s.positionMs ?? 0)
      lengthMs.value = Number(s.lengthMs ?? 0)
      if (!seeking.value) seekInput.value = positionMs.value
      if (typeof s.volume === 'number') volume.value = s.volume
      if (typeof s.queueIndex === 'number') queueIndex.value = s.queueIndex
      if (typeof s.queueTotal === 'number') queueTotal.value = s.queueTotal
      if (Array.isArray(s.queueTracks)) queueTracks.value = s.queueTracks as string[]
      const url = String(s.url ?? '')
      if (url.startsWith('file://')) {
        const path = decodeURIComponent(url.slice('file://'.length))
        if (path !== coverPath.value) {
          coverPath.value = path
          void refreshCover(path)
        }
      }
    }
  } catch {
    /* noop */
  }
}

async function refreshCover(path: string): Promise<void> {
  const res = (await window.cockpit.command('aidj.get-cover', { path }).catch(() => null)) as {
    ok?: boolean
    url?: string
  } | null
  coverUrl.value = res?.ok ? (res.url ?? '') : ''
}

async function control(cmd: string): Promise<void> {
  await window.cockpit.command(`aidj.${cmd}`).catch(() => {})
}

// -- seek slider: local value while dragging, commit ONCE on release ----------
const seekInput = ref(0)
const seeking = ref(false)

function onSeekChanging(v: number): void {
  seeking.value = true
  seekInput.value = v
}

async function commitSeek(): Promise<void> {
  seeking.value = false
  await window.cockpit
    .command('aidj.seek', { position: Math.round(seekInput.value) })
    .catch(() => {})
}

// -- volume (bottom-right icon → popup slider, mirrors aidj.continuous) -------
const volumeMenu = ref(false)
const tmpVolume = ref(50)
let volumeDebounce: ReturnType<typeof setTimeout> | null = null

function onVolumeChanging(pct: number): void {
  tmpVolume.value = pct
  if (volumeDebounce) clearTimeout(volumeDebounce)
  const v = pct / 100
  volumeDebounce = setTimeout(() => {
    window.cockpit.command('aidj.volume', { set: v }).catch(() => {})
  }, 50)
}

async function commitVolume(pct: number): Promise<void> {
  if (volumeDebounce) {
    clearTimeout(volumeDebounce)
    volumeDebounce = null
  }
  const v = pct / 100
  await window.cockpit.command('aidj.volume', { set: v }).catch(() => {})
  // The user's chosen level becomes the new volbal base (mirror continuous).
  await window.cockpit.command('aidj.player-rebase', { base: v }).catch(() => {})
  volume.value = v
  volumeMenu.value = false
  await pollVolbal()
}

watch(volumeMenu, (open) => {
  if (open) tmpVolume.value = Math.round((volume.value ?? 0.8) * 100)
})

onBeforeUnmount(() => {
  if (volumeDebounce) clearTimeout(volumeDebounce)
  volumeDebounce = null
})

// -- volbal ------------------------------------------------------------------
function applyVolbal(r: Record<string, unknown> | null): void {
  if (!r?.ok) return
  volbal.value = {
    enabled: r.enabled === true,
    method: String(r.method ?? 'lufs'),
    anchor: typeof r.anchor === 'number' ? (r.anchor as number) : null,
    baseVolume: typeof r.baseVolume === 'number' ? (r.baseVolume as number) : 0.5
  }
}

async function pollVolbal(): Promise<void> {
  if (mode.value !== 'web') return
  const r = (await window.cockpit.command('aidj.player-volbal').catch(() => null)) as Record<
    string,
    unknown
  > | null
  applyVolbal(r)
}

/** Quick three-level toggle (off → LUFS → RMS → off), mirrors ContinuousView. */
async function cycleVolbal(): Promise<void> {
  const { enabled, method } = volbal.value
  let nextEnabled: boolean
  let nextMethod: 'lufs' | 'linear'
  if (!enabled) {
    nextEnabled = true
    nextMethod = 'lufs'
  } else if (method === 'lufs') {
    nextEnabled = true
    nextMethod = 'linear'
  } else {
    nextEnabled = false
    nextMethod = 'lufs'
  }
  const r = (await window.cockpit
    .command('aidj.player-volbal', { enabled: nextEnabled, method: nextMethod })
    .catch(() => null)) as Record<string, unknown> | null
  applyVolbal(r)
}

function volbalLabel(): string {
  if (!volbal.value.enabled) return 'off'
  return volbal.value.method === 'lufs' ? 'LUFS' : 'RMS'
}

// -- page menu open/close (mirrors the aidj main page) ------------------------
function toggleMenu(): void {
  if (menuOpen.value) {
    menuOpen.value = false
    menuStep.value = 'main'
  } else {
    menuOpen.value = true
    menuStep.value = 'main'
  }
}

function menuClose(): void {
  menuOpen.value = false
  menuStep.value = 'main'
}

function onMenuDocClick(e: MouseEvent): void {
  const el = pageMenuRef.value
  const target = e.target as Node | null
  if (!el || !target || !target.isConnected) return
  if (el.contains(target)) return
  menuClose()
}

function onMenuKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') menuClose()
}

watch(menuOpen, (open) => {
  menuCleanup?.()
  menuCleanup = null
  if (open) {
    document.addEventListener('click', onMenuDocClick)
    document.addEventListener('contextmenu', onMenuDocClick)
    document.addEventListener('keydown', onMenuKey)
    menuCleanup = (): void => {
      document.removeEventListener('click', onMenuDocClick)
      document.removeEventListener('contextmenu', onMenuDocClick)
      document.removeEventListener('keydown', onMenuKey)
    }
  }
})

// -- lifecycle ---------------------------------------------------------------
function startPolling(): void {
  if (!modeTimer) modeTimer = setInterval(pollMode, 2000)
  if (!stateTimer) stateTimer = setInterval(pollState, 1000)
  void pollMode()
  void pollState()
  void pollVolbal()
  if (window.cockpit?.on && !modeUnsub) {
    modeUnsub = window.cockpit.on('cockpit:aidj-mode', (event: unknown) => {
      const ev = event as Record<string, unknown>
      if (ev?.mode === 'dbus' || ev?.mode === 'web') mode.value = ev.mode
    })
  }
}

function stopPolling(): void {
  if (modeTimer) {
    clearInterval(modeTimer)
    modeTimer = null
  }
  if (stateTimer) {
    clearInterval(stateTimer)
    stateTimer = null
  }
  modeUnsub?.()
  modeUnsub = null
}

onMounted(() => startPolling())
onActivated(() => startPolling())
onDeactivated(() => {
  stopPolling()
  menuCleanup?.()
  menuCleanup = null
})

const isPlaying = computed(() => status.value === 'Playing')
const hasTrack = computed(() => track.value !== '')
</script>

<template>
  <div class="player-shell d-flex flex-column h-100 overflow-hidden">
    <!-- top-center page menu (same pattern as the AI DJ main page) -->
    <div ref="pageMenuRef" class="page-menu" :class="{ 'is-open': menuOpen }" @click.stop>
      <button class="page-menu-handle" @click="toggleMenu">
        <v-icon size="16">{{ menuOpen ? 'mdi-chevron-up' : 'mdi-chevron-down' }}</v-icon>
      </button>

      <Transition name="menu-pop">
        <div v-if="menuOpen" class="page-menu-pop">
          <template v-if="menuStep === 'main'">
            <div class="menu-item" @click="menuStep = 'queue'">
              <v-icon size="18">mdi-format-list-bulleted</v-icon>
              <span>{{ t('aidj.player.queue', '播放队列') }}</span>
              <v-icon size="16" class="ml-auto">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item is-static">
              <v-icon size="18">mdi-playback-speed</v-icon>
              <span>{{ t('aidj.player.backend', '播放后端') }}</span>
              <v-chip size="x-small" variant="flat" class="ml-auto">
                {{
                  mode === 'web'
                    ? t('aidj.player_mode.web', '内置播放器')
                    : t('aidj.player_mode.dbus', '外部播放器 (MPRIS)')
                }}
              </v-chip>
            </div>
          </template>

          <template v-else-if="menuStep === 'queue'">
            <div class="menu-head d-flex align-center ga-2">
              <v-btn
                icon
                size="small"
                variant="text"
                :title="t('aidj.sessions.back', '返回')"
                @click="menuStep = 'main'"
              >
                <v-icon size="18">mdi-arrow-left</v-icon>
              </v-btn>
              <span class="text-body-2 font-weight-medium">{{
                t('aidj.player.queue', '播放队列')
              }}</span>
              <v-spacer />
              <span v-if="queueTotal > 0" class="text-caption text-medium-emphasis">{{
                tt('aidj.player.count', { n: queueTotal }, '{n} 首')
              }}</span>
            </div>
            <div v-if="queueTracks.length === 0" class="menu-empty text-body-2">
              {{ t('aidj.player.queue_empty', '队列为空') }}
            </div>
            <div v-else class="menu-scroll">
              <div
                v-for="(name, i) in queueTracks"
                :key="`${i}-${name}`"
                class="queue-item d-flex align-center ga-2"
                :class="{ 'is-current': i === queueIndex }"
              >
                <v-icon
                  size="14"
                  :icon="i === queueIndex ? 'mdi-play-circle' : 'mdi-music-note'"
                  :color="i === queueIndex ? 'primary' : undefined"
                />
                <span class="text-body-2 text-truncate" :title="name">{{ name }}</span>
              </div>
            </div>
          </template>
        </div>
      </Transition>
    </div>

    <!-- main player body: cover/track up top, progress + controls pinned low -->
    <div class="player-body d-flex flex-column align-center flex-grow-1 min-h-0 px-8 pt-10 pb-6">
      <div class="cover-wrap d-flex align-center justify-center mb-4">
        <img v-if="coverUrl" :src="coverUrl" class="cover-img" :alt="track" />
        <div v-else class="cover-img cover-placeholder d-flex align-center justify-center">
          <v-icon size="52">mdi-music-note</v-icon>
        </div>
      </div>

      <div class="track-title text-h6 font-weight-medium text-truncate mb-2" :title="track">
        {{ hasTrack ? track : t('aidj.player.empty', '—') }}
      </div>
      <v-chip
        size="small"
        variant="flat"
        :color="status === 'Playing' ? 'success' : status === 'Paused' ? 'warning' : 'secondary'"
      >
        {{ status }}
      </v-chip>

      <div class="flex-grow-1" />

      <div class="progress-row d-flex align-center ga-3 w-100" style="max-width: 560px">
        <span class="text-caption tabular-nums">{{ formatMs(seekInput) }}</span>
        <v-slider
          :model-value="seekInput"
          :max="Math.max(lengthMs, 0)"
          min="0"
          step="1000"
          color="primary"
          hide-details
          class="seek-slider"
          @update:model-value="onSeekChanging($event as number)"
          @end="commitSeek"
        />
        <span class="text-caption tabular-nums">{{ formatMs(lengthMs) }}</span>
      </div>

      <div class="controls-row d-flex align-center ga-3 mt-4">
        <v-btn icon variant="text" :title="t('aidj.prev.desc', '上一首')" @click="control('prev')">
          <v-icon size="24">mdi-skip-previous</v-icon>
        </v-btn>
        <v-btn
          icon
          size="large"
          variant="elevated"
          color="primary"
          :title="t('aidj.toggle.desc', '播放/暂停')"
          @click="control('toggle')"
        >
          <v-icon size="32">{{ isPlaying ? 'mdi-pause' : 'mdi-play' }}</v-icon>
        </v-btn>
        <v-btn icon variant="text" :title="t('aidj.next.desc', '下一首')" @click="control('next')">
          <v-icon size="24">mdi-skip-next</v-icon>
        </v-btn>
        <v-btn
          icon
          variant="text"
          :title="t('aidj.stop.desc', '停止播放')"
          @click="control('stop')"
        >
          <v-icon size="24">mdi-stop</v-icon>
        </v-btn>
      </div>
    </div>

    <!-- bottom bar: volbal cycle (left) + volume icon (right) — mirrors aidj.continuous -->
    <div class="volume-footer d-flex align-center justify-space-between px-4 py-2">
      <v-chip
        variant="flat"
        class="volbal-chip"
        :class="{ 'is-on': volbal.enabled }"
        :title="t('aidj.player.volbal_hint', '点击切换响度平衡（off → LUFS → RMS）')"
        @click="cycleVolbal"
      >
        <v-icon start size="18">mdi-gauge</v-icon>
        <span class="volbal-value">{{ volbalLabel() }}</span>
      </v-chip>

      <v-menu v-model="volumeMenu" :close-on-content-click="false" offset="8">
        <template #activator="{ props: mp }">
          <v-btn
            v-bind="mp"
            icon
            variant="flat"
            class="volume-fab"
            :title="t('aidj.volume.desc', '音量')"
          >
            <v-icon
              :icon="volume != null && volume < 0.01 ? 'mdi-volume-off' : 'mdi-volume-high'"
            />
          </v-btn>
        </template>
        <v-card width="240" rounded="lg">
          <v-card-text class="pa-4">
            <div class="d-flex align-center justify-space-between mb-2">
              <span class="text-caption text-medium-emphasis">
                {{ t('aidj.player.volume', '音量') }}
              </span>
              <span class="text-body-2 tabular-nums font-weight-medium">{{ tmpVolume }}%</span>
            </div>
            <v-slider
              :model-value="tmpVolume"
              :min="0"
              :max="100"
              :step="1"
              color="primary"
              thumb-label
              @update:model-value="onVolumeChanging($event as number)"
              @end="commitVolume(tmpVolume)"
            />
            <div class="text-caption text-medium-emphasis">
              {{ t('aidj.player.volume_hint', '松手后重新校准响度基准') }}
            </div>
          </v-card-text>
        </v-card>
      </v-menu>
    </div>
  </div>
</template>

<style scoped>
.player-shell {
  position: absolute;
  inset: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: rgba(var(--v-theme-surface), 0.1);
}

/* page menu — same pattern as the AI DJ main page */
.page-menu {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.page-menu-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 24px;
  border: none;
  cursor: pointer;
  color: rgb(var(--v-theme-on-surface-variant));
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  border-top: none;
  border-radius: 0 0 24px 24px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  transition: color 0.15s ease;
}
.page-menu-handle:hover,
.page-menu.is-open .page-menu-handle {
  color: rgb(var(--v-theme-primary));
}
.page-menu-pop {
  margin-top: 4px;
  width: 320px;
  max-height: 60vh;
  overflow-y: auto;
  background: rgba(var(--v-theme-surface), 0.2);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  padding: 8px;
}
.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.menu-item:hover:not(.is-static) {
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
}
.menu-item.is-static {
  cursor: default;
}
.menu-head {
  padding: 2px 4px 6px;
}
.menu-scroll {
  max-height: 40vh;
  overflow-y: auto;
  padding: 2px;
}
.menu-empty {
  padding: 18px 12px;
  color: rgb(var(--v-theme-on-surface-variant));
}
.queue-item {
  padding: 7px 10px;
  border-radius: 8px;
  margin-block: 1px;
}
.queue-item.is-current {
  background: rgba(var(--v-theme-primary), 0.12);
}
.menu-pop-enter-active,
.menu-pop-leave-active {
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}
.menu-pop-enter-from,
.menu-pop-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* main player body */
.cover-img {
  width: 200px;
  height: 200px;
  border-radius: 18px;
  object-fit: cover;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.24);
}
.cover-placeholder {
  background: rgba(var(--v-theme-surface-bright), 0.08);
  color: rgb(var(--v-theme-on-surface-variant));
}
.track-title {
  max-width: 560px;
}
.seek-slider {
  flex: 1 1 auto;
}

/* bottom bar: volbal cycle (left) + volume icon (right) — in flow, flush to
   the shell's bottom (the shell is absolute inset:0, so this IS the bottom) */
.volume-footer {
  flex-shrink: 0;
}
.volbal-chip {
  height: 44px;
  padding-inline: 14px;
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
  color: rgb(var(--v-theme-on-surface-variant));
  background: rgba(var(--v-theme-surface-bright), 0.1);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
}
.volbal-chip.is-on {
  color: rgb(var(--v-theme-primary));
  border: 1px solid rgba(var(--v-theme-primary), 0.45);
}
.volbal-chip :deep(.v-chip__content) {
  gap: 6px;
}
.volume-fab {
  width: 44px;
  height: 44px;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-surface-bright), 0.1);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
}
</style>
