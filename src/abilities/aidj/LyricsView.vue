<script setup lang="ts">
import { ref, inject, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
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
      const text = pendingText.trim()
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
const positionMs = computed(
  () => (state.value.positionMs ?? 0) + (cfg.value.position_offset_ms ?? 0)
)
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

const lrcLines = computed<LyricLine[]>(() => {
  const lyric = state.value.lyric
  if (!lyric) return []
  return parseLyrics(lyric)
})
const plainLyric = computed<string>(() => {
  const lyric = state.value.lyric ?? ''
  return lrcLines.value.length ? '' : stripLrcTags(lyric)
})

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

/** Within the current line, last chunk whose time ≤ playback position. */
const activeChunkIdx = computed(() => {
  const line = lrcLines.value[currentIdx.value]
  if (!line) return -1
  let idx = -1
  for (let i = 0; i < line.chunks.length; i++) {
    if (line.chunks[i].time <= positionMs.value) idx = i
    else break
  }
  return idx
})

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
function setScrollEl(el: unknown): void {
  scrollEl.value = (el as HTMLElement | null) ?? null
}

/** Half the viewport height as top/bottom padding so the first/last lines can
 *  reach the vertical center (the classic lyric-scroll trick). */
function computePad(): void {
  const el = scrollEl.value
  padPx.value = el ? Math.max(60, Math.round(el.clientHeight / 2)) : 0
}

function followCurrent(): void {
  const idx = currentIdx.value
  const el = scrollEl.value
  if (idx < 0 || !el) return
  const target = el.querySelector(`[data-line-idx="${idx}"]`) as HTMLElement | null
  if (!target) return
  const cH = el.clientHeight
  el.scrollTo({ top: Math.max(0, target.offsetTop - cH / 2 + target.offsetHeight / 2) })
}

watch(
  () => [currentIdx.value, scrollMode.value],
  () =>
    void nextTick(() => {
      if (scrollMode.value) {
        computePad()
        followCurrent()
      }
    }),
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
    if (res && typeof res === 'object') state.value = res
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
  if (scrollMode.value) {
    computePad()
    followCurrent()
  }
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
  void nextTick(() => {
    if (scrollMode.value) {
      computePad()
      followCurrent()
    }
  })
  pollTimer = setInterval(() => void poll(), 600)
  playersTimer = setInterval(() => void pollPlayers(), 10000)
  unsub = window.cockpit.on('cockpit:windows', () => {
    void refreshLyricsOpen()
  })
  window.addEventListener('resize', onResize)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (playersTimer) clearInterval(playersTimer)
  unsub?.()
  window.removeEventListener('resize', onResize)
})

defineExpose({ toMarkdown })
</script>

<template>
  <div class="aidj-lyrics-page" :style="lyricStyle">
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
            <template v-if="i === currentIdx && cfg.karaoke && line.chunks.length > 1">
              <span
                v-for="(chunk, ci) in line.chunks"
                :key="ci"
                class="karaoke-chunk"
                :class="{ 'is-active': ci <= activeChunkIdx }"
                >{{ chunk.text }}</span
              >
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
            <template
              v-if="visibleStart + j === currentIdx && cfg.karaoke && line.chunks.length > 1"
            >
              <span
                v-for="(chunk, ci) in line.chunks"
                :key="ci"
                class="karaoke-chunk"
                :class="{ 'is-active': ci <= activeChunkIdx }"
                >{{ chunk.text }}</span
              >
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
  flex-grow: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

/* -- scroll mode ---------------------------------------------------------- */
.lyric-scroll {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  position: relative;
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

/* -- karaoke: per-word fill on the current line ---------------------------- */
.lyric-line.is-current .karaoke-chunk {
  color: rgba(var(--v-theme-on-surface-variant), 0.55);
  transition: color 0.05s linear;
}
.lyric-line.is-current .karaoke-chunk.is-active {
  color: rgb(var(--v-theme-primary));
  text-shadow: 0 0 12px rgba(var(--v-theme-primary), 0.45);
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
