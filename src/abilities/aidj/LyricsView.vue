<script setup lang="ts">
import {
  ref,
  inject,
  computed,
  watch,
  onMounted,
  onActivated,
  onBeforeUnmount,
  nextTick
} from 'vue'
import type { Ref } from 'vue'
import { translate } from '../../main/ui/i18n'
import { DEFAULT_LYRICS_PAGE_CFG } from './types'
import type { AidjLyricsPageConfig } from './types'

/**
 * In-app lyrics page — fully independent from the desktop LyricsWindow. Since
 * centering/scrolling all happen INSIDE this window, it can offer a scroll
 * mode (all lines, current one auto-centered) AND a karaoke mode (word-by-word
 * fill on the current line following inline LRC timestamps). Colors always
 * follow the app theme (`--v-theme-*`), never configurable.
 */

defineOptions({ name: 'cockpit-aidj-lyrics' })

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

interface PlaybackState {
  ok?: boolean
  status?: string
  track?: string
  artist?: string
  album?: string
  player?: string
  positionMs?: number | null
  lengthMs?: number | null
  lyric?: string | null
  karaokeLyric?: string | null
  path?: string | null
}

// ---------------------------------------------------------------------------
// Karaoke-aware LRC parsing (self-contained, not shared with LyricsWindow).
// A line like `[00:12.00]一[00:12.30]二` splits into per-word chunks so the
// current line can fill progressively. Lines with no inline sub-timestamps get
// a single chunk (plain highlight).
// ---------------------------------------------------------------------------
interface LyricChunk {
  text: string
  /** ms at which this chunk becomes active (line-relative, raw LRC time). */
  time: number
}
interface LyricLine {
  time: number
  text: string
  chunks: LyricChunk[]
}

function parseTimeTag(m: RegExpMatchArray): number {
  const frac = Number(m[3] ?? '0')
  return Number(m[1]) * 60000 + Number(m[2]) * 1000 + (frac < 100 ? frac * 10 : frac)
}

function parseLyrics(lrc: string): LyricLine[] {
  const lines: LyricLine[] = []
  let offset = 0
  for (const raw of lrc.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const off = line.match(/\[offset:([+-]?\d+)\]/)
    if (off) {
      offset = Number(off[1])
      continue
    }
    if (!line.match(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/)) continue
    const parts = line.split(/(\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])/g)
    const chunks: LyricChunk[] = []
    let pendingTime = 0
    let pendingText = ''
    const flush = (): void => {
      const text = pendingText.trimStart()
      if (text) chunks.push({ text, time: pendingTime + offset })
      pendingText = ''
    }
    for (const part of parts) {
      const m = part.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]$/)
      if (m) {
        flush()
        pendingTime = parseTimeTag(m)
      } else {
        pendingText += part
      }
    }
    flush()
    if (!chunks.length) continue
    lines.push({ time: chunks[0].time, text: chunks.map((c) => c.text).join(''), chunks })
  }
  return lines.sort((a, b) => a.time - b.time)
}

/** Strip bracket tags — for timestamp-less (plain) lyrics. */
function stripLrcTags(lrc: string): string {
  return lrc.replace(/\[[^\]]*\]/g, '').trim()
}

// ---------------------------------------------------------------------------
// State + display config (colors are NOT part of it — theme only).
// ---------------------------------------------------------------------------
const cfg = ref<AidjLyricsPageConfig>({ ...DEFAULT_LYRICS_PAGE_CFG })
const state = ref<PlaybackState>({})
const coverUrl = ref('')
const lyricsOpen = ref(false)
const players = ref<string[]>([])
const selectedPlayer = ref('')
const playerBusy = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null
let playersTimer: ReturnType<typeof setInterval> | null = null
let unsub: (() => void) | null = null
let busy = false

const hasTrack = computed(() => Boolean(state.value.track))
const playing = computed(() => state.value.status === 'Playing')

