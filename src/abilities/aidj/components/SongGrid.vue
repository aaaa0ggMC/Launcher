<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import type { PlaylistEntry } from '../types'

/**
 * Shared song grid used by both the main chat playlist (with covers) and the
 * continuous queue (icon + name). Drag-to-reorder with a move animation.
 *
 * Drag extras for long queues:
 *  - auto-scrolls the nearest scrollable ancestor while hovering its top/bottom
 *    edge, so you can reach songs that are off-screen;
 *  - the mouse wheel scrolls the same container during a drag.
 *
 * FUTURE: per-song right-click menu — attach a `contextmenu` handler on the
 * cell (and emit `contextMenu(e, song, index)`) without touching this file;
 * the cell markup is already a stable hook for it.
 */
defineOptions({ name: 'AidjSongGrid' })

const props = withDefaults(
  defineProps<{
    songs: PlaylistEntry[]
    /** Render cover art (main chat) instead of a plain music icon. */
    showCovers?: boolean
    /** Highlight the cell whose path matches (e.g. the current continuous track). */
    highlightPath?: string
  }>(),
  { showCovers: false, highlightPath: '' }
)

const emit = defineEmits<{
  reorder: [songs: PlaylistEntry[]]
  playOne: [song: PlaylistEntry]
}>()

const covers = ref<Record<string, string>>({})
const dragIdx = ref(-1)
const gridEl = ref<HTMLElement | null>(null)

let scrollParent: HTMLElement | null = null
let dragActive = false
let autoScrollRaf = 0
let lastClientY = 0

async function loadCovers(): Promise<void> {
  if (!props.showCovers) return
  for (const song of props.songs) {
    if (covers.value[song.path]) continue
    try {
      const r = (await window.cockpit.command('aidj.get-cover', {
        path: song.path
      })) as Record<string, unknown>
      if (r?.ok && r.url) {
        covers.value[song.path] = r.url as string
      }
    } catch {
      /* noop */
    }
  }
}

/** Nearest ancestor that actually scrolls vertically (the queue container). */
function findScrollable(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const oy = getComputedStyle(node).overflowY
    if (oy === 'auto' || oy === 'scroll') return node
    node = node.parentElement
  }
  return null
}

function onDragStart(e: DragEvent, idx: number): void {
  dragIdx.value = idx
  dragActive = true
  lastClientY = e.clientY
  scrollParent = findScrollable(gridEl.value)
  window.addEventListener('wheel', onDragWheel, { passive: false })
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
  lastClientY = e.clientY
  if (!autoScrollRaf) autoScrollRaf = requestAnimationFrame(autoScrollTick)
}

/** Mouse-wheel scrolls the queue container while a drag is in progress. */
function onDragWheel(e: WheelEvent): void {
  if (!scrollParent || !dragActive) return
  e.preventDefault()
  scrollParent.scrollTop += e.deltaY
  lastClientY += e.deltaY
}

/** Slow auto-scroll near the container's top/bottom edge while dragging. */
function autoScrollTick(): void {
  autoScrollRaf = 0
  if (!dragActive || !scrollParent) return
  const rect = scrollParent.getBoundingClientRect()
  const zone = 48
  if (lastClientY < rect.top + zone) {
    const speed = 1 + ((rect.top + zone - lastClientY) / zone) * 10
    scrollParent.scrollTop -= speed
  } else if (lastClientY > rect.bottom - zone) {
    const speed = 1 + ((lastClientY - (rect.bottom - zone)) / zone) * 10
    scrollParent.scrollTop += speed
  }
  if (dragActive) autoScrollRaf = requestAnimationFrame(autoScrollTick)
}

function performDrop(targetIdx: number): void {
  const from = dragIdx.value
  if (from < 0 || from === targetIdx) {
    dragIdx.value = -1
    return
  }
  const copy = [...props.songs]
  const [moved] = copy.splice(from, 1)
  copy.splice(targetIdx, 0, moved)
  emit('reorder', copy)
  dragIdx.value = -1
}

function onDrop(e: DragEvent, idx: number): void {
  e.preventDefault()
  e.stopPropagation()
  performDrop(idx)
}

