<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { MessageAttachment } from '../types'

const props = defineProps<{
  isRunning: boolean
  sessionId: string
  assistantName: string
  /** 新对话草稿还没有会话时，添加附件前先创建会话 */
  ensureSession: () => Promise<string>
}>()

const emit = defineEmits<{
  (e: 'send', prompt: string, attachments: MessageAttachment[]): void
  (e: 'abort'): void
}>()

/** 草稿由父组件持有（空状态的建议会往里填） */
const draft = defineModel<string>({ default: '' })

const lang = inject('cockpit:lang', ref('zh'))
const { t, te } = useI18n(lang)

const attachments = ref<MessageAttachment[]>([])
const previews = ref<Record<string, string>>({})
const importing = ref(false)
const attachError = ref('')
const textarea = ref<{ focus: () => void } | null>(null)

/** 触屏：回车换行，靠发送按钮发送（手机输入法回车发送很容易误触） */
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches

const canSend = computed(
  () =>
    !props.isRunning && !importing.value && (!!draft.value.trim() || attachments.value.length > 0)
)

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || e.isComposing || coarse) return
  if (e.shiftKey) return
  e.preventDefault()
  send()
}

function send(): void {
  if (!canSend.value) return
  emit('send', draft.value.trim(), JSON.parse(JSON.stringify(attachments.value)))
  draft.value = ''
  attachments.value = []
  previews.value = {}
}

async function attach(): Promise<void> {
  attachError.value = ''
  const path = await window.cockpit.pickFile({ title: t('yaya.input.pick_title', '选择附件') })
  if (!path) return
  importing.value = true
  try {
    const session = await props.ensureSession()
    const att = (await window.cockpit.command('yaya.asset-import', {
      session,
      path
    })) as MessageAttachment
    if (!attachments.value.some((a) => a.id === att.id)) attachments.value.push(att)
    if (att.mimeType.startsWith('image/')) {
      const url = (await window.cockpit.command('yaya.asset-preview', {
        uri: att.assetPath
      })) as string | null
      if (url) previews.value[att.id] = url
    }
  } catch (e) {
    attachError.value = te(
      'yaya.input.attach_failed',
      { error: e instanceof Error ? e.message : String(e) },
      '添加附件失败：{error}'
    )
  } finally {
    importing.value = false
    textarea.value?.focus()
  }
}

function remove(id: string): void {
  attachments.value = attachments.value.filter((a) => a.id !== id)
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

defineExpose({ focus: () => textarea.value?.focus() })
</script>

<template>
  <div class="input-wrap">
    <div class="input-card">
      <div v-if="attachments.length || importing" class="att-row">
        <div v-for="att in attachments" :key="att.id" class="att">
          <img v-if="previews[att.id]" :src="previews[att.id]" :alt="att.name" class="att-thumb" />
          <v-icon v-else icon="mdi-file-outline" size="20" class="att-icon" />
          <div class="att-meta">
            <div class="att-name text-truncate" :title="att.name">{{ att.name }}</div>
            <div class="att-size text-medium-emphasis">{{ formatSize(att.size) }}</div>
          </div>
          <v-btn
            icon="mdi-close"
            variant="text"
            size="x-small"
            :title="t('yaya.input.remove', '移除附件')"
            :aria-label="t('yaya.input.remove', '移除附件')"
            @click="remove(att.id)"
          />
        </div>
        <div v-if="importing" class="att">
          <v-progress-circular indeterminate size="18" width="2" />
          <span class="text-medium-emphasis att-size">{{
            t('yaya.input.importing', '正在添加…')
          }}</span>
        </div>
      </div>

      <v-textarea
        ref="textarea"
        v-model="draft"
        :placeholder="te('yaya.input.placeholder', { name: assistantName }, '给 {name} 发消息')"
        rows="1"
        max-rows="8"
        auto-grow
        variant="plain"
        hide-details
        class="input-textarea"
        @keydown="onKeyDown"
      />

      <div class="input-tools">
        <v-btn
          icon="mdi-paperclip"
          variant="text"
          size="small"
          :disabled="importing"
          :title="t('yaya.input.attach', '添加附件')"
          :aria-label="t('yaya.input.attach', '添加附件')"
          @click="attach"
        />
        <span class="hint text-disabled">
          {{ coarse ? '' : t('yaya.input.hint', 'Enter 发送 · Shift+Enter 换行') }}
        </span>
        <v-spacer />
        <v-btn
          v-if="isRunning"
          color="error"
          variant="tonal"
          prepend-icon="mdi-stop"
          class="send-btn"
          @click="emit('abort')"
        >
          {{ t('yaya.stop', '停止') }}
        </v-btn>
        <v-btn
          v-else
          color="primary"
          variant="flat"
          prepend-icon="mdi-arrow-up"
          class="send-btn"
          :disabled="!canSend"
          @click="send"
        >
          {{ t('yaya.send', '发送') }}
        </v-btn>
      </div>
    </div>
    <div v-if="attachError" class="attach-error text-error">{{ attachError }}</div>
  </div>
</template>

<style scoped>
.input-wrap {
  width: 100%;
  max-width: 820px;
  margin: 0 auto;
}
.input-card {
  display: flex;
  flex-direction: column;
  padding: 10px 12px 8px;
  border-radius: 20px;
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.82));
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-border-color), calc(var(--v-border-opacity) * 1.5));
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  transition: border-color 0.15s;
}
.input-card:focus-within {
  border-color: rgba(var(--v-theme-primary), 0.55);
}
.input-textarea :deep(textarea) {
  font-size: 0.95rem;
  line-height: 1.55;
  padding: 6px 6px 4px;
  mask-image: none;
  -webkit-mask-image: none;
}
.input-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
}
.hint {
  font-size: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.send-btn {
  border-radius: 999px;
}
.att-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 2px 2px 8px;
}
.att {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 260px;
  min-height: 44px;
  padding: 4px 4px 4px 6px;
  border-radius: 12px;
  background: rgba(var(--v-theme-on-surface), 0.06);
}
.att-thumb {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
}
.att-icon {
  margin: 0 6px;
}
.att-meta {
  min-width: 0;
  flex: 1 1 auto;
}
.att-name {
  font-size: 0.85rem;
}
.att-size {
  font-size: 0.72rem;
}
.attach-error {
  font-size: 0.8rem;
  padding: 6px 12px 0;
}
@media (max-width: 720px) {
  .input-card {
    border-radius: 16px;
    padding: 8px 8px 6px;
  }
  .hint {
    display: none;
  }
  .att {
    max-width: 100%;
  }
}
</style>
