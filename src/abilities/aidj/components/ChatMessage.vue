<script setup lang="ts">
import { computed } from 'vue'
import type { ChatMessage, PlaylistEntry } from '../types'
import { renderMarkdown } from '../../../shared/markdown'
import SongGrid from './SongGrid.vue'

defineOptions({ name: 'AidjChatMessage' })

const props = defineProps<{
  message: ChatMessage
  index?: number
}>()

const emit = defineEmits<{
  playAll: [songs: PlaylistEntry[]]
  reorder: [songs: PlaylistEntry[]]
  playOne: [song: PlaylistEntry]
  contextMenu: [
    e: MouseEvent,
    content: string,
    isAi: boolean,
    songs: PlaylistEntry[],
    index: number
  ]
  continuous: [songs: PlaylistEntry[]]
}>()

const renderedContent = computed(() => {
  if (isThinking(props.message) || isUser(props.message)) return ''
  return renderMarkdown(props.message.content)
})

function isUser(msg: ChatMessage): boolean {
  return msg.role === 'user'
}
function isSystem(msg: ChatMessage): boolean {
  return msg.role === 'system'
}
function isThinking(msg: ChatMessage): boolean {
  return msg.role === 'assistant' && msg.content === '...'
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
      :class="
        isUser(message)
          ? 'msg-bubble-user'
          : isThinking(message)
            ? 'msg-bubble-thinking'
            : 'msg-bubble-ai'
      "
      @contextmenu="
        emit(
          'contextMenu',
          $event,
          message.content,
          !isUser(message) && !isSystem(message),
          message.playlist || [],
          props.index ?? 0
        )
      "
    >
      <div v-if="isThinking(message)" class="d-flex align-center ga-2 text-body-2">
        <v-progress-circular indeterminate size="16" width="2" />
        <span class="thinking-text">思考中</span>
        <span class="text-caption text-medium-emphasis">{{ message.chars ?? 0 }} 字符</span>
      </div>
      <div
        v-else-if="!isUser(message) && !isSystem(message)"
        class="text-body-2 msg-markdown"
        v-html="renderedContent"
      />
      <div v-else class="text-body-2" style="white-space: pre-wrap">{{ message.content }}</div>
    </div>

    <div v-if="message.playlist && message.playlist.length > 0" class="mt-1 playlist-card w-100">
      <v-card variant="tonal" rounded="lg" class="playlist-card-inner">
        <v-card-actions class="px-4 pt-4 pb-2 d-flex flex-wrap ga-2">
          <v-btn
            variant="elevated"
            color="primary"
            prepend-icon="mdi-play-circle-outline"
            @click="emit('playAll', message.playlist!)"
          >
            播放全部
          </v-btn>
          <v-btn
            variant="elevated"
            color="primary"
            prepend-icon="mdi-send-clock-outline"
            @click="emit('continuous', message.playlist!)"
          >
            推送到后台
          </v-btn>
        </v-card-actions>

        <v-divider class="mx-4" />

        <SongGrid
          :songs="message.playlist"
          show-covers
          @reorder="emit('reorder', $event)"
          @play-one="emit('playOne', $event)"
        />
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
  position: relative;
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
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 1;
  }
}
.playlist-card {
  min-width: 0;
}
.playlist-card-inner {
  overflow: hidden;
}
.msg-markdown p {
  margin: 0 0 0.4em;
}
.msg-markdown p:last-child {
  margin-bottom: 0;
}
.msg-markdown code {
  background: rgba(0, 0, 0, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 0.85em;
}
.msg-markdown pre {
  background: rgba(0, 0, 0, 0.15);
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  margin: 0.4em 0;
}
.msg-markdown pre code {
  background: none;
  padding: 0;
}
.msg-markdown a {
  color: inherit;
  text-decoration: underline;
  opacity: 0.85;
}
.msg-markdown ul {
  margin: 0.2em 0;
  padding-left: 1.2em;
}
.msg-markdown strong {
  font-weight: 600;
}
</style>