/** Drop on the grid's empty space — insert at the cell whose mid-line the
 *  pointer is above, otherwise append at the end. */
function onGridDrop(e: DragEvent): void {
  if (dragIdx.value < 0) return
  e.preventDefault()
  const cells = Array.from(gridEl.value?.children ?? []).filter((c): c is HTMLElement =>
    c.classList.contains('song-card')
  )
  let target = cells.length
  for (let i = 0; i < cells.length; i++) {
    const r = cells[i].getBoundingClientRect()
    if (e.clientY < r.top + r.height / 2) {
      target = i
      break
    }
  }
  performDrop(target)
}

function cleanupDrag(): void {
  dragActive = false
  dragIdx.value = -1
  if (autoScrollRaf) {
    cancelAnimationFrame(autoScrollRaf)
    autoScrollRaf = 0
  }
  window.removeEventListener('wheel', onDragWheel)
  scrollParent = null
}

onMounted(loadCovers)
watch(() => props.songs, loadCovers)
onBeforeUnmount(cleanupDrag)
</script>

<template>
  <TransitionGroup
    ref="gridEl"
    tag="div"
    name="song"
    class="song-grid"
    @dragover.prevent="onDragOver"
    @drop.prevent="onGridDrop"
  >
    <div
      v-for="(song, idx) in songs"
      :key="song.path"
      draggable="true"
      class="song-card d-flex align-center ga-2 px-3 py-2"
      :class="{
        'drag-over': dragIdx === idx,
        'is-current': highlightPath && song.path === highlightPath
      }"
      @dragstart="onDragStart($event, idx)"
      @dragover.prevent
      @drop="onDrop($event, idx)"
      @dragend="cleanupDrag"
    >
      <span
        class="text-caption text-medium-emphasis flex-shrink-0"
        style="width: 2ch; text-align: right"
      >
        {{ idx + 1 }}
      </span>

      <div
        v-if="showCovers"
        class="cover-wrap d-flex align-center justify-center flex-shrink-0"
        @click.stop="emit('playOne', song)"
      >
        <img v-if="covers[song.path]" :src="covers[song.path]" class="cover-img" alt="" />
        <v-icon v-else icon="mdi-music" class="cover-fallback" />
        <div class="cover-overlay d-flex align-center justify-center">
          <v-icon icon="mdi-play-circle" size="20" class="cover-play-icon" />
        </div>
      </div>
      <v-icon v-else size="16" class="flex-shrink-0">mdi-music</v-icon>

      <div class="d-flex flex-column flex-grow-1 min-w-0">
        <span class="text-body-2 song-name text-truncate">{{ song.name }}</span>
      </div>

      <v-icon size="14" class="drag-handle text-medium-emphasis flex-shrink-0"> mdi-drag </v-icon>
    </div>
  </TransitionGroup>
</template>

<style scoped>
.song-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  width: 100%;
}
.song-card {
  border-radius: 8px;
  cursor: grab;
  user-select: none;
  transition: background 0.15s;
  min-width: 0;
}
.song-card:active {
  cursor: grabbing;
}
.song-card:hover {
  background: rgba(var(--v-theme-surface-variant), 0.3);
}
.song-card.drag-over {
  background: rgba(var(--v-theme-primary), 0.12);
}
.song-card.is-current {
  background: rgba(var(--v-theme-primary-container), 0.45);
}
.song-name {
  line-height: 1.3;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.cover-wrap {
  position: relative;
  width: 6ch;
  height: 6ch;
  border-radius: 6px;
  overflow: hidden;
  background: rgba(var(--v-theme-surface-variant), 0.4);
  flex-shrink: 0;
  cursor: pointer;
}
.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-fallback {
  font-size: 2ch;
  opacity: 0.5;
}
.cover-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  opacity: 0;
  transition: opacity 0.15s;
}
.cover-wrap:hover .cover-overlay {
  opacity: 1;
}
.cover-play-icon {
  color: #fff;
}
.drag-handle {
  cursor: grab;
}
.song-move {
  transition: transform 0.25s ease;
}
.song-enter-active {
  transition: all 0.25s ease-out;
}
.song-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.song-leave-active {
  transition: all 0.2s ease-in;
  position: absolute;
}
.song-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
