<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { translate } from '@ui/i18n'
import { DEFAULT_LYRICS_CFG } from '@abilities/aidj/types'
import type { LyricsDisplayConfig } from '@abilities/aidj/types'

interface LyricLine {
  time: number
  text: string
}

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
}

// -- language: standalone window root has no App.vue to provide it, read config --
const uiLang = ref<string>('zh')
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

// Self identity: `?id=` is appended by the window manager.
const myWindowId = new URLSearchParams(location.search).get('id') ?? ''

// -- display config (preferences.lyrics, mirrors `vp wshowlyrics` flags) -----
const lyricsCfg = ref<LyricsDisplayConfig>(DEFAULT_LYRICS_CFG)

/** `RRGGBBAA` hex → CSS rgba(). Anything malformed → fully transparent. */
function hexToRgba(hex: string): string {
  const h = (hex || '').replace(/^#/, '').trim()
  if (!/^[0-9a-fA-F]{8}$/.test(h)) return 'rgba(0, 0, 0, 0)'
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(
    h.slice(4, 6),
    16
  )}, ${(parseInt(h.slice(6, 8), 16) / 255).toFixed(3)})`
}

const rootStyle = computed(() => {
  const c = lyricsCfg.value
  const shadow = Math.min(1, Math.max(0, c.shadow ?? 0.5))
  return {
    '--lyr-bg': hexToRgba(c.bg_color),
    '--lyr-fg': hexToRgba(c.fg_color),
    '--lyr-header-color': hexToRgba(c.header_color ?? c.fg_color),
    '--lyr-candidate-color': hexToRgba(c.candidate_color ?? c.fg_color),
    '--lyr-font': `'${c.font_family.replace(/'/g, '')}', 'Iansui', 'Noto Sans CJK SC', sans-serif`,
    '--lyr-size': `${Math.max(10, c.font_size)}px`,
    '--lyr-header-size': `${Math.max(8, c.header_size ?? 13)}px`,
    '--lyr-candidate-size': `${Math.max(8, c.candidate_size ?? Math.round(c.font_size * 0.6))}px`,
    '--lyr-current-weight': `${Math.max(400, Math.min(900, c.current_weight ?? 700))}`,
    '--lyr-candidate-weight': `${Math.max(400, Math.min(900, c.candidate_weight ?? 500))}`,
    '--lyr-header-weight': `${Math.max(400, Math.min(900, c.header_weight ?? 600))}`,
    '--lyr-line-height': `${Math.max(1, Math.min(2, c.line_height ?? 1.3))}`,
    '--lyr-letter-spacing': `${Math.max(-2, Math.min(8, c.letter_spacing ?? 0))}px`,
    '--lyr-shadow': shadow > 0 ? `0 1px 3px rgba(0, 0, 0, ${shadow.toFixed(2)})` : 'none',
    '--lyr-margin': `${Math.max(0, c.margin)}px`,
    '--lyr-gap': `${Math.max(2, c.line_gap ?? 6)}px`,
    '--lyr-card-radius': `${Math.max(0, c.card_radius ?? 12)}px`,
    '--lyr-card-pad-y': `${Math.max(0, c.card_padding_y ?? 12)}px`,
    '--lyr-card-pad-x': `${Math.max(0, c.card_padding_x ?? 26)}px`
  } as Record<string, string>
})

const anchorClass = computed(() => `anchor-${lyricsCfg.value.anchor}`)

/**
 * Center + anchor placement, computed in the MAIN process from the window's
 * real bounds and the display it is on (renderer window.innerWidth / screen
 * are unreliable on Wayland, especially after auto-fit resizes). The main
 * process skips when the requested position is unchanged.
 */
async function applyAnchorPlacement(): Promise<void> {
  const c = lyricsCfg.value
  void window.cockpit.centerWindow(c.anchor, c.margin)
}

/**
 * App-level lock state. Electron's setIgnoreMouseEvents is a no-op on Wayland
 * (the compositor owns input), so to make "locked" mean anything there we also
 * refuse every pointer interaction in the renderer: no context menu, no drag.
 * Kept in sync via the `cockpit:windows` broadcast (BT-panel unlock included).
 */
const locked = ref(false)
let winUnsub: (() => void) | null = null