// Smooth playback position: `aidj.lyrics` polls every 600ms, so between polls we
// advance the last-known position by wall-clock time on a rAF loop. Without this
// the karaoke fill (and progress bar) would jump in 600ms steps instead of
// gliding. Player positions are also QUANTIZED (VLC & co. update their counter
// on a coarse timer), so 1:1 interpolation can run slightly AHEAD of the raw
// value. The loop therefore only ever moves FORWARD — it holds the max reached
// so far instead of rolling back — and a genuinely large backward raw delta is
// treated as a real reset (track change / backward seek) and snapped.
const smoothPos = ref(0)
let lastRawAt = 0
let lastRawPos = 0
let rafId = 0

/** A raw-position backward move larger than this (ms) is a real reset
 *  (track change / backward seek), not player quantization jitter. */
const BACK_SEEK_MS = 500

/** Anchor the rAF interpolation to a freshly polled raw position. */
function anchorPosition(pos: number | null | undefined): void {
  const now = performance.now()
  if (pos == null) {
    lastRawPos = 0
    lastRawAt = now
    smoothPos.value = 0
    return
  }
  if (!lastRawAt) {
    lastRawPos = pos
    lastRawAt = now
    smoothPos.value = pos
    return
  }
  const rawDelta = pos - lastRawPos
  if (rawDelta < -BACK_SEEK_MS) {
    // Real reset: snap, don't animate backward.
    lastRawPos = pos
    lastRawAt = now
    smoothPos.value = pos
    return
  }
  lastRawPos = pos
  lastRawAt = now
  // Normal case: never let the displayed position roll back below what the
  // previous interpolation already reached (quantization overshoot).
  if (pos > smoothPos.value) smoothPos.value = pos
}

function smoothLoop(): void {
  if (playing.value && lastRawAt) {
    const p = lastRawPos + (performance.now() - lastRawAt)
    if (p > smoothPos.value) smoothPos.value = p
  } else {
    smoothPos.value = lastRawPos
  }
  rafId = requestAnimationFrame(smoothLoop)
}

// Re-anchor on pause→play so the wall-clock advance never includes the paused
// span (a stale lastRawAt would otherwise jump the position forward on resume).
watch(playing, (v) => {
  if (v) {
    lastRawAt = performance.now()
  } else {
    lastRawAt = 0
    smoothPos.value = lastRawPos
  }
})

const positionMs = computed(() => smoothPos.value + (cfg.value.position_offset_ms ?? 0))
const durationMs = computed(() => state.value.lengthMs ?? 0)

const statusText = computed(() => {
  const s = state.value.status
  if (s === 'Playing') return t('aidj.lyrics_page.playing', 'Playing')
  if (s === 'Paused') return t('aidj.lyrics_page.paused', 'Paused')
  if (s === 'Stopped') return t('aidj.lyrics_page.stopped', 'Stopped')
  return t('aidj.lyrics_page.unknown', 'Unknown')
})
const statusColor = computed(() => {
  if (state.value.status === 'Playing') return 'success'
  if (state.value.status === 'Paused') return 'warning'
  if (state.value.status === 'Stopped') return 'error'
  return 'grey'
})

// Memoized by content string: every 600ms poll hands back a freshly serialized
// (same-content) lyric string, which would otherwise re-parse the whole LRC and
// re-render the entire list each tick. Caching on the raw string keeps the array
// identity stable so Vue patches nothing between polls.
let lastLyricText = ''
let lastLyricParsed: LyricLine[] = []
const lrcLines = computed<LyricLine[]>(() => {
  // Prefer the inline-timestamp karaoke LRC (from Netease YRC) when a song has
  // one — each word then carries its own time and real karaoke fills work.
  // Otherwise fall back to the plain LRC (fill window spans to the next line).
  const lyric = state.value.karaokeLyric ?? state.value.lyric ?? ''
  if (lyric !== lastLyricText) {
    lastLyricText = lyric
    lastLyricParsed = parseLyrics(lyric)
  }
  return lastLyricParsed
})
const plainLyric = computed<string>(() => {
  const lyric = state.value.karaokeLyric ?? state.value.lyric ?? ''
  return lrcLines.value.length ? '' : stripLrcTags(lyric)
})

/**
 * Source of the lyric currently shown: `yrc` when the inline-timestamp karaoke
 * LRC (Netease YRC) is used, `lrc` when falling back to the plain LRC, or ''
 * when no lyric is available.
 */
