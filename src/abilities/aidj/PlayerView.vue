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
import { translate } from '../../main/ui/i18n'
import { ensureWebPlayerEngine } from './web-player/engine'
import PlayerMenu from './components/PlayerMenu.vue'
import EqEditorDialog from './components/EqEditorDialog.vue'
import type { EqProfile } from './types'

defineOptions({ name: 'cockpit-aidj-player' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

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

// -- LAN web-remote ------------------------------------------------------------
const webRemoteRunning = ref(false)
const webRemotePort = ref(0)

// -- spectrum (renderer engine analyser → bars) --------------------------------
const spectrumOn = ref(false)
let prefsLoaded = false
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
    prefsLoaded = true
    spectrumOn.value = (prefs.spectrum_enabled as boolean) ?? false
  }
}

/** Persist the page-menu spectrum toggle so it survives page switches. */
function persistSpectrum(on: boolean): void {
  if (!prefsLoaded) return
  window.cockpit
    .command('aidj.update-config', { path: 'preferences.spectrum_enabled', value: on })
    .then(() => window.cockpit.command('aidj.save-config'))
    .catch(() => null)
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
  persistSpectrum(on)
})

onMounted(() => startPolling())
onActivated(() => startPolling())
onDeactivated(() => {
  stopPolling()
})

const isPlaying = computed(() => status.value === 'Playing')
const hasTrack = computed(() => track.value !== '')
</script>

<template>
  <div class="player-shell d-flex flex-column h-100 overflow-hidden">
    <PlayerMenu
      v-model="menuOpen"
      v-model:spectrum-on="spectrumOn"
      :mode="mode"
      :queue-tracks="queueTracks"
      :queue-index="queueIndex"
      :queue-total="queueTotal"
      :playback-rate="playbackRate"
      :sleep-remain-ms="sleepRemainMs"
      :eq-profiles="eqProfiles"
      :eq-active-id="eqActiveId"
      :eq-range="eqRange"
      :web-remote-running="webRemoteRunning"
      :web-remote-port="webRemotePort"
      @clear-queue="clearQueue"
      @set-rate="setRate"
      @set-sleep="setSleep"
      @apply-eq="applyEq"
      @open-eq-editor="openEqEditor"
      @delete-eq-profile="deleteEqProfile"
      @toggle-web-remote="toggleWebRemote"
    />

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
