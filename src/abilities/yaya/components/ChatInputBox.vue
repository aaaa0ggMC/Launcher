<script setup lang="ts">
import { ref } from 'vue'
import type { MessageAttachment } from '../types'

const props = defineProps<{
  isRunning: boolean
  sessionId: string
}>()

const emit = defineEmits<{
  (e: 'send', prompt: string, attachments: MessageAttachment[]): void
  (e: 'abort'): void
}>()

const inputPrompt = ref('')
const attachments = ref<MessageAttachment[]>([])

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    handleSend()
  }
}

function handleSend(): void {
  const text = inputPrompt.value.trim()
  if (!text && attachments.value.length === 0) return
  if (props.isRunning) return

  emit('send', text, [...attachments.value])
  inputPrompt.value = ''
  attachments.value = []
}

async function attachFile(): Promise<void> {
  try {
    const filePath = await window.cockpit.pickFile({
      title: '选择要附加的文件或图片'
    })
    if (!filePath) return

    const fileName = filePath.split('/').pop() || 'file'
    attachments.value.push({
      id: String(Date.now()),
      name: fileName,
      mimeType: guessMimeType(fileName),
      size: 0,
      assetPath: filePath
    })
  } catch (err) {
    console.error('Pick file failed', err)
  }
}

function removeAttachment(index: number): void {
  attachments.value.splice(index, 1)
}

function guessMimeType(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.md') || lower.endsWith('.txt')) return 'text/plain'
  return 'application/octet-stream'
}
</script>

<template>
  <div class="chat-input-bar-wrap w-100 px-4 pb-3 pt-2">
    <div class="chat-input-inner mx-auto">
      <!-- 附件预览行 -->
      <div v-if="attachments.length > 0" class="d-flex flex-wrap ga-2 mb-2 px-2">
        <v-chip
          v-for="(att, idx) in attachments"
          :key="att.id"
          closable
          size="small"
          prepend-icon="mdi-paperclip"
          variant="tonal"
          color="primary"
          @click:close="removeAttachment(idx)"
        >
          {{ att.name }}
        </v-chip>
      </div>

      <!-- 仿 AIDJ 经典胶囊/药丸型输入外框 -->
      <div class="input-card d-flex align-end ga-2 pa-2 rounded-xl border">
        <v-btn
          icon="mdi-paperclip"
          variant="text"
          size="small"
          density="comfortable"
          class="flex-shrink-0 mb-1"
          title="添加附件"
          aria-label="添加附件"
          @click="attachFile"
        />

        <v-textarea
          v-model="inputPrompt"
          placeholder="向 YAYA 提问，或按 Enter 发送..."
          rows="1"
          max-rows="5"
          auto-grow
          variant="plain"
          density="compact"
          hide-details
          class="flex-grow-1 yaya-textarea mb-1"
          @keydown="onKeyDown"
        />

        <!-- 停止或发送按钮 (默认密度，呼吸良好) -->
        <v-btn
          v-if="isRunning"
          color="error"
          variant="elevated"
          prepend-icon="mdi-stop"
          class="flex-shrink-0 mb-1"
          @click="emit('abort')"
        >
          停止
        </v-btn>
        <v-btn
          v-else
          color="primary"
          variant="elevated"
          prepend-icon="mdi-send"
          :disabled="!inputPrompt.trim() && attachments.length === 0"
          class="flex-shrink-0 mb-1"
          @click="handleSend"
        >
          发送
        </v-btn>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-input-bar-wrap {
  flex-shrink: 0;
  background: transparent;
}

.chat-input-inner {
  max-width: 840px;
}

.input-card {
  background: rgba(var(--v-theme-surface), 0.85);
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28) !important;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.yaya-textarea :deep(textarea) {
  font-size: 0.95rem;
  line-height: 1.45;
  padding: 4px 8px;
}

@media (max-width: 720px) {
  .chat-input-bar-wrap {
    padding-inline: 8px !important;
  }
}
</style>
