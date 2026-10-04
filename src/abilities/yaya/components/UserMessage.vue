<script setup lang="ts">
import { inject, nextTick, onMounted, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { MessageNode } from '../types'
import BranchSwitcher from './BranchSwitcher.vue'

const props = defineProps<{
  message: MessageNode
  /** 有工作流在跑时禁止编辑重发 */
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'switchBranch', messageId: string): void
  /** 编辑后重发：在原消息的父节点下开新分支 */
  (e: 'edit', text: string): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const editing = ref(false)
const draft = ref('')
const copied = ref(false)
const previews = ref<Record<string, string>>({})
const editor = ref<{ focus: () => void } | null>(null)

async function startEdit(): Promise<void> {
  draft.value = props.message.content
  editing.value = true
  await nextTick()
  editor.value?.focus()
}

function submitEdit(): void {
  const text = draft.value.trim()
  if (!text) return
  editing.value = false
  if (text !== props.message.content.trim() || props.message.attachments?.length) emit('edit', text)
}

function onEditKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') editing.value = false
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitEdit()
}

async function copy(): Promise<void> {
  await window.cockpit.copyText(props.message.content)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

onMounted(async () => {
  for (const att of props.message.attachments ?? []) {
    if (!att.mimeType.startsWith('image/')) continue
    try {
      const url = (await window.cockpit.command('yaya.asset-preview', {
        uri: att.assetPath
      })) as string | null
      if (url) previews.value[att.id] = url
    } catch {
      /* 缩略图失败时退回文件名 chip */
    }
  }
})
</script>

<template>
  <div class="user-msg">
    <div v-if="editing" class="edit-box">
      <v-textarea
        ref="editor"
        v-model="draft"
        variant="outlined"
        auto-grow
        rows="2"
        max-rows="12"
        hide-details
        @keydown="onEditKey"
      />
      <div class="d-flex flex-wrap justify-end ga-2 mt-2">
        <v-btn variant="text" @click="editing = false">{{ t('yaya.cancel', '取消') }}</v-btn>
        <v-btn color="primary" variant="flat" prepend-icon="mdi-send" @click="submitEdit">
          {{ t('yaya.edit_send', '发送') }}
        </v-btn>
      </div>
    </div>

    <template v-else>
      <div v-if="message.attachments?.length" class="attachments">
        <template v-for="att in message.attachments" :key="att.id">
          <img
            v-if="previews[att.id]"
            :src="previews[att.id]"
            :alt="att.name"
            :title="att.name"
            class="thumb"
          />
          <div v-else class="file-chip" :title="att.name">
            <v-icon icon="mdi-file-outline" size="16" />
            <span class="text-truncate">{{ att.name }}</span>
          </div>
        </template>
      </div>
      <div v-if="message.content" class="bubble">{{ message.content }}</div>

      <div class="user-actions">
        <BranchSwitcher
          v-if="message.siblingIds && message.siblingIds.length > 1"
          :ids="message.siblingIds"
          :current="message.id"
          @switch="(id) => emit('switchBranch', id)"
        />
        <v-btn
          icon
          variant="text"
          size="small"
          :title="copied ? t('yaya.copied', '已复制') : t('yaya.copy', '复制')"
          :aria-label="t('yaya.copy', '复制')"
          @click="copy"
        >
          <v-icon :icon="copied ? 'mdi-check' : 'mdi-content-copy'" size="18" />
        </v-btn>
        <v-btn
          icon="mdi-pencil-outline"
          variant="text"
          size="small"
          :disabled="busy"
          :title="t('yaya.edit', '编辑并重新发送')"
          :aria-label="t('yaya.edit', '编辑并重新发送')"
          @click="startEdit"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.user-msg {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  min-width: 0;
}
.bubble {
  max-width: min(85%, 640px);
  padding: 10px 16px;
  border-radius: 18px 18px 6px 18px;
  background: rgba(var(--v-theme-primary), 0.14);
  color: rgb(var(--v-theme-on-surface));
  font-size: 0.95rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.attachments {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  max-width: 85%;
}
.thumb {
  max-width: 220px;
  max-height: 180px;
  border-radius: 12px;
  object-fit: cover;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.file-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 240px;
  padding: 6px 12px;
  min-height: 32px;
  border-radius: 10px;
  background: rgba(var(--v-theme-on-surface), 0.06);
  font-size: 0.85rem;
}
.user-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 32px;
  opacity: 0;
  transition: opacity 0.15s;
}
.user-msg:hover .user-actions,
.user-actions:focus-within {
  opacity: 1;
}
/* 触屏没有 hover：操作常显 */
@media (hover: none) {
  .user-actions {
    opacity: 1;
  }
}
.edit-box {
  width: min(100%, 640px);
}
@media (max-width: 720px) {
  .bubble,
  .attachments {
    max-width: 92%;
  }
  .thumb {
    max-width: 160px;
    max-height: 140px;
  }
}
</style>
