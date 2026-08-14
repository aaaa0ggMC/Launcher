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
import { ensureWebPlayerEngine } from './web-player/engine'
import EqCurveCanvas from './components/EqCurveCanvas.vue'
import EqEditorDialog from './components/EqEditorDialog.vue'
import type { EqProfile } from './types'

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
const menuStep = ref<'main' | 'queue' | 'speed' | 'sleep' | 'eq' | 'remote'>('main')
const pageMenuRef = ref<HTMLElement | null>(null)
let menuCleanup: (() => void) | null = null

// -- continuous-playback auxiliaries (volbal / anchor rebase) -----------------
const volbal = ref<{
  enabled: boolean
  method: string
  anchor: number | null
  baseVolume: number
}>({ enabled: false, method: 'lufs', anchor: null, baseVolume: 0.5 })

// -- M4 playback features (speed / AB loop / sleep / EQ / crossfade) ----------
const playbackRate = ref(1.0)
const loopA = ref<number | null>(null)
const loopB = ref<number | null>(null)
const sleepRemainMs = ref<number | null>(null)
const crossfade = ref(false)
const crossfadeSeconds = ref(2.5)
/** EQ profiles (builtin + user) with the active profile id. */
const eqProfiles = ref<EqProfile[]>([])
const eqActiveId = ref('flat')
const eqRange = ref(20)
const eqEditorOpen = ref(false)
const eqEditing = ref<EqProfile | null>(null)
/** Active EQ id when the editor opened — restore it if the user cancels. */
const eqEditorOrigin = ref<string | null>(null)
const rateItems = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
const sleepItems = [15, 30, 45, 60, 90, 120]
/** Custom speed input (any positive number; >16 = silent fast-forward). */
const customRate = ref('')

// -- LAN web-remote ------------------------------------------------------------
const webRemoteRunning = ref(false)
const webRemotePort = ref(0)

// -- spectrum (renderer engine analyser → bars) --------------------------------
const spectrumOn = ref(false)
let rafId = 0
const spectrumCanvas = ref<HTMLCanvasElement | null>(null)

let stateTimer: ReturnType<typeof setInterval> | null = null
let modeTimer: ReturnType<typeof setInterval> | null = null
let modeUnsub: (() => void) | null = null

