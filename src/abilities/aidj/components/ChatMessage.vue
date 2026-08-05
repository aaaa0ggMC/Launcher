<script setup lang="ts">
import type { ChatMessage, SongMeta } from '../types'

defineOptions({ name: 'AidjChatMessage' })

defineProps<{
  message: ChatMessage
}>()

function isUser(msg: ChatMessage): boolean {
  return msg.role === 'user'
}
function isSystem(msg: ChatMessage): boolean {
  return msg.role === 'system'
}

function metaVal(meta: SongMeta | null | undefined, field: keyof SongMeta): string {
  if (!meta) return ''
  const v = meta[field]
  if (!v) return ''
  return Array.isArray(v) ? v.join(', ') : String(v)
}
</script>

<template>
  <div class="d-flex flex-column ga-1" :class="isUser(message) ? 'align-end' : 'align-start'">
    <v-chip
      variant="flat"
      size="small"
      class="msg-role-chip"
      :color="isSystem(message) ? 'secondary' : 'primary'"
    >
      {{ isUser(message) ? 'You' : isSystem(message) ? 'System' : 'AI DJ' }}
    </v-chip>

    <div
      v-if="message.content"
      class="msg-bubble pa-3"
      :class="
        isUser(message)
          ? 'msg-bubble-user'
          : isSystem(message)
            ? 'msg-bubble-system'
            : 'msg-bubble-ai'
      "
    >
      <div class="text-body-2" style="white-space: pre-wrap">{{ message.content }}</div>
    </div>

    <div
      v-if="message.playlist && message.playlist.length > 0"
      class="mt-1"
      style="max-width: 600px"
    >
      <v-card variant="tonal" class="playlist-table">
        <v-table density="compact">
          <thead>
            <tr>
              <th class="text-left">#</th>
              <th class="text-left">歌曲</th>
              <th class="text-left">语言</th>
              <th class="text-left">风格</th>
              <th class="text-left">情绪</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(song, idx) in message.playlist" :key="idx">
              <td>{{ idx + 1 }}</td>
              <td>{{ song.name }}</td>
              <td>{{ metaVal(song.meta, 'language') }}</td>
              <td>{{ metaVal(song.meta, 'genre') }}</td>
              <td>{{ metaVal(song.meta, 'emotion') }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>
    </div>
  </div>
</template>

<style scoped>
.msg-role-chip {
  padding-block: 4px;
  min-height: 24px;
  margin-bottom: 2px;
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
  background: rgba(var(--v-theme-surface-variant), 0.5);
  color: rgb(var(--v-theme-on-surface));
  border-bottom-left-radius: 4px;
}
.msg-bubble-system {
  background: transparent;
  color: rgb(var(--v-theme-on-surface));
  border-radius: 8px;
  opacity: 0.7;
  font-size: 0.8rem;
}
.playlist-table {
  border-radius: 8px;
}
</style>