const lyricSource = computed<'yrc' | 'lrc' | ''>(() => {
  if (state.value.karaokeLyric) return 'yrc'
  if (state.value.lyric) return 'lrc'
  return ''
})
const lyricSourceLabel = computed(() =>
  lyricSource.value === 'yrc'
    ? t('aidj.lyrics_page.yrc', 'YRC')
    : lyricSource.value === 'lrc'
      ? t('aidj.lyrics_page.lrc', 'LRC')
      : ''
)

/**
 * Immersive mode: when enabled AND a cover is available, paint the cover as a
 * full-page background instead of the user-configured one. Without a cover the
 * page falls back to the normal (transparent) background.
 */
const immerseActive = computed(() => Boolean(cfg.value.immerse_mode && coverUrl))

/** Index of the current line (last whose start time ≤ playback position). */
const currentIdx = computed(() => {
  const lines = lrcLines.value
  if (!lines.length) return -1
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= positionMs.value) idx = i
    else break
  }
  return idx
})

/** End of the last lyric line (fallback for fill timing on the final line). */
const lyricEndMs = computed(() => {
  const lines = lrcLines.value
  if (!lines.length) return 0
  const last = lines[lines.length - 1].time
  return Math.max(durationMs.value, last + 5000)
})

/**
 * Karaoke fill percentage (0–100) for the current line. The whole line is drawn
 * with a `background-clip: text` gradient mask whose hard stop sits at this
 * percent — no per-word elements, no text-shadow, so updating it each frame is
 * a single cheap repaint. The fill window is `[line.time, end)`: real inline
 * timestamps use the last word's time, plain lines spread to the next line.
 */
const fillPercent = computed(() => {
  const lines = lrcLines.value
  const line = lines[currentIdx.value]
  if (!line || !cfg.value.karaoke) return 0
  const end =
    line.chunks.length > 1
      ? line.chunks[line.chunks.length - 1].time
      : currentIdx.value + 1 < lines.length
        ? lines[currentIdx.value + 1].time
        : lyricEndMs.value
  const span = Math.max(1, end - line.time)
  return Math.min(100, Math.max(0, ((positionMs.value - line.time) / span) * 100))
})

const maskStyle = computed(() => ({ '--lyr-kfill': `${fillPercent.value.toFixed(2)}%` }))

const scrollMode = computed(() => cfg.value.scroll_follow !== false)

/** Static-window mode: the slice of lines shown around the current one. */
const visibleStart = computed(() =>
  Math.max(0, currentIdx.value - Math.max(0, cfg.value.lines_before ?? 0))
)
const visibleEnd = computed(() =>
  Math.min(lrcLines.value.length, currentIdx.value + Math.max(0, cfg.value.lines_after ?? 0) + 1)
)
const visibleLines = computed(() => lrcLines.value.slice(visibleStart.value, visibleEnd.value))

const progressPct = computed(() =>
  durationMs.value > 0 ? Math.min(100, Math.round((positionMs.value / durationMs.value) * 100)) : 0
)

function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** Theme-driven typography (no colors — those always come from the theme). */
const lyricStyle = computed(() => {
  const c = cfg.value
  return {
    '--lyr-font': `'${(c.font_family ?? 'Iansui Regular').replace(/'/g, '')}', 'Noto Sans CJK SC', sans-serif`,
    '--lyr-size': `${Math.max(18, Math.min(46, c.font_size ?? 34))}px`,
    '--lyr-candidate-size': `${Math.max(13, Math.min(28, c.candidate_size ?? 20))}px`,
    '--lyr-current-weight': String(Math.max(500, Math.min(900, c.current_weight ?? 700))),
    '--lyr-candidate-weight': String(Math.max(400, Math.min(700, c.candidate_weight ?? 500))),
    '--lyr-line-height': String(Math.max(1, Math.min(2, c.line_height ?? 1.3))),
    '--lyr-letter-spacing': `${Math.max(-2, Math.min(8, c.letter_spacing ?? 0))}px`,
    '--lyr-gap': `${Math.max(4, Math.min(24, c.line_gap ?? 10))}px`
  } as Record<string, string>
})

// -- scroll-follow ----------------------------------------------------------
const scrollEl = ref<HTMLElement | null>(null)
const padPx = ref(0)
/** True while a recenter settle loop is running — coalesces resize bursts. */
let recenterActive = false