const state = ref<PlaybackState>({})
const pollTimer = ref<ReturnType<typeof setInterval> | null>(null)

/** Consecutive `ok:false` polls → the bound DBus player is gone; nothing left
 *  to read so the window closes itself. */
const FAIL_LIMIT = 3
let failCount = 0

/** Parse an LRC document into time-sorted lines (bracket tags + [offset]). */
function parseLrc(lrc: string): LyricLine[] {
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
    const timeTags = line.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)
    if (!timeTags) continue
    const text = line.replace(/\[[^\]]*\]/g, '').trim()
    // Keep the timestamp even when the text is empty — it's a timing boundary.
    // Empty-text lines are skipped only at RENDER time (see windowLines).
    for (const tag of timeTags) {
      const m = tag.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/)
      if (!m) continue
      const frac = Number(m[3] ?? '0')
      const ms =
        Number(m[1]) * 60000 + Number(m[2]) * 1000 + (frac < 100 ? frac * 10 : frac) + offset
      lines.push({ time: ms, text })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

const lrcLines = computed<LyricLine[]>(() => {
  const lyric = state.value.lyric
  if (!lyric) return []
  return parseLrc(lyric)
})

const plainLyric = computed<string>(() => {
  const lyric = state.value.lyric ?? ''
  return lrcLines.value.length ? '' : lyric.replace(/\[[^\]]*\]/g, '').trim()
})

const positionMs = computed(() =>
  (state.value.positionMs ?? 0) + (lyricsCfg.value.position_offset_ms ?? 0)
)

/** Index of the current line: the last line whose time ≤ playback position. */
const currentIdx = computed(() => {
  if (!lrcLines.value.length) return -1
  let idx = -1
  for (let i = 0; i < lrcLines.value.length; i++) {
    if (lrcLines.value[i].time <= positionMs.value) idx = i
    else break
  }
  return idx
})

/** Display index: walk the current line back to the nearest TEXT line, so an
 *  empty-timestamp line (an instrumental gap) keeps the previous lyric lit —
 *  only when `ignore_empty_lines` is enabled. */
const displayIdx = computed(() => {
  let i = currentIdx.value
  if (lyricsCfg.value.ignore_empty_lines === false) return i
  while (i >= 0 && !lrcLines.value[i].text) i--
  return i
})

/** True while the current timestamp line carries no lyric text (a gap). */
const inGap = computed(() => {
  const i = currentIdx.value
  return i >= 0 && !lrcLines.value[i].text
})

/** Static window around the current line: before + current + after (no scroll). */
const windowStart = computed(() => Math.max(0, displayIdx.value - (lyricsCfg.value.lines_before ?? 0)))
const windowEnd = computed(() =>
  Math.min(lrcLines.value.length, displayIdx.value + (lyricsCfg.value.lines_after ?? 0) + 1)
)
const windowLines = computed(() => {
  const out: { text: string; isCurrent: boolean }[] = []
  for (let i = windowStart.value; i < windowEnd.value; i++) {
    const l = lrcLines.value[i]
    if (!l || !l.text) continue // render only text lines; empty gaps stay as timing
    out.push({ text: l.text, isCurrent: i === displayIdx.value })
  }
  return out
})

const playing = computed(() => state.value.status === 'Playing')
const hasTrack = computed(() => Boolean(state.value.track))
/** No lyric text → the card backdrop goes fully transparent. When
 *  `ignore_empty_lines` is off, an instrumental gap (empty current line) also
 *  hides the window fully transparent. */
const cardEmpty = computed(() => {
  if (lyricsCfg.value.ignore_empty_lines === false && inGap.value) return true
  return !(lrcLines.value.length || plainLyric.value)
})

// -- right-click context menu (lock) ----------------------------------------
const menu = ref<{ x: number; y: number } | null>(null)
const menuOpen = ref(false)

function onContextMenu(e: MouseEvent): void {
  e.preventDefault()
  if (locked.value) return
  menu.value = { x: e.clientX, y: e.clientY }
  menuOpen.value = true
}

async function lockWindow(): Promise<void> {
  menuOpen.value = false
  locked.value = true
  await window.cockpit.setWindowLocked(true)
}

// -- manual drag (frameless window has no OS title bar) ---------------------
let dragging = false
let lastX = 0
let lastY = 0
let rafPending = false
let pendingDx = 0
let pendingDy = 0

