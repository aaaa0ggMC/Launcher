<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import type { ChatMessage, PlaylistEntry, SongMeta } from '../types'

defineOptions({ name: 'AidjChatMessage' })

const props = defineProps<{
  message: ChatMessage
}>()

const emit = defineEmits<{
  playAll: [songs: PlaylistEntry[]]
  reorder: [songs: PlaylistEntry[]]
  playOne: [song: PlaylistEntry]
}>()

const covers = ref<Record<string, string>>({})
const dragIdx = ref(-1)

function isUser(msg: ChatMessage): boolean {
  return msg.role === 'user'
}
function isSystem(msg: ChatMessage): boolean {
  return msg.role === 'system'
}
function isThinking(msg: ChatMessage): boolean {
  return msg.role === 'assistant' && msg.content === '...'
}

function metaVal(meta: SongMeta | null | undefined, field: keyof SongMeta): string {
  if (!meta) return ''
  const v = meta[field]
  if (!v) return ''
  return Array.isArray(v) ? v.join(', ') : String(v)
}

function roleIcon(msg: ChatMessage): string {
  if (isUser(msg)) return 'mdi-account'
  if (isSystem(msg)) return 'mdi-information-outline'
  return 'mdi-robot'
}

function roleLabel(msg: ChatMessage): string {
  if (isUser(msg)) return 'You'
  if (isSystem(msg)) return 'System'
  return 'AI DJ'
}

async function loadCovers(): Promise<void> {
  if (!props.message.playlist) return
  for (const song of props.message.playlist) {
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
  const list = props.message.playlist
  if (!list) return
  const copy = [...list]
  const [moved] = copy.splice(dragIdx.value, 1)
  copy.splice(idx, 0, moved)
  emit('reorder', copy)
  dragIdx.value = -1
}

onMounted(loadCovers)
watch(() => props.message.playlist, loadCovers)
</script>

<template>
  <div
    class="d-flex flex-column ga-1 msg-wrapper"
    :class="isUser(message) ? 'align-end' : 'align-start'"
  >
    <span class="role-label d-flex align-center ga-1 text-caption text-medium-emphasis">
      <v-icon :icon="roleIcon(message)" size="14" />
      {{ roleLabel(message) }}
    </span>

    <div
      v-if="message.content"
      class="msg-bubble pa-3"
      :class="isUser(message) ? 'msg-bubble-user' : isThinking(message) ? 'msg-bubble-thinking' : 'msg-bubble-ai'"
    >
      <div v-if="isThinking(message)" class="d-flex align-center ga-2 text-body-2">
        <v-progress-circular indeterminate size="16" width="2" />
        <span class="thinking-text">思考中</span>
        <span class="text-caption text-medium-emphasis">{{ message.chars ?? 0 }} 字符</span>
      </div>
      <div v-else class="text-body-2" style="white-space: pre-wrap">{{ message.content }}</div>
    </div>

    <div
      v-if="message.playlist && message.playlist.length > 0"
      class="mt-1 playlist-card w-100"
    >
      <v-card variant="tonal" rounded="lg" class="playlist-card-inner">
        <v-card-actions class="px-4 pt-4 pb-2">
          <v-btn
            variant="elevated"
            color="primary"
            prepend-icon="mdi-play-circle-outline"
            @click="emit('playAll', message.playlist!)"
          >
            播放全部
          </v-btn>
        </v-card-actions>

        <v-divider class="mx-4" />

        <TransitionGroup tag="div" name="song" class="song-grid">
          <div
            v-for="(song, idx) in message.playlist"
            :key="song.path"
            draggable="true"
            class="song-card d-flex align-center ga-2 px-3 py-2"
            :class="{ 'drag-over': dragIdx === idx }"
            @dragstart="onDragStart(idx)"
            @dragover="onDragOver"
            @drop="onDrop(idx)"
          >
            <span class="text-caption text-medium-emphasis flex-shrink-0" style="width: 2ch; text-align: right">
              {{ idx + 1 }}
            </span>

            <div
              class="cover-wrap d-flex align-center justify-center flex-shrink-0"
              @click.stop="emit('playOne', song)"
            >
              <img
                v-if="covers[song.path]"
                :src="covers[song.path]"
                class="cover-img"
                alt=""
              />
              <v-icon v-else icon="mdi-music" class="cover-fallback" />
              <div class="cover-overlay d-flex align-center justify-center">
                <v-icon icon="mdi-play-circle" size="20" class="cover-play-icon" />
              </div>
            </div>

            <div class="d-flex flex-column flex-grow-1 min-w-0">
              <span class="text-body-2 song-name">{{ song.name }}</span>
              <span class="text-caption text-medium-emphasis">
                {{ metaVal(song.meta, 'language') || '—' }}
              </span>
            </div>

            <v-icon size="14" class="drag-handle text-medium-emphasis flex-shrink-0">
              mdi-drag
            </v-icon>
          </div>
        </TransitionGroup>
      </v-card>
    </div>
  </div>
</template>

<style scoped>
.role-label {
  padding-block: 2px;
  margin-bottom: 2px;
  line-height: 1;
}
.msg-bubble {
  border-radius: 12px;
  max-width: 85%;
  word-break: break-word;
}
.msg-bubble-user {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  border-bottom-right-radius: 4px;
}
.msg-bubble-ai {
  background: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  border-bottom-left-radius: 4px;
}
.msg-bubble-thinking {
  background: rgba(var(--v-theme-surface-variant), 0.5);
  color: rgb(var(--v-theme-on-surface));
  border-bottom-left-radius: 4px;
}
.thinking-text {
  animation: thinking-pulse 1.2s ease-in-out infinite;
}
@keyframes thinking-pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
.playlist-card {
  min-width: 0;
}
.playlist-card-inner {
  overflow: hidden;
}
.song-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
  padding: 10px;
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
.song-move {
  transition: transform 0.25s ease;
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
  font-size: 2.4ch;
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
.song-name {
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.drag-handle {
  cursor: grab;
}
</style>