/**
 * Keeps the current line vertically centered. Resize is observed on the scroll
 * CONTAINER itself (not just `window`): after a maximize→restore the nested
 * absolute `.v-main--scrollable` chain can lag one layout pass behind the
 * window resize event, so measuring `clientHeight` synchronously there reads
 * the stale (maximized) height — the scroll area then stays oversized and its
 * text spills under the header. Re-measuring on the next animation frame
 * guarantees the settled post-resize height.
 *
 * A SINGLE frame still isn't enough for a maximize→restore: the container and
 * its inner content settle over a couple of layout passes, so the first
 * `clientHeight`/`offsetTop` pair can keep describing the previous (maximized)
 * geometry and the current line lands off-center. This loop therefore keeps
 * re-measuring and re-centering on consecutive frames until two measurements
 * agree — the exact thing that "just dragging the window a little" does by
 * accident afterwards, minus the manual part.
 *
 * `padPx` is reactive: the new padding only lands in the DOM on the next Vue
 * flush, so `followCurrent` must NOT read `offsetTop` in the same tick as
 * `computePad` — it would compute the center against the OLD padding. Await
 * the flush (`nextTick`) in between.
 */
function recenter(): void {
  if (!scrollMode.value || recenterActive) return
  recenterActive = true
  let lastH = -1
  let lastTop = -1
  const tick = (): void => {
    if (!scrollMode.value || !scrollEl.value) {
      recenterActive = false
      return
    }
    const h = scrollEl.value.clientHeight
    computePad()
    nextTick(() => {
      if (!scrollMode.value || !scrollEl.value?.isConnected) {
        recenterActive = false
        return
      }
      const top = followCurrent()
      if (top === lastTop && h === lastH) {
        recenterActive = false
        return
      }
      lastTop = top
      lastH = h
      requestAnimationFrame(tick)
    })
  }
  requestAnimationFrame(tick)
}

let padRO: ResizeObserver | null = null
function setScrollEl(el: unknown): void {
  const next = (el as HTMLElement | null) ?? null
  if (scrollEl.value === next) return
  scrollEl.value = next
  padRO?.disconnect()
  padRO = null
  if (next) {
    padRO = new ResizeObserver(() => recenter())
    padRO.observe(next)
  }
}

/** Half the viewport height as top/bottom padding so the first/last lines can
 *  reach the vertical center (the classic lyric-scroll trick). */
function computePad(): void {
  const el = scrollEl.value
  padPx.value = el ? Math.max(60, Math.round(el.clientHeight / 2)) : 0
}

/** Scroll the current line to the vertical center. Returns the scrollTop it
 *  targeted (−1 when there's nothing to center, e.g. no lyrics yet). */
function followCurrent(): number {
  const idx = currentIdx.value
  const el = scrollEl.value
  if (idx < 0 || !el) return -1
  const target = el.querySelector(`[data-line-idx="${idx}"]`) as HTMLElement | null
  if (!target) return -1
  const cH = el.clientHeight
  const top = Math.max(0, target.offsetTop - cH / 2 + target.offsetHeight / 2)
  el.scrollTo({ top })
  return top
}

watch(
  () => [currentIdx.value, scrollMode.value],
  () => recenter(),
  { flush: 'post' }
)

// -- controls ----------------------------------------------------------------
async function control(cmd: 'prev' | 'toggle' | 'next' | 'stop'): Promise<void> {
  await window.cockpit.command(`aidj.${cmd}`).catch(() => null)
}

function shortPlayer(name: string): string {
  const short = name.replace(/^org\.mpris\.MediaPlayer2\./, '')
  if (short.length <= 14) return short
  return short.slice(0, 7) + '…' + short.slice(-4)
}

const playerItems = computed(() => [
  { title: t('aidj.current_active', '当前激活'), value: '__auto__' },
  ...players.value.map((p) => ({ title: shortPlayer(p), value: p }))
])