function onPointerDown(e: PointerEvent): void {
  if (menuOpen.value || locked.value || e.button !== 0) return
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
  ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging) return
  pendingDx += e.clientX - lastX
  pendingDy += e.clientY - lastY
  lastX = e.clientX
  lastY = e.clientY
  if (!rafPending) {
    rafPending = true
    requestAnimationFrame(() => {
      rafPending = false
      if (pendingDx || pendingDy) {
        void window.cockpit.moveWindowBy(Math.round(pendingDx), Math.round(pendingDy))
        pendingDx = 0
        pendingDy = 0
      }
    })
  }
}

function onPointerUp(e: PointerEvent): void {
  dragging = false
  ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
}

async function poll(): Promise<void> {
  try {
    const res = (await window.cockpit.command('aidj.lyrics')) as PlaybackState | null
    if (res && typeof res === 'object' && res.ok === true) {
      state.value = res
      failCount = 0
      return
    }
    failCount++
  } catch {
    failCount++
  }
  // DBus unreachable — give it a moment, then tear the window down.
  if (failCount >= FAIL_LIMIT) {
    failCount = 0
    await window.cockpit.windowClose()
  }
}

/** Keep app-level lock in sync (unlock from the BT panel reaches us here). */
function onWindowsChanged(raw: unknown): void {
  if (!myWindowId) return
  try {
    const evt = raw as { type?: string; windows?: { id: string; locked?: boolean }[] } | null
    if (!evt || evt.type !== 'changed' || !Array.isArray(evt.windows)) return
    const me = evt.windows.find((w) => w.id === myWindowId)
    if (me) locked.value = me.locked === true
  } catch {
    /* ignore */
  }
}

// -- auto-expand the window width to fit long lines --------------------------
// `auto_width: false` keeps the fixed configured width; otherwise the window
// grows (up to 90% of the screen) so full lines are seen.
const baseWinW = ref(560)
const baseWinH = ref(220)
const cardEl = ref<HTMLElement | null>(null)
function setCardEl(el: unknown): void {
  cardEl.value = (el as HTMLElement | null) ?? null
}

/**
 * Wayland has NO input passthrough — a locked window still blocks its whole
 * BrowserWindow area. To shrink the blocked region to ~the visible card, resize
 * the window to the card bounds while locked.
 * The card is always horizontally centered inside the window, so shrink =
 * resize to the card size + re-center with the TARGET dims (never derive the
 * position from win.getBounds() — it's stale on Wayland after KWin moves it,
 * which caused the ever-rightward drift).
 */
let lastFit = { w: 0, h: 0 }
function fitWindowToContent(): void {
  const card = cardEl.value
  if (!card) return
  const r = card.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return
  const w = Math.ceil(r.width) + 2
  const h = Math.ceil(r.height) + 2
  if (w === lastFit.w && h === lastFit.h) return
  lastFit = { w, h }
  const c = lyricsCfg.value
  void window.cockpit.autoFitWindow(w, h, c.anchor, c.margin)
}

// Restore the base size only on the lock→unlock TRANSITION. On every line
// change (windowLines) autoFitWidth may legitimately grow the window — the
// old "size !== base → restore" logic fired then too, shrinking then growing
// the window every lyric line (the vertical/horizontal "jumping").
let wasLocked = false
watch([locked, windowLines, cardEmpty], () => {
  const nowLocked = locked.value
  void nextTick().then(() => {
    if (nowLocked) {
      fitWindowToContent()
      wasLocked = true
      lastFitW = 0
      return
    }
    if (wasLocked) {
      // just unlocked → restore the configured base size + anchor position
      wasLocked = false
      lastFitW = 0
      void window.cockpit.autoFitWindow(
        baseWinW.value,
        baseWinH.value,
        lyricsCfg.value.anchor,
        lyricsCfg.value.margin
      )
      return
    }
    autoFitWidth()
  })
})

