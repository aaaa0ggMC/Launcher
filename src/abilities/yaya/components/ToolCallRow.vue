<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { ApprovalScope, ToolCallItem } from '../types'
import { summarizeArgs } from './turns'
import { argFields, resultFields, type FieldView } from './tool-view'
import { highlightCode } from './markdown'
import { toolViewFor } from './plugin-ui-registry'
import { assetUrl } from './asset-url'

const props = defineProps<{
  call: ToolCallItem
  /** 这条调用正挂起等待用户确认（且 Runner 还活着，按钮可用） */
  awaitingApproval: boolean
}>()

const emit = defineEmits<{
  /** 拒绝时可附理由，会作为工具结果回传给模型 */
  (e: 'approve', approved: boolean, reason?: string, scope?: ApprovalScope): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const open = ref(false)
const summary = computed(() => summarizeArgs(props.call))
const args = computed(() => argFields(props.call.args))
/** 插件为这个工具注册了结果视图时，结果区交给它（参数区仍用默认视图） */
const pluginView = computed(() => toolViewFor(props.call.name))
const results = computed(() => (pluginView.value ? [] : resultFields(props.call.result)))

// 工具产出的图片（会话资产）：默认视图显示缩略图，插件视图自己处理
const imageUrls = ref<string[]>([])
const imagesLoaded = ref(false)
function loadImages(): void {
  if (imagesLoaded.value || !props.call.images?.length) return
  imagesLoaded.value = true
  imageUrls.value = props.call.images.map(assetUrl)
}
watch(
  () => open.value && !pluginView.value,
  (show) => {
    if (show) loadImages()
  }
)
const zoomed = ref<string | null>(null)

/** 代码 / JSON 字段的高亮 HTML（highlight.js 未加载时是转义纯文本） */
function codeHtml(f: FieldView): string {
  return highlightCode(f.value, f.lang ?? 'plaintext')
}

const statusIcon = computed(() => {
  switch (props.call.status) {
    case 'success':
      return { icon: 'mdi-check-circle-outline', color: 'success' }
    case 'failed':
      return { icon: 'mdi-close-circle-outline', color: 'error' }
    case 'awaiting_approval':
      return { icon: 'mdi-shield-alert-outline', color: 'warning' }
    default:
      return { icon: 'mdi-wrench-outline', color: undefined }
  }
})
const running = computed(() => props.call.status === 'executing')
const duration = computed(() => {
  const ms = props.call.ms
  if (ms === undefined) return ''
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
})

// ---- 拒绝并说明 ----
const rejecting = ref(false)
const reason = ref('')
const reasonField = ref<{ focus: () => void } | null>(null)

async function startReject(): Promise<void> {
  rejecting.value = true
  await nextTick()
  reasonField.value?.focus()
}
function cancelReject(): void {
  rejecting.value = false
  reason.value = ''
}
function submitReject(): void {
  emit('approve', false, reason.value.trim() || undefined)
  cancelReject()
}
function onReasonKey(e: KeyboardEvent): void {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitReject()
  else if (e.key === 'Escape') cancelReject()
}
</script>

<template>
  <div class="tool-row" :class="{ 'is-awaiting': awaitingApproval }">
    <button
      type="button"
      class="tool-head"
      :aria-expanded="open"
      :title="open ? t('yaya.tool.collapse', '收起详情') : t('yaya.tool.expand', '展开详情')"
      @click="open = !open"
    >
      <v-progress-circular v-if="running" indeterminate size="16" width="2" color="primary" />
      <v-icon v-else :icon="statusIcon.icon" :color="statusIcon.color" size="20" />
      <span class="tool-name">{{ call.name }}</span>
      <span class="tool-summary text-medium-emphasis">{{ summary }}</span>
      <span v-if="duration" class="tool-ms text-disabled">{{ duration }}</span>
      <v-icon
        :icon="open ? 'mdi-chevron-up' : 'mdi-chevron-down'"
        size="18"
        class="flex-shrink-0 text-medium-emphasis"
      />
    </button>

    <!-- 字段视图：参数（审批时总是展开）/ 结果 -->
    <template
      v-for="section in [
        { show: awaitingApproval || open, label: t('yaya.tool.args', '参数'), fields: args },
        { show: open && results.length > 0, label: t('yaya.tool.result', '结果'), fields: results }
      ]"
      :key="section.label"
    >
      <div v-if="section.show && section.fields.length" class="tool-section">
        <div v-if="!awaitingApproval || section.fields !== args" class="tool-label">
          {{ section.label }}
        </div>
        <div class="fields">
          <template v-for="(f, i) in section.fields" :key="`${f.key}-${i}`">
            <div v-if="f.kind === 'inline'" class="field-inline">
              <span v-if="f.key" class="field-key">{{ f.key }}</span>
              <span class="field-value" :class="{ 'text-error': f.danger }">{{ f.value }}</span>
            </div>
            <div v-else class="field-block">
              <div v-if="f.key" class="field-key" :class="{ 'text-error': f.danger }">
                {{ f.key }}
              </div>
              <!-- eslint-disable-next-line vue/no-v-html -- highlightCode 输出已转义 -->
              <pre
                v-if="f.kind === 'code' || f.kind === 'json'"
                class="tool-pre hl"
                v-html="codeHtml(f)"
              />
              <pre v-else class="tool-pre" :class="{ 'text-error': f.danger }">{{ f.value }}</pre>
            </div>
          </template>
        </div>
      </div>
    </template>

    <div v-if="open && pluginView" class="tool-section">
      <div class="tool-label">{{ t('yaya.tool.result', '结果') }}</div>
      <component
        :is="pluginView.component"
        :call="call"
        :plugin-id="pluginView.pluginId"
        :tool-name="pluginView.toolName"
      />
    </div>

    <div v-if="open && !pluginView && imageUrls.length" class="tool-section tool-images">
      <button
        v-for="(url, i) in imageUrls"
        :key="i"
        type="button"
        class="tool-image-btn"
        :title="t('yaya.tool.zoom', '查看大图')"
        :aria-label="t('yaya.tool.zoom', '查看大图')"
        @click="zoomed = url"
      >
        <img :src="url" alt="" class="tool-image" loading="lazy" />
      </button>
      <v-dialog
        :model-value="zoomed !== null"
        max-width="1200"
        @update:model-value="(v: boolean) => !v && (zoomed = null)"
      >
        <img v-if="zoomed" :src="zoomed" alt="" class="tool-image-zoom" @click="zoomed = null" />
      </v-dialog>
    </div>

    <div v-if="open && call.error && !results.length && !pluginView" class="tool-section">
      <div class="tool-label text-error">{{ t('yaya.tool.error', '错误') }}</div>
      <pre class="tool-pre text-error">{{ call.error }}</pre>
    </div>

    <div v-if="awaitingApproval" class="approval">
      <div class="approval-hint text-medium-emphasis">
        <v-icon icon="mdi-shield-alert-outline" size="16" color="warning" />
        {{ t('yaya.tool.approval_hint', '这个操作会修改系统状态，确认参数无误后再允许执行。') }}
      </div>
      <template v-if="!rejecting">
        <div class="approval-actions">
          <v-btn
            color="primary"
            variant="flat"
            prepend-icon="mdi-check"
            @click="emit('approve', true, undefined, 'once')"
          >
            {{ t('yaya.tool.approve', '允许执行') }}
          </v-btn>
          <v-btn
            color="primary"
            variant="tonal"
            prepend-icon="mdi-check-all"
            :title="t('yaya.tool.approve_run_hint', '这次运行里再调用这个工具不再询问')"
            @click="emit('approve', true, undefined, 'run')"
          >
            {{ t('yaya.tool.approve_run', '本次执行都允许') }}
          </v-btn>
          <v-btn
            variant="text"
            prepend-icon="mdi-shield-check-outline"
            :title="
              t(
                'yaya.tool.approve_session_hint',
                '这个对话以后都不再询问这个工具（可在右上角菜单撤销）'
              )
            "
            @click="emit('approve', true, undefined, 'session')"
          >
            {{ t('yaya.tool.approve_session', '本对话都允许') }}
          </v-btn>
          <span class="approval-gap" />
          <v-btn variant="outlined" prepend-icon="mdi-close" @click="emit('approve', false)">
            {{ t('yaya.tool.reject', '拒绝') }}
          </v-btn>
          <v-btn variant="text" prepend-icon="mdi-message-reply-text-outline" @click="startReject">
            {{ t('yaya.tool.reject_with_reason', '拒绝并说明') }}
          </v-btn>
        </div>
      </template>
      <template v-else>
        <v-textarea
          ref="reasonField"
          v-model="reason"
          variant="outlined"
          rows="2"
          auto-grow
          max-rows="6"
          hide-details
          :placeholder="
            t('yaya.tool.reason_placeholder', '告诉它为什么不行、或者应该怎么做（会发给模型）')
          "
          @keydown="onReasonKey"
        />
        <div class="approval-actions">
          <v-btn variant="text" @click="cancelReject">{{ t('yaya.cancel', '取消') }}</v-btn>
          <v-btn color="error" variant="tonal" prepend-icon="mdi-send" @click="submitReject">
            {{ t('yaya.tool.reject_send', '拒绝并发送理由') }}
          </v-btn>
        </div>
      </template>
    </div>

    <div v-if="call.rejectReason" class="reject-note text-medium-emphasis">
      <v-icon icon="mdi-message-reply-text-outline" size="16" />
      <span>{{ call.rejectReason }}</span>
    </div>
  </div>