async function pollPlayers(): Promise<void> {
  const res = (await withTimeout(window.cockpit.command('aidj.lyrics-player'), 5000, null)) as {
    ok?: boolean
    players?: string[]
    current?: string
    auto?: boolean
  } | null
  if (!res?.ok || !Array.isArray(res.players)) return
  players.value = res.players
  selectedPlayer.value = res.auto ? '__auto__' : res.current || selectedPlayer.value
}

async function selectPlayer(name: string): Promise<void> {
  if (!name || playerBusy.value) return
  playerBusy.value = true
  try {
    const res = (await withTimeout(
      window.cockpit.command('aidj.lyrics-select-player', { name }),
      4000,
      null
    )) as { ok?: boolean } | null
    if (res?.ok) {
      selectedPlayer.value = name
      void poll()
    }
  } finally {
    playerBusy.value = false
  }
}

async function toggleLyricsWindow(): Promise<void> {
  const res = (await window.cockpit.command('aidj.lyrics-toggle').catch(() => null)) as {
    open?: boolean
  } | null
  if (res && typeof res.open === 'boolean') lyricsOpen.value = res.open
}

async function refreshLyricsOpen(): Promise<void> {
  const res = (await window.cockpit.command('aidj.lyrics-state').catch(() => null)) as {
    open?: boolean
  } | null
  lyricsOpen.value = res?.open === true
}

async function loadConfig(): Promise<void> {
  const res = (await window.cockpit.command('aidj.lyrics-page-config').catch(() => null)) as {
    ok?: boolean
    config?: Partial<AidjLyricsPageConfig>
  } | null
  if (res?.ok && res.config) cfg.value = { ...DEFAULT_LYRICS_PAGE_CFG, ...res.config }
}

// -- polling + cover ---------------------------------------------------------
/** Race a command against a timeout so the loading spinner can never stick. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    p.then((v) => {
      clearTimeout(timer)
      resolve(v)
    }).catch(() => {
      clearTimeout(timer)
      resolve(fallback)
    })
  })
}

async function poll(): Promise<void> {
  if (busy) return
  busy = true
  try {
    const res = (await withTimeout(
      window.cockpit.command('aidj.lyrics'),
      5000,
      null
    )) as PlaybackState | null
    if (res && typeof res === 'object') {
      state.value = res
      // Anchor the rAF interpolation at this poll's position (forward-only).
      anchorPosition(res.positionMs)
    }
  } catch {
    /* keep last state */
  } finally {
    busy = false
  }
}

let lastCoverPath = ''
async function refreshCover(): Promise<void> {
  const path = state.value.path
  if (!path || path === lastCoverPath) return
  lastCoverPath = path
  const res = (await window.cockpit.command('aidj.get-cover', { path }).catch(() => null)) as {
    ok?: boolean
    url?: string
  } | null
  coverUrl.value = res?.ok ? (res.url ?? '') : ''
}

watch(
  () => state.value.path,
  () => void refreshCover()
)

function toMarkdown(): string {
  const lines = lrcLines.value.length
    ? lrcLines.value.map((l) => l.text).join('\n')
    : plainLyric.value
  const head = [state.value.track, state.value.artist, state.value.album]
    .filter(Boolean)
    .join(' — ')
  return head ? `${head}\n\n${lines}` : lines || t('aidj.lyrics_page.waiting', 'Waiting to play…')
}

function onResize(): void {
  recenter()
}

onMounted(async () => {
  // Opening the lyrics page always activates AIDJ's shared DBus binding (the
  // main AIDJ page is keep-alive, so once bound it stays), so the "当前激活"
  // auto mode and per-player binding work without first starting AIDJ.
  await Promise.all([
    poll(),
    pollPlayers(),
    refreshLyricsOpen(),
    loadConfig(),
    withTimeout(window.cockpit.command('aidj.activate'), 5000, null).catch(() => null)
  ])
  recenter()
  pollTimer = setInterval(() => void poll(), 600)
  playersTimer = setInterval(() => void pollPlayers(), 10000)
  rafId = requestAnimationFrame(smoothLoop)
  unsub = window.cockpit.on('cockpit:windows', () => {
    void refreshLyricsOpen()
  })
  window.addEventListener('resize', onResize)
})