// Last width auto-fit resized to. On Wayland `setSize` is async, so
// `window.innerWidth` lags — without this guard autoFitWidth re-resized and
// re-anchored on EVERY poll (the "kwin script ran ×100+" spam).
let lastFitW = 0
function autoFitWidth(): void {
  const card = cardEl.value
  if (!card) return
  const c = lyricsCfg.value
  const doFit = (force: boolean): void => {
    if (c.auto_width === false) {
      if (lastFitW !== baseWinW.value) {
        lastFitW = baseWinW.value
        void window.cockpit.autoFitWindow(baseWinW.value, window.innerHeight, c.anchor, c.margin)
      }
      return
    }
    const pad = 12 // breathing room around the card
    const maxW = Math.round(window.screen.availWidth * 0.9)
    const rect = card.getBoundingClientRect()
    const needed = Math.min(maxW, Math.max(baseWinW.value, Math.ceil(rect.width) + pad))
    if (needed !== lastFitW || force) {
      lastFitW = needed
      void window.cockpit.autoFitWindow(needed, window.innerHeight, c.anchor, c.margin)
    }
  }
  doFit(false)
  // Re-measure once the layout settles — the first pass can read the card
  // BEFORE a freshly-rendered long line has fully laid out (stale width →
  // under-grown window + off-center alignment).
  setTimeout(() => doFit(true), 120)
}

function onResize(): void {
  autoFitWidth()
}

onMounted(async () => {
  try {
    const cfg = (await window.cockpit.getConfig()) as { language?: string } | null
    if (cfg?.language) uiLang.value = cfg.language
  } catch {
    /* keep zh */
  }
  try {
    const r = (await window.cockpit.command('aidj.get-config')) as {
      ok?: boolean
      config?: { preferences?: { lyrics?: Partial<LyricsDisplayConfig> } }
    } | null
    if (r?.ok && r.config?.preferences?.lyrics) {
      lyricsCfg.value = { ...DEFAULT_LYRICS_CFG, ...r.config.preferences.lyrics }
    }
  } catch {
    /* keep defaults */
  }
  // Re-assert placement now that the compositor definitely knows this window.
  applyAnchorPlacement()
  setTimeout(applyAnchorPlacement, 500)
  baseWinW.value = lyricsCfg.value.width ?? window.innerWidth
  baseWinH.value = window.innerHeight
  void nextTick().then(autoFitWidth)
  // lock_on_open: make the window untouchable right away (unlock via BT panel).
  if (lyricsCfg.value.lock_on_open === true) {
    locked.value = true
    await window.cockpit.setWindowLocked(true)
  }
  await poll()
  pollTimer.value = setInterval(() => void poll(), 600)
  window.addEventListener('resize', onResize)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('contextmenu', onContextMenu, true)
  winUnsub = window.cockpit.on('cockpit:windows', onWindowsChanged)
})

onBeforeUnmount(() => {
  if (pollTimer.value) clearInterval(pollTimer.value)
  winUnsub?.()
  window.removeEventListener('resize', onResize)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('contextmenu', onContextMenu, true)
})
</script>

