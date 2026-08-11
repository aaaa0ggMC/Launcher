<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
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

const rootStyle = computed(() => ({
  '--lyr-bg': hexToRgba(lyricsCfg.value.bg_color),
  '--lyr-fg': hexToRgba(lyricsCfg.value.fg_color),
  '--lyr-font': `'${lyricsCfg.value.font_family.replace(/'/g, '')}', 'Iansui', 'Noto Sans CJK SC', sans-serif`,
  '--lyr-size': `${Math.max(10, lyricsCfg.value.font_size)}px`,
  '--lyr-next-size': `${Math.max(8, Math.round(lyricsCfg.value.font_size * 0.6))}px`,
  '--lyr-margin': `${Math.max(0, lyricsCfg.value.margin)}px`
}) as Record<string, string>)

const anchorClass = computed(() => `anchor-${lyricsCfg.value.anchor}`)

/**
 * Re-assert the configured anchor/margin placement once this window is fully
 * mounted. `window.screen` reflects the display the window lives on; main then
 * applies native setPosition (X11/Windows) or KWin scripting (KDE Wayland).
 */
function applyAnchorPlacement(): void {
  const c = lyricsCfg.value
  const screen = window.screen as Screen & { availLeft?: number; availTop?: number }
  const aw = screen.availWidth
  const ah = screen.availHeight
  const left = screen.availLeft ?? 0
  const top = screen.availTop ?? 0
  const w = window.innerWidth
  const h = window.innerHeight
  const x = left + Math.round((aw - w) / 2)
  let y: number
  if (c.anchor === 'bottom') y = top + ah - h - c.margin
  else if (c.anchor === 'top') y = top + c.margin
  else y = top + Math.round((ah - h) / 2)
  void window.cockpit.moveWindowTo(x, y)
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
 *  to read (progress comes from DBus too) so the window closes itself. */
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

const positionMs = computed(() => state.value.positionMs ?? 0)

/** Index of the current line: the last line whose time ≤ playback position. */
const currentIndex = computed(() => {
  if (!lrcLines.value.length) return -1
  let idx = -1
  for (let i = 0; i < lrcLines.value.length; i++) {
    if (lrcLines.value[i].time <= positionMs.value) idx = i
    else break
  }
  return idx
})

const currentLine = computed(() =>
  currentIndex.value >= 0 ? (lrcLines.value[currentIndex.value]?.text ?? '') : ''
)
const nextLine = computed(() =>
  currentIndex.value >= 0 ? (lrcLines.value[currentIndex.value + 1]?.text ?? '') : ''
)

const playing = computed(() => state.value.status === 'Playing')
const hasTrack = computed(() => Boolean(state.value.track))

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
  // App-level lock immediately (so no menu/drag can follow), then push OS-level
  // passthrough — which only takes effect on X11/Windows; on Wayland the
  // renderer guard is what actually stops interaction.
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
  await poll()
  pollTimer.value = setInterval(() => void poll(), 600)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('contextmenu', onContextMenu, true)
  winUnsub = window.cockpit.on('cockpit:windows', onWindowsChanged)
})

onBeforeUnmount(() => {
  if (pollTimer.value) clearInterval(pollTimer.value)
  winUnsub?.()
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
    <div class="lyrics-card">
      <!-- track header -->
      <div class="lyrics-track">
        <span class="lyrics-track-name">{{ hasTrack ? state.track : t('lyrics.waiting') }}</span>
        <span v-if="state.artist" class="lyrics-track-artist">{{ state.artist }}</span>
      </div>

      <!-- current + next lyric lines -->
      <div class="lyrics-lines">
        <div v-if="plainLyric" class="lyrics-plain">{{ plainLyric }}</div>
        <template v-else>
          <div v-if="currentLine" class="lyrics-current" :class="{ 'is-dim': !playing }">
            {{ currentLine }}
          </div>
          <div v-else class="lyrics-current lyrics-empty">
            {{ hasTrack ? t('lyrics.noLyric') : t('lyrics.waiting') }}
          </div>
          <div v-if="nextLine" class="lyrics-next" :class="{ 'is-dim': !playing }">
            {{ nextLine }}
          </div>
        </template>
      </div>
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
   the configured anchor/margin (preferences.lyrics). Colors/font come from the
   same config via CSS variables (--lyr-*). */
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
/* Locked: refuse every pointer interaction in the renderer. On Wayland the OS
   passthrough (setIgnoreMouseEvents) is a compositor no-op, so this class is
   what actually makes the locked window untouchable — no drag, no context menu. */
.lyrics-root.is-locked {
  pointer-events: none;
}
.lyrics-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  max-width: calc(100% - 32px);
  padding: 12px 26px;
  border-radius: calc(var(--win-radius, 14px) - 1px);
  background: var(--lyr-bg);
}
.lyrics-track {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
}
.lyrics-track-name {
  font-family: var(--lyr-font);
  font-size: calc(var(--lyr-size) * 0.28);
  font-weight: 600;
  color: var(--lyr-fg);
  opacity: 0.85;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lyrics-track-artist {
  font-family: var(--lyr-font);
  font-size: calc(var(--lyr-size) * 0.24);
  color: var(--lyr-fg);
  opacity: 0.55;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lyrics-lines {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  max-width: 100%;
}
.lyrics-current {
  font-family: var(--lyr-font);
  font-size: var(--lyr-size);
  font-weight: 700;
  line-height: 1.3;
  text-align: center;
  color: var(--lyr-fg);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.lyrics-current.is-dim,
.lyrics-next.is-dim {
  opacity: 0.5;
  text-shadow: none;
}
.lyrics-next {
  font-family: var(--lyr-font);
  font-size: var(--lyr-next-size);
  font-weight: 500;
  line-height: 1.3;
  text-align: center;
  color: var(--lyr-fg);
  opacity: 0.72;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.lyrics-plain {
  font-family: var(--lyr-font);
  font-size: var(--lyr-next-size);
  line-height: 1.6;
  text-align: center;
  color: var(--lyr-fg);
  opacity: 0.9;
  max-height: 80%;
  overflow-y: auto;
}
.lyrics-empty {
  font-family: var(--lyr-font);
  font-size: calc(var(--lyr-size) * 0.6);
  font-weight: 500;
  color: var(--lyr-fg);
  opacity: 0.5;
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