// The page is keep-alive'd: a window resize that happened while it was
// deactivated never reached the container observer, so re-measure on return.
onActivated(() => recenter())

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (playersTimer) clearInterval(playersTimer)
  cancelAnimationFrame(rafId)
  padRO?.disconnect()
  padRO = null
  unsub?.()
  window.removeEventListener('resize', onResize)
})

defineExpose({ toMarkdown })
</script>

<template>
  <div class="aidj-lyrics-page" :class="{ 'is-immerse': immerseActive }" :style="lyricStyle">
    <!-- immersive background: blurred + dimmed cover behind everything -->
    <div v-if="immerseActive" class="lyrics-immerse-bg" aria-hidden="true">
      <div class="lyrics-immerse-bg-img" :style="{ backgroundImage: `url(${coverUrl})` }"></div>
      <div class="lyrics-immerse-bg-scrim"></div>
    </div>

    <!-- header: track + player + controls -->
    <template v-if="cfg.show_header !== false">
      <div class="lyrics-header">
        <div class="lyrics-cover">
          <img v-if="coverUrl" :src="coverUrl" class="lyrics-cover-img" alt="" />
          <v-icon v-else size="40">mdi-music-note-eighth</v-icon>
        </div>

        <div class="min-w-0 flex-grow-1 d-flex flex-column ga-1">
          <div class="d-flex align-center ga-2 flex-wrap">
            <span class="lyrics-track-name">{{
              hasTrack ? state.track : t('aidj.lyrics_page.waiting', 'Waiting to play…')
            }}</span>
            <v-chip size="small" :color="statusColor" variant="tonal" class="lyrics-chip">
              {{ statusText }}
            </v-chip>
            <v-chip
              v-if="lyricSource"
              size="small"
              variant="flat"
              color="primary"
              class="lyrics-chip lyrics-source-chip"
            >
              {{ lyricSourceLabel }}
            </v-chip>
          </div>
          <div v-if="state.artist || state.album" class="lyrics-track-sub">
            {{ [state.artist, state.album].filter(Boolean).join(' · ') }}
          </div>
          <div v-if="state.player" class="lyrics-player-sub">
            <v-icon size="14">mdi-music-box-multiple-outline</v-icon>
            <span>{{ state.player }}</span>
          </div>
        </div>

        <div class="lyrics-controls">
          <v-select
            v-model="selectedPlayer"
            :items="playerItems"
            :label="t('aidj.lyrics_page.player', 'Player')"
            density="compact"
            variant="outlined"
            hide-details
            :loading="playerBusy"
            class="lyrics-player-select"
            @update:model-value="selectPlayer"
          />
          <div class="d-flex align-center ga-1">
            <v-tooltip :text="t('aidj.lyrics_page.prev', 'Previous')" location="top">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  variant="text"
                  icon="mdi-skip-previous"
                  size="small"
                  @click="control('prev')"
                />
              </template>
            </v-tooltip>
            <v-tooltip :text="t('aidj.lyrics_page.play', 'Play / Pause')" location="top">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  variant="tonal"
                  color="primary"
                  :icon="playing ? 'mdi-pause' : 'mdi-play'"
                  size="small"
                  @click="control('toggle')"
                />
              </template>
            </v-tooltip>
            <v-tooltip :text="t('aidj.lyrics_page.next', 'Next')" location="top">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  variant="text"
                  icon="mdi-skip-next"
                  size="small"
                  @click="control('next')"
                />
              </template>
            </v-tooltip>
            <v-tooltip :text="t('aidj.lyrics_page.stop', 'Stop')" location="top">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  variant="text"
                  icon="mdi-stop"
                  size="small"
                  @click="control('stop')"
                />
              </template>
            </v-tooltip>
            <v-tooltip :text="t('aidj.lyrics_page.desktop', 'Desktop lyrics')" location="top">
              <template #activator="{ props }">
                <v-btn
                  v-bind="props"
                  variant="text"
                  :color="lyricsOpen ? 'primary' : undefined"
                  :icon="lyricsOpen ? 'mdi-music-note-plus' : 'mdi-music-note-outline'"
                  size="small"
                  @click="toggleLyricsWindow"
                />
              </template>
            </v-tooltip>
          </div>
        </div>
      </div>

      <!-- progress -->
      <div class="lyrics-progress">
        <v-progress-linear
          :model-value="progressPct"
          color="primary"
          rounded
          height="4"
          class="flex-grow-1"
        />
        <span class="lyrics-time">{{ fmtTime(positionMs) }} / {{ fmtTime(durationMs) }}</span>
      </div>
    </template>

    <!-- lyrics body -->
    <div class="lyrics-body">
      <template v-if="hasTrack">
        <!-- scroll mode: all lines, current one auto-centered -->
        <div
          v-if="lrcLines.length && scrollMode"
          :ref="setScrollEl"
          class="lyric-scroll"
          :style="{ paddingTop: padPx + 'px', paddingBottom: padPx + 'px' }"
        >
          <div
            v-for="(line, i) in lrcLines"
            :key="i"
            :data-line-idx="i"
            class="lyric-line"
            :class="{
              'is-current': i === currentIdx,
              'is-dim': cfg.dim_candidates !== false && i !== currentIdx && !playing
            }"
          >
            <template v-if="i === currentIdx && cfg.karaoke && line.text">
              <span class="karaoke-mask" :style="maskStyle">{{ line.text }}</span>
            </template>
            <span v-else>{{ line.text }}</span>
          </div>
        </div>
        <!-- static window mode: current line ± before/after, centered -->
        <div v-else-if="lrcLines.length" class="lyric-window">
          <div
            v-for="(line, j) in visibleLines"
            :key="visibleStart + j"
            class="lyric-line"
            :class="{
              'is-current': visibleStart + j === currentIdx,
              'is-dim': cfg.dim_candidates !== false && visibleStart + j !== currentIdx && !playing
            }"
          >
            <template v-if="visibleStart + j === currentIdx && cfg.karaoke && line.text">
              <span class="karaoke-mask" :style="maskStyle">{{ line.text }}</span>
            </template>
            <span v-else>{{ line.text }}</span>
          </div>
        </div>
        <div v-else-if="plainLyric" class="lyric-plain">{{ plainLyric }}</div>
        <v-empty-state
          v-else
          icon="mdi-music-note-off-outline"
          :title="t('aidj.lyrics_page.noLyric', 'No lyrics')"
          :text="t('aidj.lyrics_page.noLyricHint', 'This track has no stored LRC lyric yet.')"
        />
      </template>
      <v-empty-state
        v-else
        icon="mdi-music-note-off-outline"
        :title="t('aidj.lyrics_page.noTrack', 'Nothing playing')"
        :text="
          t(
            'aidj.lyrics_page.noTrackHint',
            'Lyrics will appear here once AI DJ starts playing a song.'
          )
        "
      />
    </div>
  </div>
