<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import type { PlaylistEntry } from '../types'

/**
 * Shared song grid used by both the main chat playlist (with covers) and the
 * continuous queue (icon + name). Drag-to-reorder with a move animation.
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

function onDragStart(idx: number): void {
  dragIdx.value = idx
}

function onDragOver(e: DragEvent): void {
  e.preventDefault()
}

function onDrop(idx: number): void {
  if (dragIdx.value < 0 || dragIdx.value === idx) return
  const copy = [...props.songs]
  const [moved] = copy.splice(dragIdx.value, 1)
  copy.splice(idx, 0, moved)
  emit('reorder', copy)
  dragIdx.value = -1
}

onMounted(loadCovers)
watch(() => props.songs, loadCovers)
</script>

<template>
  <TransitionGroup tag="div" name="song" class="song-grid">
    <div
      v-for="(song, idx) in songs"
      :key="song.path"
      draggable="true"
      class="song-card d-flex align-center ga-2 px-3 py-2"
      :class="{
        'drag-over': dragIdx === idx,
        'is-current': highlightPath && song.path === highlightPath
      }"
      @dragstart="onDragStart(idx)"
      @dragover="onDragOver"
      @drop="onDrop(idx)"
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
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
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