<template>
  <div
    class="lyrics-root"
    :class="[anchorClass, { 'is-paused': !playing, 'is-locked': locked }]"
    :style="rootStyle"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
  >
    <div :ref="setCardEl" class="lyrics-card" :class="{ 'is-empty': cardEmpty }">
      <template v-if="!cardEmpty">
        <!-- track header (optional) -->
        <div v-if="lyricsCfg.show_title" class="lyrics-track">
          <span class="lyrics-track-name">{{ hasTrack ? state.track : t('lyrics.waiting') }}</span>
          <span v-if="state.artist" class="lyrics-track-artist">{{ state.artist }}</span>
        </div>

        <!-- static lyric window: lines_before + current + lines_after -->
        <div class="lyrics-lines">
          <div v-if="plainLyric" class="lyrics-plain">{{ plainLyric }}</div>
          <template v-else>
            <div v-if="windowLines.length" class="lyrics-window">
              <div
                v-for="(line, i) in windowLines"
                :key="windowStart + i"
                class="lyrics-line"
                :class="{ 'is-current': line.isCurrent, 'is-dim': !playing }"
              >
                <span>{{ line.text }}</span>
              </div>
            </div>
            <div v-else class="lyrics-line is-current lyrics-empty">
              {{ hasTrack ? t('lyrics.noLyric') : t('lyrics.waiting') }}
            </div>
          </template>
        </div>
      </template>
    </div>

    <!-- right-click menu -->
    <div
      v-if="menuOpen"
      class="lyrics-menu"
      :style="{ left: menu?.x + 'px', top: menu?.y + 'px' }"
      @pointerdown.stop
    >
      <div class="lyrics-menu-item" @click="lockWindow">
        <v-icon size="16">mdi-lock-outline</v-icon>
        <span>{{ t('lyrics.lock') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Transparent + frameless window root. The card hugs its text and is placed by
   the configured anchor/margin (preferences.lyrics). */
.lyrics-root {
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  user-select: none;
  cursor: default;
  background: transparent;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
}
.lyrics-root.anchor-top {
  justify-content: flex-start;
  padding-top: var(--lyr-margin);
}
.lyrics-root.anchor-bottom {
  justify-content: flex-end;
  padding-bottom: var(--lyr-margin);
}
/* Locked: refuse every pointer interaction in the renderer (Wayland). */
.lyrics-root.is-locked {
  pointer-events: none;
}
.lyrics-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  /* size to the widest content (no cap) so the backdrop always covers every
     rendered line; the window auto-fits it (or the root clips both together) */
  width: max-content;
  padding: var(--lyr-card-pad-y) var(--lyr-card-pad-x);
  border-radius: var(--lyr-card-radius);
  background: var(--lyr-bg);
}
.lyrics-card.is-empty {
  background: transparent;
  /* collapse fully — a padding-only transparent rounded block would still show
     as a tiny visible dot, so remove the padding too */
  padding: 0;
}
.lyrics-track {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
}
.lyrics-track-name {
  font-family: var(--lyr-font);
  font-size: var(--lyr-header-size);
  font-weight: var(--lyr-header-weight);
  letter-spacing: var(--lyr-letter-spacing);
  color: var(--lyr-header-color);
  opacity: 0.9;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lyrics-track-artist {
  font-family: var(--lyr-font);
  font-size: var(--lyr-header-size);
  font-weight: var(--lyr-header-weight);
  color: var(--lyr-header-color);
  opacity: 0.6;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lyrics-lines {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--lyr-gap);
  text-align: center;
}
.lyrics-window {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--lyr-gap);
}
/* Lines keep their NATURAL width (no max-width / ellipsis) so the container's
   scrollWidth reflects the full text — autoFitWidth uses it to expand the
   window; the window root clips overflow when it can't grow further. */
.lyrics-line {
  font-family: var(--lyr-font);
  letter-spacing: var(--lyr-letter-spacing);
  color: var(--lyr-fg);
  white-space: nowrap;
  text-align: center;
}
.lyrics-line:not(.is-current) {
  font-size: var(--lyr-candidate-size);
  font-weight: var(--lyr-candidate-weight);
  color: var(--lyr-candidate-color);
}
.lyrics-line.is-current {
  font-size: var(--lyr-size);
  font-weight: var(--lyr-current-weight);
  line-height: var(--lyr-line-height);
  text-shadow: var(--lyr-shadow);
}
.lyrics-line.is-dim {
  opacity: 0.5;
  text-shadow: none;
}
.lyrics-line.is-current.lyrics-empty {
  font-size: calc(var(--lyr-size) * 0.6);
  font-weight: 500;
  opacity: 0.5;
}
/* Timestamp-less lyrics: show the whole text as a bounded, scrollable block
   (the window height is fixed, so cap it and scroll internally). */
.lyrics-plain {
  font-family: var(--lyr-font);
  font-size: var(--lyr-candidate-size);
  font-weight: var(--lyr-candidate-weight);
  line-height: var(--lyr-line-height);
  letter-spacing: var(--lyr-letter-spacing);
  text-align: center;
  color: var(--lyr-candidate-color);
  opacity: 0.9;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  padding: 2px 6px;
}
.lyrics-menu {
  position: fixed;
  z-index: 100;
  min-width: 130px;
  background: rgba(var(--v-theme-surface), 0.92);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.3);
  border-radius: 10px;
  padding: 4px;
  backdrop-filter: blur(10px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
}
.lyrics-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 7px;
  font-size: 0.85rem;
  cursor: pointer;
}
.lyrics-menu-item:hover {
  background: rgba(var(--v-theme-primary), 0.16);
  color: rgb(var(--v-theme-primary));
}
</style>