</template>

<style scoped>
.aidj-lyrics-page {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 16px 20px;
  overflow: hidden;
  /* Contain the immersive cover's stacking so it stays behind the page content. */
  isolation: isolate;
}

/* -- immersive mode --------------------------------------------------------- */
/* Blurred + dimmed cover fills the page (the app's background/fuse layers sit
   at fixed z-index -2/-1, so this z-index:-1 child replaces what's visible in
   the lyrics area while staying above those layers). */
.lyrics-immerse-bg {
  position: absolute;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
}
.lyrics-immerse-bg-img {
  position: absolute;
  inset: -32px;
  background-size: cover;
  background-position: center;
  filter: blur(32px);
  /* Overscan so the blur never exposes a fringe at the edges. */
  transform: scale(1.1);
}
.lyrics-immerse-bg-scrim {
  position: absolute;
  inset: 0;
  /* Theme-tinted dimmer: dark in dark themes, light in light themes, so text
     stays readable regardless of how bright/busy the cover is. */
  background: rgba(var(--v-theme-background), 0.55);
}

.lyrics-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-radius: 14px;
  background: rgba(var(--v-theme-surface-variant), 0.5);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.12);
}

.lyrics-cover {
  width: 88px;
  height: 88px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: rgba(var(--v-theme-primary), 0.12);
  color: rgb(var(--v-theme-primary));
  overflow: hidden;
}
.lyrics-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.lyrics-track-name {
  font-size: 1.15rem;
  font-weight: 600;
  color: rgb(var(--v-theme-on-surface));
}
.lyrics-chip {
  padding-block: 4px;
  min-height: 24px;
}
.lyrics-source-chip {
  font-weight: 700;
  letter-spacing: 0.5px;
}
.lyrics-track-sub {
  font-size: 0.85rem;
  color: rgb(var(--v-theme-on-surface-variant));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lyrics-player-sub {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
  opacity: 0.75;
}

.lyrics-controls {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.lyrics-player-select {
  width: 220px;
  max-width: 260px;
}

.lyrics-progress {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 4px;
}
.lyrics-time {
  font-size: 0.75rem;
  color: rgb(var(--v-theme-on-surface-variant));
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.lyrics-body {
  position: relative;
  flex-grow: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

/* -- scroll mode ---------------------------------------------------------- */
/* Absolute fill of the (flex-bounded) body instead of `height: 100%` inside a
   `justify-content: center` flex — after a maximize→restore the percentage
   height could resolve against a stale (maximized) body box and leave the
   scroll area oversized, so its text spilled under the header. Absolute inset
   + the body's overflow:hidden clip it to the real area every time. */
.lyric-scroll {
  position: absolute;
  inset: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  scroll-behavior: smooth;
  /* Firefox */
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--v-theme-on-surface-variant), 0.4) transparent;
}
.lyric-scroll::-webkit-scrollbar {
  width: 10px;
}
.lyric-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.lyric-scroll::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.3);
  border-radius: 5px;
  border: 2px solid transparent;
  background-clip: padding-box;
  transition: background-color 0.15s ease;
}
.lyric-scroll::-webkit-scrollbar-thumb:hover {
  background: rgba(var(--v-theme-on-surface-variant), 0.55);
  background-clip: padding-box;
}
.lyric-scroll::-webkit-scrollbar-corner {
  background: transparent;
}

