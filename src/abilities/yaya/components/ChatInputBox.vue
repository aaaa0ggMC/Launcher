<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { MessageAttachment, WorkflowInfo } from '../types'

const props = defineProps<{
  isRunning: boolean
  sessionId: string
  assistantName: string
  /** 新对话草稿还没有会话时，添加附件前先创建会话 */
  ensureSession: () => Promise<string>
  workflows: WorkflowInfo[]
}>()

const emit = defineEmits<{
  (e: 'send', prompt: string, attachments: MessageAttachment[]): void
  (e: 'abort'): void
}>()

/** 草稿由父组件持有（空状态的建议会往里填） */
const draft = defineModel<string>({ default: '' })
/** 当前会话使用的工作流 */
const workflowId = defineModel<string>('workflowId', { default: 'agent' })
/** 展开态（大编辑区，盖住消息区下半部分）由父组件定位 */
const expanded = defineModel<boolean>('expanded', { default: false })

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
    // 运行中也能发：= 打断当前运行（已生成的内容和已执行的工具结果都保留）+ 以这条消息继续
    !importing.value && (!!draft.value.trim() || attachments.value.length > 0)
)

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && expanded.value) {
    expanded.value = false
    return
  }
  if (e.key !== 'Enter' || e.isComposing || coarse) return
  // 展开态写长文：Enter 换行，Ctrl/⌘+Enter 发送；收起态：Enter 发送，Shift+Enter 换行
  if (expanded.value ? !(e.ctrlKey || e.metaKey) : e.shiftKey) return
  e.preventDefault()
  send()
}

/** 多行 / 较长时才显示展开按钮（展开态总是显示收起） */
const canExpand = computed(
  () => expanded.value || draft.value.includes('\n') || draft.value.length > 80
)
function toggleExpanded(): void {
  expanded.value = !expanded.value
  textarea.value?.focus()
}

const currentWorkflow = computed(
  () => props.workflows.find((w) => w.id === workflowId.value) ?? props.workflows[0]
)