function formatMs(ms: number | null | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Sleep countdown as `MM:SS` (or `H:MM:SS` when ≥ 1h). */
function formatSleep(ms: number | null | undefined): string {
  if (ms == null) return ''
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Sub-menu label helper (queue / speed / sleep / eq / remote). */
function submenuTitle(step: string): string {
  const keys: Record<string, string> = {
    queue: 'aidj.player.queue',
    speed: 'aidj.player.speed',
    sleep: 'aidj.player.sleep_timer',
    eq: 'aidj.player.eq',
    remote: 'aidj.player.web_remote'
  }
  return t(keys[step] ?? keys.queue, keys[step] ?? '')
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
      if (typeof s.playbackRate === 'number') playbackRate.value = s.playbackRate
      if (typeof s.loopA === 'number' || s.loopA === null) loopA.value = s.loopA as number | null
      if (typeof s.loopB === 'number' || s.loopB === null) loopB.value = s.loopB as number | null
      if (typeof s.sleepRemainMs === 'number' || s.sleepRemainMs === null)
        sleepRemainMs.value = s.sleepRemainMs as number | null
      if (typeof s.crossfade === 'boolean') crossfade.value = s.crossfade
      if (typeof s.crossfadeSeconds === 'number') crossfadeSeconds.value = s.crossfadeSeconds
      if (typeof s.eqPreset === 'string') eqActiveId.value = s.eqPreset
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
  // Optimistic UI: flip the play/pause icon and track title immediately
  // instead of waiting up to a poll cycle — the next pollState reconciles.
  if (cmd === 'toggle') status.value = status.value === 'Playing' ? 'Paused' : 'Playing'
  if (cmd === 'next' || cmd === 'prev') {
    const delta = cmd === 'next' ? 1 : -1
    if (cmd === 'prev' && positionMs.value > 3000) {
      // prev with progress > 3s just seeks to 0 — no track change.
      void pollState()
    } else {
      const i = queueIndex.value + delta
      if (i >= 0 && i < queueTracks.value.length) {
        queueIndex.value = i
        track.value = queueTracks.value[i] ?? ''
        positionMs.value = 0
        seekInput.value = 0
        status.value = 'Playing'
      }
    }
  }
  await window.cockpit.command(`aidj.${cmd}`).catch(() => {})
  // Reconcile quickly after the command lands (engine reports fast).
  setTimeout(() => void pollState(), 120)
}

async function clearQueue(): Promise<void> {
  const r = (await window.cockpit.command('aidj.player-clear-queue').catch(() => null)) as {
    ok?: boolean
  } | null
  if (r?.ok) {
    queueTracks.value = []
    queueIndex.value = -1
    queueTotal.value = 0
    track.value = ''
    status.value = 'Stopped'
  }
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

// -- M4: crossfade / EQ / rate / AB loop / sleep / web-remote ------------------

async function toggleCrossfade(): Promise<void> {
  const next = !crossfade.value
  const r = (await window.cockpit
    .command('aidj.player-crossfade', { enabled: next })
    .catch(() => null)) as Record<string, unknown> | null
  if (r?.ok) {
    crossfade.value = next
    if (typeof r.seconds === 'number') crossfadeSeconds.value = r.seconds
  }
}

/** Refresh the EQ profile list + active id. */
async function loadEqProfiles(): Promise<void> {
  const r = (await window.cockpit.command('aidj.eq-list').catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (r?.ok) {
    if (Array.isArray(r.profiles)) eqProfiles.value = r.profiles as EqProfile[]
    if (typeof r.activeId === 'string') eqActiveId.value = r.activeId
    if (typeof r.range === 'number') eqRange.value = r.range
  }
}

/** Apply an EQ profile (persists active id). */
async function applyEq(id: string): Promise<void> {
  const r = (await window.cockpit.command('aidj.eq-active', { id }).catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (r?.ok) {
    eqActiveId.value = id
    if (Array.isArray(r.gains) && !eqProfiles.value.some((p) => p.id === id)) {
      eqProfiles.value.push({
        id,
        name: id,
        gains: r.gains as number[],
        builtin: true
      })
    }
  }
}

/** Live preview while dragging in the editor (no persistence). */
async function previewEq(gains: number[]): Promise<void> {
  await window.cockpit.command('aidj.player-eq', { gains }).catch(() => {})
}

function openEqEditor(profile: EqProfile | null): void {
  eqEditing.value = profile
  eqEditorOrigin.value = eqActiveId.value
  eqEditorOpen.value = true
}

watch(eqEditorOpen, (open) => {
  if (open) return
  // Cancel (no save happened): the live preview reshaped the engine's curve —
  // restore the profile that was active before the editor opened. This must run
  // even when the edited profile IS the active one (origin === active) — the
  // preview changed the engine's gains without touching the active id.
  const origin = eqEditorOrigin.value
  eqEditorOrigin.value = null
  if (origin) void applyEq(origin)
})

async function saveEqProfile(profile: {
  id?: string
  name: string
  gains: number[]
}): Promise<void> {
  // A save already chose a profile — don't let the close-watch restore the old one.
  eqEditorOrigin.value = null
  const r = (await window.cockpit
    .command('aidj.eq-save', { id: profile.id ?? '', name: profile.name, gains: profile.gains })
    .catch(() => null)) as Record<string, unknown> | null
  if (r?.ok) {
    await loadEqProfiles()
    const saved = r.profile as EqProfile | undefined
    if (saved) await applyEq(saved.id)
  }
}

async function deleteEqProfile(id: string): Promise<void> {
  await window.cockpit.command('aidj.eq-delete', { id }).catch(() => {})
  await loadEqProfiles()
}

async function setRate(rate: number): Promise<void> {
  const r = (await window.cockpit
    .command('aidj.player-rate', { set: rate })
    .catch(() => null)) as Record<string, unknown> | null
  if (r?.ok) {
    playbackRate.value = rate
    customRate.value = String(rate)
  }
}

/** Apply the custom speed input — any positive number; invalid input resets. */
async function applyCustomRate(): Promise<void> {
  const v = Number(customRate.value)
  if (Number.isFinite(v) && v > 0) {
    await setRate(v)
  } else {
    customRate.value = String(playbackRate.value)
  }
}

/** Mark A or B at the current playback position; clicking an active point clears the loop. */
async function toggleAbloop(side: 'a' | 'b'): Promise<void> {
  const active = side === 'a' ? loopA.value != null : loopB.value != null
  if (active) {
    const r = (await window.cockpit
      .command('aidj.player-abloop', { off: true })
      .catch(() => null)) as Record<string, unknown> | null
    if (r?.ok) {
      loopA.value = null
      loopB.value = null
    }
    return
  }
  const pos = seekInput.value / 1000
  const nextA = side === 'a' ? pos : loopA.value
  const nextB = side === 'b' ? pos : loopB.value
  const r = (await window.cockpit
    .command('aidj.player-abloop', { a: nextA, b: nextB })
    .catch(() => null)) as Record<string, unknown> | null
  if (r?.ok) {
    loopA.value = r.loopA as number | null
    loopB.value = r.loopB as number | null
  }
}

async function setSleep(minutes: number): Promise<void> {
  const r = (await window.cockpit
    .command('aidj.player-sleep', { minutes })
    .catch(() => null)) as Record<string, unknown> | null
  if (r?.ok) {
    if (minutes > 0) sleepRemainMs.value = minutes * 60_000
    else sleepRemainMs.value = null
  }
}

async function pollWebRemote(): Promise<void> {
  if (mode.value !== 'web') return
  const r = (await window.cockpit.command('aidj.web-remote-status').catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (r?.ok) {
    webRemoteRunning.value = r.running === true
    if (typeof r.port === 'number') webRemotePort.value = r.port
  }
}

/** Load persisted player prefs the page depends on (spectrum default). */
async function loadPlayerPrefs(): Promise<void> {
  const r = (await window.cockpit.command('aidj.get-config').catch(() => null)) as Record<
    string,
    unknown
  > | null
  if (r?.ok && r.config) {
    const prefs = (r.config as Record<string, unknown>).preferences as Record<string, unknown>
    spectrumOn.value = (prefs.spectrum_enabled as boolean) ?? false
  }
}

async function toggleWebRemote(): Promise<void> {
  const cmd = webRemoteRunning.value ? 'aidj.web-remote-stop' : 'aidj.web-remote-start'
  const r = (await window.cockpit.command(cmd).catch(() => null)) as Record<string, unknown> | null
  if (r?.ok) {
    webRemoteRunning.value = !webRemoteRunning.value
    if (webRemoteRunning.value && typeof r.port === 'number') webRemotePort.value = r.port
    if (webRemoteRunning.value && typeof r.taskId === 'string') {
      // poll for the bound port shortly after the job boots
      setTimeout(() => void pollWebRemote(), 800)
    }
  }
}

// -- spectrum drawing ----------------------------------------------------------
function drawSpectrum(): void {
  rafId = 0
  const canvas = spectrumCanvas.value
  const analyser = ensureWebPlayerEngine().getAnalyser()
  if (!canvas || !analyser || !spectrumOn.value || status.value !== 'Playing') {
    return
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  const bins = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(bins)
  ctx.clearRect(0, 0, w, h)
  const barCount = 48
  const gap = 1
  const bw = (w - gap * (barCount - 1)) / barCount
  const primary = getComputedStyle(document.documentElement).getPropertyValue('--v-theme-primary')
  const onBg = getComputedStyle(document.documentElement).getPropertyValue(
    '--v-theme-on-surface-variant'
  )
  for (let i = 0; i < barCount; i++) {
    // Skip the DC bin, spread the rest evenly across the spectrum.
    const idx = 1 + Math.floor((i / barCount) * (bins.length - 2))
    const v = bins[idx] / 255
    const bh = Math.max(2, v * h)
    ctx.fillStyle = `rgba(${primary || '79,124,255'}, ${0.55 + v * 0.45})`
    ctx.fillRect(i * (bw + gap), h - bh, bw, bh)
  }
  void onBg
  rafId = requestAnimationFrame(drawSpectrum)
}

function startSpectrum(): void {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(drawSpectrum)
}

function stopSpectrum(): void {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
  const canvas = spectrumCanvas.value
  if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
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

watch(menuStep, (step) => {
  if (step === 'speed') customRate.value = String(playbackRate.value)
})

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
  void pollWebRemote()
  void loadPlayerPrefs()
  void loadEqProfiles()
  if (spectrumOn.value) startSpectrum()
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
  stopSpectrum()
}

watch(spectrumOn, (on) => {
  if (on) startSpectrum()
  else stopSpectrum()
})

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
            <div class="menu-item" @click="menuStep = 'speed'">
              <v-icon size="18">mdi-speedometer</v-icon>
              <span>{{ t('aidj.player.speed', '倍速') }}</span>
              <span class="ml-auto text-caption text-medium-emphasis">{{
                `${playbackRate.toFixed(2)}x`
              }}</span>
              <v-icon size="16">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="menuStep = 'sleep'">
              <v-icon size="18">mdi-bed-clock</v-icon>
              <span>{{ t('aidj.player.sleep_timer', '睡眠定时') }}</span>
              <span
                v-if="sleepRemainMs != null"
                class="ml-auto text-caption text-primary tabular-nums"
                >{{ formatSleep(sleepRemainMs) }}</span
              >
              <v-icon size="16">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item" @click="menuStep = 'eq'">
              <v-icon size="18">mdi-chart-bell-curve-cumulative</v-icon>
              <span>{{ t('aidj.player.eq', '均衡器') }}</span>
              <span class="ml-auto text-caption text-medium-emphasis">
                {{ eqProfiles.find((p) => p.id === eqActiveId)?.name ?? eqActiveId }}
              </span>
              <v-icon size="16">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item">
              <v-icon size="18">mdi-chart-bar</v-icon>
              <span>{{ t('aidj.player.spectrum', '频谱') }}</span>
              <v-switch
                v-model="spectrumOn"
                :disabled="mode !== 'web'"
                size="x-small"
                density="compact"
                color="primary"
                hide-details
                class="ml-auto"
              />
            </div>
            <div class="menu-item" @click="menuStep = 'remote'">
              <v-icon size="18">mdi-access-point-network</v-icon>
              <span>{{ t('aidj.player.web_remote', '局域网遥控') }}</span>
              <v-chip
                v-if="webRemoteRunning"
                variant="flat"
                color="success"
                class="ml-auto menu-chip"
              >
                {{ webRemotePort || '' }}
              </v-chip>
              <v-icon size="16">mdi-chevron-right</v-icon>
            </div>
            <div class="menu-item is-static">
              <v-icon size="18">mdi-playback-speed</v-icon>
              <span>{{ t('aidj.player.backend', '播放后端') }}</span>
              <v-chip variant="flat" class="ml-auto menu-chip">
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
              <v-btn
                v-if="mode === 'web' && queueTracks.length > 0"
                icon
                size="small"
                variant="text"
                color="error"
                :title="t('aidj.player.clear_queue', '清空队列')"
                @click="clearQueue"
              >
                <v-icon size="16">mdi-trash-can-outline</v-icon>
              </v-btn>
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

          <template v-else-if="menuStep === 'speed'">
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
              <span class="text-body-2 font-weight-medium">{{ submenuTitle('speed') }}</span>
            </div>
            <div class="menu-grid">
              <v-btn
                v-for="rate in rateItems"
                :key="rate"
                variant="tonal"
                class="menu-grid-item"
                :color="Math.abs(playbackRate - rate) < 0.001 ? 'primary' : undefined"
                @click="setRate(rate)"
              >
                {{ `${rate}x` }}
              </v-btn>
            </div>
            <div class="menu-scroll pa-2 d-flex flex-column ga-2">
              <div class="d-flex align-center ga-2">
                <v-text-field
                  v-model="customRate"
                  type="number"
                  step="0.1"
                  min="0.1"
                  density="compact"
                  variant="outlined"
                  hide-details
                  class="custom-rate-field"
                  :placeholder="t('aidj.player.custom_rate', '自定义倍速')"
                  @keyup.enter="applyCustomRate"
                />
                <v-btn
                  variant="tonal"
                  :title="t('aidj.player.custom_rate_hint', '任意正数，>16 为静音快进')"
                  @click="applyCustomRate"
                >
                  {{ t('aidj.player.apply', '应用') }}
                </v-btn>
              </div>
              <div class="text-caption text-medium-emphasis">
                {{ t('aidj.player.custom_rate_hint', '任意正数，>16 为静音快进') }}
              </div>
            </div>
          </template>

          <template v-else-if="menuStep === 'sleep'">
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
              <span class="text-body-2 font-weight-medium">{{ submenuTitle('sleep') }}</span>
            </div>
            <div class="menu-scroll pa-2 d-flex flex-column ga-2">
              <div v-if="sleepRemainMs != null" class="text-caption text-primary text-center">
                {{
                  tt('aidj.player.sleep_remaining', { t: formatSleep(sleepRemainMs) }, '剩余 {t}')
                }}
              </div>
              <div class="menu-grid">
                <v-btn
                  v-for="m in sleepItems"
                  :key="m"
                  variant="tonal"
                  class="menu-grid-item"
                  @click="setSleep(m)"
                >
                  {{ m }}
                </v-btn>
              </div>
              <v-btn
                variant="text"
                color="error"
                :disabled="sleepRemainMs == null"
                @click="setSleep(0)"
              >
                {{ t('aidj.player.sleep_off', '取消定时') }}
              </v-btn>
            </div>
          </template>

          <template v-else-if="menuStep === 'eq'">
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
              <span class="text-body-2 font-weight-medium">{{ submenuTitle('eq') }}</span>
              <v-spacer />
              <v-btn
                icon
                size="small"
                variant="text"
                color="primary"
                :title="t('aidj.player.eq_new', '新建 EQ')"
                @click="openEqEditor(null)"
              >
                <v-icon size="18">mdi-plus</v-icon>
              </v-btn>
            </div>
            <div class="menu-scroll">
              <div
                v-for="p in eqProfiles"
                :key="p.id"
                class="eq-item d-flex align-center ga-2"
                :class="{ 'is-active': p.id === eqActiveId }"
                @click="applyEq(p.id)"
              >
                <EqCurveCanvas :gains="p.gains" :height="30" :range="eqRange" class="eq-thumb" />
                <span class="text-body-2 text-truncate flex-grow-1">{{
                  p.builtin ? t(`aidj.player.eq_${p.id}`, p.name) : p.name
                }}</span>
                <v-btn
                  icon
                  size="small"
                  variant="text"
                  :title="t('aidj.player.eq_edit', '编辑')"
                  @click.stop="openEqEditor(p)"
                >
                  <v-icon size="16">mdi-pencil</v-icon>
                </v-btn>
                <v-btn
                  v-if="!p.builtin"
                  icon
                  size="small"
                  variant="text"
                  color="error"
                  :title="t('aidj.player.eq_delete', '删除')"
                  @click.stop="deleteEqProfile(p.id)"
                >
                  <v-icon size="16">mdi-trash-can-outline</v-icon>
                </v-btn>
              </div>
              <div v-if="eqProfiles.length === 0" class="menu-empty text-body-2">
                {{ t('aidj.player.eq_empty', '暂无 EQ，点击 + 新建') }}
              </div>
            </div>
          </template>

          <template v-else-if="menuStep === 'remote'">
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
              <span class="text-body-2 font-weight-medium">{{ submenuTitle('remote') }}</span>
            </div>
            <div class="menu-scroll pa-2 d-flex flex-column ga-2">
              <div class="text-caption text-medium-emphasis">
                {{
                  t(
                    'aidj.player.web_remote_hint',
                    '在手机或同局域网设备的浏览器打开服务器地址，即可查看歌曲/封面并控制播放。'
                  )
                }}
              </div>
              <v-btn
                variant="tonal"
                :color="webRemoteRunning ? 'error' : 'primary'"
                :prepend-icon="
                  webRemoteRunning ? 'mdi-stop-circle-outline' : 'mdi-play-circle-outline'
                "
                @click="toggleWebRemote"
              >
                {{
                  webRemoteRunning
                    ? t('aidj.player.web_remote_stop', '停止遥控服务器')
                    : t('aidj.player.web_remote_start', '启动遥控服务器')
                }}
              </v-btn>
              <div v-if="webRemoteRunning" class="text-body-2">
                <a
                  :href="`http://localhost:${webRemotePort}`"
                  target="_blank"
                  rel="noopener"
                  class="link"
                >
                  http://localhost:{{ webRemotePort }}
                </a>
              </div>
            </div>
          </template>
        </div>
      </Transition>
    </div>

    <EqEditorDialog
      v-model="eqEditorOpen"
      :profile="eqEditing"
      :preview="previewEq"
      :range="eqRange"
      @save="saveEqProfile"
    />

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

    <!-- spectrum strip (web mode + spectrum on) -->
    <div v-if="spectrumOn && mode === 'web'" class="spectrum-wrap">
      <canvas ref="spectrumCanvas" class="spectrum-canvas" width="560" height="44" />
    </div>

    <!-- bottom bar: volbal cycle + crossfade (left) + volume icon (right) — mirrors aidj.continuous -->
    <div class="volume-footer d-flex align-center justify-space-between px-4 py-2">
      <div class="d-flex align-center ga-2">
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

        <v-chip
          variant="flat"
          class="volbal-chip"
          :class="{ 'is-on': crossfade }"
          :disabled="mode !== 'web'"
          :title="t('aidj.player.crossfade_hint', '点击切换曲间淡入淡出')"
          @click="toggleCrossfade"
        >
          <v-icon start size="18">mdi-transition-masked</v-icon>
          <span class="volbal-value">{{ t('aidj.player.crossfade', '淡入淡出') }}</span>
        </v-chip>
      </div>

      <div class="d-flex align-center ga-2">
        <v-btn
          icon
          variant="flat"
          class="ab-loop-fab"
          :class="{ 'is-on': loopA != null }"
          :disabled="mode !== 'web'"
          :title="t('aidj.player.ab_hint_a', '在当前进度设置循环起点 A，再次点击清除循环')"
          @click="toggleAbloop('a')"
        >
          <span class="ab-letter">A</span>
        </v-btn>
        <v-btn
          icon
          variant="flat"
          class="ab-loop-fab"
          :class="{ 'is-on': loopB != null }"
          :disabled="mode !== 'web'"
          :title="t('aidj.player.ab_hint_b', '在当前进度设置循环终点 B，再次点击清除循环')"
          @click="toggleAbloop('b')"
        >
          <span class="ab-letter">B</span>
        </v-btn>

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
                size="20"
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
  height: 34px;
  padding-block: 2px;
  padding-inline: 12px;
  font-size: 0.85rem;
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
  width: 34px;
  height: 34px;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-surface-bright), 0.1);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
}
.ab-loop-fab {
  width: 34px;
  height: 34px;
  color: rgb(var(--v-theme-on-surface-variant));
  background: rgba(var(--v-theme-surface-bright), 0.1);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
}
.ab-loop-fab.is-on {
  color: rgb(var(--v-theme-primary));
  border: 1px solid rgba(var(--v-theme-primary), 0.45);
}
.ab-loop-fab.is-on:not(:disabled) {
  background: rgba(var(--v-theme-primary), 0.1);
}
.ab-loop-fab:disabled {
  opacity: 0.45;
}
.ab-letter {
  font-weight: 700;
  font-size: 0.85rem;
  line-height: 1;
}
.menu-chip {
  min-height: 24px;
  padding-block: 4px;
}

/* M4: submenu grid + spectrum */
.menu-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  padding: 4px;
}
.menu-grid-item {
  text-transform: none;
}
.eq-item {
  padding: 4px 8px;
  border-radius: 8px;
  margin-block: 1px;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.eq-item:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}
.eq-item.is-active {
  background: rgba(var(--v-theme-primary), 0.16);
}
.eq-thumb {
  flex: 0 0 84px;
  min-width: 84px;
}
.flex-1-1 {
  flex: 1 1 auto;
  min-width: 0;
}
/* Slim the custom-rate input down to match the adjacent button height. */
.custom-rate-field {
  flex: 0 1 auto;
  width: 96px;
  min-width: 96px;
}
.custom-rate-field :deep(.v-field) {
  --v-field-control-height: 32px;
  min-height: 32px;
  border-radius: 8px;
}
.custom-rate-field :deep(.v-field__input) {
  min-height: 32px;
  padding-block: 0;
  font-size: 0.85rem;
}
.custom-rate-field :deep(.v-field__outline) {
  --v-field-border-width: 1px;
}
.link {
  color: rgb(var(--v-theme-primary));
  text-decoration: none;
  word-break: break-all;
}
.spectrum-wrap {
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding: 2px 12px 0;
  pointer-events: none;
}
.spectrum-canvas {
  width: 100%;
  max-width: 560px;
  height: 44px;
  opacity: 0.85;
}
.volbal-chip:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