</template>

<style scoped>
.tool-row {
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px;
  background: rgba(var(--v-theme-surface-variant), 0.22);
  overflow: hidden;
  container-type: inline-size;
}
.tool-row.is-awaiting {
  border-color: rgba(var(--v-theme-warning), 0.5);
}
.tool-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 8px 12px;
  background: none;
  border: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.tool-head:hover {
  background: rgba(var(--v-theme-on-surface), 0.04);
}
.tool-name {
  font-family: ui-monospace, monospace;
  font-size: 0.85rem;
  font-weight: 600;
  flex-shrink: 0;
}
.tool-summary {
  flex: 1 1 auto;
  min-width: 0;
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-ms {
  font-size: 0.75rem;
  flex-shrink: 0;
}
.tool-section {
  padding: 2px 12px 10px;
}
.tool-label {
  font-size: 0.75rem;
  font-weight: 600;
  opacity: 0.7;
  margin: 6px 0;
}
.fields {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-inline {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  font-size: 0.8rem;
  min-width: 0;
}
.field-key {
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.field-block .field-key {
  margin-bottom: 3px;
}
.field-value {
  font-family: ui-monospace, monospace;
  word-break: break-all;
  min-width: 0;
}
.tool-pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(var(--v-theme-on-surface), 0.05);
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}
/* 高亮配色跟主题（与正文代码块一致） */
.hl :deep(.hljs-keyword),
.hl :deep(.hljs-built_in) {
  color: rgb(var(--v-theme-primary));
  font-weight: 600;
}
.hl :deep(.hljs-string) {
  color: rgb(var(--v-theme-success));
}
.hl :deep(.hljs-number),
.hl :deep(.hljs-literal) {
  color: rgb(var(--v-theme-warning));
}
.hl :deep(.hljs-attr),
.hl :deep(.hljs-variable),
.hl :deep(.hljs-template-variable) {
  color: rgb(var(--v-theme-info));
}
.hl :deep(.hljs-comment) {
  color: rgba(var(--v-theme-on-surface), 0.5);
  font-style: italic;
}
.hl :deep(.hljs-meta),
.hl :deep(.hljs-punctuation) {
  color: rgba(var(--v-theme-on-surface), 0.6);
}
.approval {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 12px 12px;
}
.approval-hint {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 0.85rem;
  line-height: 1.5;
}
.approval-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
/* 允许类按钮与拒绝类按钮分成两组；放不下时自然换行 */
.approval-gap {
  flex: 1 1 0;
  min-width: 0;
}
.reject-note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 0 12px 10px 14px;
  font-size: 0.8rem;
  line-height: 1.5;
  word-break: break-word;
}
/* 窄容器：参数摘要换到第二行，内边距收紧 */
@container (max-width: 520px) {
  .tool-head {
    flex-wrap: wrap;
    row-gap: 2px;
    padding: 6px 10px;
    min-height: 40px;
    gap: 8px;
  }
  .tool-summary {
    order: 10;
    flex: 1 1 100%;
    padding-left: 28px;
  }
  .tool-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tool-section,
  .approval {
    padding-inline: 10px;
  }
  .tool-pre {
    padding: 8px 10px;
    font-size: 0.78rem;
  }
}
.tool-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.tool-image-btn {
  padding: 0;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 8px;
  overflow: hidden;
  background: none;
  cursor: zoom-in;
}
.tool-image {
  display: block;
  max-width: 240px;
  max-height: 180px;
  object-fit: contain;
}
.tool-image-zoom {
  display: block;
  max-width: 100%;
  max-height: calc(var(--app-vh, 100dvh) - 64px);
  margin: 0 auto;
  border-radius: 8px;
  cursor: zoom-out;
}
</style>