function send(): void {
  if (!canSend.value) return
  emit('send', draft.value.trim(), JSON.parse(JSON.stringify(attachments.value)))
  draft.value = ''
  expanded.value = false
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
  <div class="input-wrap" :class="{ 'is-expanded': expanded }">
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

      <div class="text-wrap">
        <v-textarea
          ref="textarea"
          v-model="draft"
          :placeholder="te('yaya.input.placeholder', { name: assistantName }, '给 {name} 发消息')"
          :rows="expanded ? 12 : 1"
          :max-rows="expanded ? undefined : 6"
          :auto-grow="!expanded"
          no-resize
          variant="plain"
          hide-details
          class="input-textarea"
          @keydown="onKeyDown"
        />
        <v-btn
          v-if="canExpand"
          :icon="expanded ? 'mdi-arrow-collapse' : 'mdi-arrow-expand'"
          variant="text"
          density="comfortable"
          class="expand-btn"
          :title="expanded ? t('yaya.input.collapse', '收起') : t('yaya.input.expand', '展开编辑')"
          :aria-label="
            expanded ? t('yaya.input.collapse', '收起') : t('yaya.input.expand', '展开编辑')
          "
          @click="toggleExpanded"
        />
      </div>

      <div class="input-tools">
        <v-btn
          icon="mdi-paperclip"
          variant="text"
          density="comfortable"
          :disabled="importing"
          :title="t('yaya.input.attach', '添加附件')"
          :aria-label="t('yaya.input.attach', '添加附件')"
          @click="attach"
        />
        <v-menu v-if="workflows.length > 1" location="top start">
          <template #activator="{ props: menuProps }">
            <button
              v-bind="menuProps"
              type="button"
              class="wf-pick"
              :title="t('yaya.input.workflow', '工作流')"
              :aria-label="`${t('yaya.input.workflow', '工作流')}: ${currentWorkflow?.label ?? ''}`"
            >
              <v-icon icon="mdi-source-branch" size="16" />
              <span class="wf-pick-label">{{ currentWorkflow?.label }}</span>
              <v-icon icon="mdi-chevron-up" size="16" />
            </button>
          </template>
          <v-list density="comfortable" max-width="340" class="wf-menu">
            <v-list-item
              v-for="w in workflows"
              :key="w.id"
              :active="w.id === workflowId"
              color="primary"
              @click="workflowId = w.id"
            >
              <v-list-item-title class="font-weight-medium">{{ w.label }}</v-list-item-title>
              <v-list-item-subtitle class="wf-desc">{{ w.description }}</v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </v-menu>
        <span class="hint text-disabled">
          {{
            coarse
              ? ''
              : expanded
                ? t('yaya.input.hint_expanded', 'Ctrl+Enter 发送 · Esc 收起')
                : t('yaya.input.hint', 'Enter 发送 · Shift+Enter 换行')
          }}
        </span>
        <v-spacer />
        <v-btn
          v-if="isRunning"
          color="error"
          variant="tonal"
          prepend-icon="mdi-stop"
          class="send-btn"
          :aria-label="t('yaya.stop', '停止')"
          @click="emit('abort')"
        >
          <span class="btn-text">{{ t('yaya.stop', '停止') }}</span>
        </v-btn>
        <v-btn
          v-if="!isRunning || canSend"
          color="primary"
          variant="flat"
          :prepend-icon="isRunning ? 'mdi-debug-step-over' : 'mdi-arrow-up'"
          class="send-btn"
          :disabled="!canSend"
          :title="
            isRunning
              ? t(
                  'yaya.input.interrupt_send_hint',
                  '停止当前回答（保留已完成的部分），用这条消息继续'
                )
              : undefined
          "
          :aria-label="
            isRunning ? t('yaya.input.interrupt_send', '打断并发送') : t('yaya.send', '发送')
          "
          @click="send"
        >
          <span class="btn-text">{{
            isRunning ? t('yaya.input.interrupt_send', '打断并发送') : t('yaya.send', '发送')
          }}</span>
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
.text-wrap {
  position: relative;
}
.expand-btn {
  position: absolute;
  top: 0;
  right: -4px;
  opacity: 0.6;
}
.expand-btn:hover {
  opacity: 1;
}
.text-wrap:has(.expand-btn) .input-textarea :deep(textarea) {
  padding-right: 36px;
}
/* 展开态：外层由 View 撑高，编辑区吃满剩余高度 */
.input-wrap.is-expanded,
.input-wrap.is-expanded .input-card {
  height: 100%;
}
.input-wrap.is-expanded .input-card {
  display: flex;
  flex-direction: column;
}
.input-wrap.is-expanded .text-wrap {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
.input-wrap.is-expanded .input-textarea {
  flex: 1 1 auto;
}
.input-wrap.is-expanded .input-textarea :deep(.v-input__control),
.input-wrap.is-expanded .input-textarea :deep(.v-field),
.input-wrap.is-expanded .input-textarea :deep(.v-field__field) {
  height: 100%;
}
.input-wrap.is-expanded .input-textarea :deep(textarea) {
  height: 100% !important;
  max-height: none;
  overflow-y: auto;
}
.wf-pick {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  max-width: 180px;
  padding: 4px 8px 4px 10px;
  border-radius: 999px;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: none;
  color: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}
.wf-pick:hover {
  background: rgba(var(--v-theme-primary), 0.08);
}
.wf-pick-label {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wf-desc {
  white-space: normal !important;
  -webkit-line-clamp: 3 !important;
  line-height: 1.4;
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

@container yaya (max-width: 600px) {
  .input-card {
    padding: 6px 8px 4px;
    border-radius: 16px;
  }
  .input-textarea :deep(textarea) {
    font-size: 0.9rem;
    padding: 4px 4px 2px;
  }
  .input-tools {
    min-height: 36px;
    gap: 4px;
  }
  .hint {
    display: none;
  }
  .wf-pick {
    min-height: 30px;
    max-width: 130px;
    padding: 2px 6px 2px 8px;
    font-size: 0.75rem;
  }
  .att {
    min-height: 40px;
  }
}
/* 很窄时发送 / 停止只留图标（保留 aria-label） */
@container yaya (max-width: 420px) {
  .send-btn .btn-text {
    display: none;
  }
  .send-btn {
    min-width: 44px !important;
    padding-inline: 10px !important;
  }
  .send-btn :deep(.v-btn__prepend) {
    margin-inline: 0 !important;
  }
}
</style>