/* -- static window mode ---------------------------------------------------- */
.lyric-window {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--lyr-gap);
}

.lyric-line {
  font-family: var(--lyr-font);
  font-size: var(--lyr-candidate-size);
  font-weight: var(--lyr-candidate-weight);
  line-height: var(--lyr-line-height);
  letter-spacing: var(--lyr-letter-spacing);
  color: rgb(var(--v-theme-on-surface-variant));
  text-align: center;
  padding: 2px 12px;
  border-radius: 10px;
  transition:
    color 0.18s ease,
    transform 0.18s ease,
    background-color 0.18s ease;
  max-width: 100%;
}
.lyric-scroll > .lyric-line {
  width: 100%;
  box-sizing: border-box;
  flex-shrink: 0;
}
.lyric-line.is-current {
  font-size: var(--lyr-size);
  font-weight: var(--lyr-current-weight);
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.08);
  transform: scale(1.03);
}
.lyric-line.is-dim {
  opacity: 0.5;
}

/* -- karaoke: single text-clipped gradient mask, fill % driven by a CSS var.
      No per-word spans and no text-shadow → updating --lyr-kfill each frame is
      one cheap repaint, so the fill stays smooth at 60fps. ------------------- */
.lyric-line.is-current .karaoke-mask {
  background-image: linear-gradient(
    90deg,
    rgb(var(--v-theme-primary)) var(--lyr-kfill),
    rgba(var(--v-theme-on-surface-variant), 0.55) var(--lyr-kfill)
  );
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
}

.lyric-plain {
  font-family: var(--lyr-font);
  font-size: var(--lyr-candidate-size);
  line-height: var(--lyr-line-height);
  color: rgb(var(--v-theme-on-surface-variant));
  text-align: center;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 100%;
  overflow-y: auto;
  padding: 4px 8px;
  scrollbar-width: thin;
  scrollbar-color: rgba(var(--v-theme-on-surface-variant), 0.4) transparent;
}
.lyric-plain::-webkit-scrollbar {
  width: 10px;
}
.lyric-plain::-webkit-scrollbar-track {
  background: transparent;
}
.lyric-plain::-webkit-scrollbar-thumb {
  background: rgba(var(--v-theme-on-surface-variant), 0.3);
  border-radius: 5px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.lyric-plain::-webkit-scrollbar-thumb:hover {
  background: rgba(var(--v-theme-on-surface-variant), 0.55);
  background-clip: padding-box;
}
</style>
