<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  ref,
  shallowReactive,
  toRef,
  watch
} from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { MessageAttachment, ReasoningEffort, WorkflowInfo } from '../types'
import ImagePreviewDialog from './ImagePreviewDialog.vue'
import { assetUrl } from './asset-url'
import { ensurePluginMap, inputExtensions } from './plugin-ui-registry'
import { matchInputTrigger, type PluginInputContext, type PluginInputHooks } from './plugin-input'

const props = defineProps<{
  isRunning: boolean
  sessionId: string
  assistantName: string
  /** 新对话草稿还没有会话时，添加附件前先创建会话 */
  ensureSession: () => Promise<string>
  workflows: WorkflowInfo[]
}>()

const emit = defineEmits<{
  (e: 'send', prompt: string, attachments: MessageAttachment[], mentions: string[]): void
  (e: 'abort'): void
}>()

/** 草稿由父组件持有（空状态的建议会往里填） */
const draft = defineModel<string>({ default: '' })
/** 当前会话使用的工作流 */
const workflowId = defineModel<string>('workflowId', { default: 'agent' })
/** 当前会话的思考强度 */
const reasoning = defineModel<ReasoningEffort>('reasoning', { default: 'default' })
const REASONING_OPTIONS: { value: ReasoningEffort; icon: string }[] = [
  { value: 'default', icon: 'mdi-brain' },
  { value: 'off', icon: 'mdi-lightning-bolt-outline' },
  { value: 'low', icon: 'mdi-signal-cellular-1' },
  { value: 'medium', icon: 'mdi-signal-cellular-2' },
  { value: 'high', icon: 'mdi-signal-cellular-3' }
]
const reasoningLabel = (v: ReasoningEffort): string =>
  ({
    default: t('yaya.reasoning.default', '默认思考'),
    off: t('yaya.reasoning.off', '不思考'),
    low: t('yaya.reasoning.low', '浅思考'),
    medium: t('yaya.reasoning.medium', '中等思考'),
    high: t('yaya.reasoning.high', '深度思考')
  })[v]
const reasoningIcon = computed(
  () => REASONING_OPTIONS.find((o) => o.value === reasoning.value)?.icon ?? 'mdi-brain'
)

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
    !importing.value &&
    (!!draft.value.trim() ||
      attachments.value.length > 0 ||
      [...inputHooks.values()].some((hooks) => hooks.hasContent?.()))
)

// Extensions register per composer instance; disabling a plugin unmounts and unregisters it.
const inputHooks = shallowReactive(new Map<symbol, PluginInputHooks>())
const toolbarTarget = ref<HTMLElement | null>(null)
ensurePluginMap()

function nativeTextarea(): HTMLTextAreaElement | null {
  const el = (textarea.value as unknown as { $el?: HTMLElement } | null)?.$el
  return el?.querySelector('textarea') ?? null
}

const inputContext: PluginInputContext = {
  draft,
  sessionId: toRef(props, 'sessionId'),
  toolbarTarget,
  focus: () => textarea.value?.focus(),
  selection: () => {
    const el = nativeTextarea()
    return {
      start: el?.selectionStart ?? draft.value.length,
      end: el?.selectionEnd ?? draft.value.length
    }
  },
  replaceRange: (start, end, text) => {
    draft.value = draft.value.slice(0, start) + text + draft.value.slice(end)
    void nextTick(() => {
      const el = nativeTextarea()
      el?.focus()
      el?.setSelectionRange(start + text.length, start + text.length)
    })
  },
  register: (hooks) => {
    const key = Symbol('input-extension')
    inputHooks.set(key, hooks)
    return () => {
      inputHooks.delete(key)
    }
  }
}

function onInput(): void {
  // Vuetify emits the model update after the native input event. Match the committed draft.
  void nextTick(notifyInput)
}

function notifyInput(): void {
  const selection = inputContext.selection()
  const caret = selection.start
  for (const hooks of inputHooks.values())
    hooks.onTrigger?.(
      selection.start === selection.end
        ? matchInputTrigger(draft.value, caret, hooks.triggers ?? [])
        : null
    )
}

function resetExtensions(): void {
  for (const hooks of inputHooks.values()) hooks.reset?.()
}
watch(() => props.sessionId, resetExtensions)
onBeforeUnmount(resetExtensions)

function onKeyDown(e: KeyboardEvent): void {
  if (e.isComposing || e.keyCode === 229) return
  for (const hooks of inputHooks.values()) {
    if (hooks.onKeyDown?.(e)) return
  }
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
/**
 * 输入框旁的按钮：按下时不抢走输入框焦点。否则手机上一按下键盘就开始收起、页面跟着重排，
 * 按钮在手指下面移走，抬起时落空（看起来按下了却没反应）。pointerdown 取消默认动作只阻止
 * 兼容鼠标事件（焦点转移），click 照常触发。
 */
function keepFocus(e: PointerEvent): void {
  const a = document.activeElement
  if (a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement) e.preventDefault()
}

function toggleExpanded(): void {
  expanded.value = !expanded.value
  textarea.value?.focus()
}

const currentWorkflow = computed(
  () => props.workflows.find((w) => w.id === workflowId.value) ?? props.workflows[0]
)

function send(): void {
  if (!canSend.value) return
  emit('send', draft.value.trim(), JSON.parse(JSON.stringify(attachments.value)), [
    ...new Set([...inputHooks.values()].flatMap((hooks) => hooks.collect?.().mentions ?? []))
  ])
  draft.value = ''
  resetExtensions()
  expanded.value = false
  attachments.value = []
  previews.value = {}
}

function remove(id: string): void {
  attachments.value = attachments.value.filter((a) => a.id !== id)
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 粘贴 / 拖放进来的单个文件上限（与主进程 yaya.asset-import-data 一致） */
const MAX_PASTED_BYTES = 20 * 1024 * 1024

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

/** 图片附件（已有预览）显示成缩略图；其余（含预览失败的图片）显示文件 chip */
const imageAttachments = computed(() =>
  attachments.value.filter((a) => a.mimeType.startsWith('image/') && !!previews.value[a.id])
)
const fileAttachments = computed(() =>
  attachments.value.filter((a) => !imageAttachments.value.includes(a))
)
const previewImages = computed(() =>
  imageAttachments.value.map((a) => ({ src: previews.value[a.id], name: a.name }))
)

async function attach(): Promise<void> {
  attachError.value = ''
  const paths = await window.cockpit.pickFiles({ title: t('yaya.input.pick_title', '选择附件') })
  await importPaths(paths)
}

async function importPaths(paths: string[]): Promise<void> {
  if (!paths.length) return
  importing.value = true
  try {
    const session = await props.ensureSession()
    for (const p of paths) {
      try {
        const att = (await window.cockpit.command('yaya.asset-import', {
          session,
          path: p
        })) as MessageAttachment
        await addAttachment(att)
      } catch (e) {
        attachError.value = te(
          'yaya.input.attach_file_failed',
          { name: baseName(p), error: errText(e) },
          '添加「{name}」失败：{error}'
        )
      }
    }
  } catch (e) {
    attachError.value = te(
      'yaya.input.attach_failed',
      { error: errText(e) },
      '添加附件失败：{error}'
    )
  } finally {
    importing.value = false
    textarea.value?.focus()
  }
}

/** 粘贴 / 拖放的文件：读成 base64 走 yaya.asset-import-data，逐个导入、互不影响 */
async function importDataFiles(files: File[]): Promise<void> {
  if (!files.length) return
  const tooBig = files.find((f) => f.size > MAX_PASTED_BYTES)
  if (tooBig) {
    attachError.value = te(
      'yaya.input.attach_too_large',
      { name: tooBig.name },
      '「{name}」超过 20MB，无法作为附件'
    )
    return
  }
  importing.value = true
  attachError.value = ''
  try {
    const session = await props.ensureSession()
    for (const f of files) {
      try {
        const name = f.name || `pasted-${Date.now()}`
        const data = await readAsBase64(f)
        const att = (await window.cockpit.command('yaya.asset-import-data', {
          session,
          name,
          mime: f.type || 'application/octet-stream',
          data
        })) as MessageAttachment
        await addAttachment(att)
      } catch (e) {
        attachError.value = te(
          'yaya.input.attach_file_failed',
          { name: f.name, error: errText(e) },
          '添加「{name}」失败：{error}'
        )
      }
    }
  } catch (e) {
    attachError.value = te(
      'yaya.input.attach_failed',
      { error: errText(e) },
      '添加附件失败：{error}'
    )
  } finally {
    importing.value = false
    textarea.value?.focus()
  }
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      const comma = text.indexOf(',')
      resolve(comma >= 0 ? text.slice(comma + 1) : text)
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

/** 加入附件列表并拉预览图（图片） */
async function addAttachment(att: MessageAttachment): Promise<void> {
  if (attachments.value.some((a) => a.id === att.id)) return
  attachments.value.push(att)
  if (att.mimeType.startsWith('image/')) previews.value[att.id] = assetUrl(att.assetPath)
}

/** 粘贴：有图片文件时按附件导入，纯文本保持默认行为 */
async function onPaste(e: ClipboardEvent): Promise<void> {
  const dt = e.clipboardData
  if (!dt) return
  let files: File[] = []
  if (dt.files?.length) files = Array.from(dt.files)
  else {
    for (const item of Array.from(dt.items ?? [])) {
      if (item.kind !== 'file') continue
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  const images = files.filter((f) => f.type.startsWith('image/'))
  if (!images.length) return
  e.preventDefault()
  await importDataFiles(images)
}

function onDragOver(e: DragEvent): void {
  // 不 preventDefault 不会触发 drop
  e.preventDefault()
}

async function onDrop(e: DragEvent): Promise<void> {
  e.preventDefault()
  const files = Array.from(e.dataTransfer?.files ?? [])
  await importDataFiles(files)
}

const previewOpen = ref(false)
const previewIndex = ref(0)

function openPreview(id: string): void {
  const i = imageAttachments.value.findIndex((a) => a.id === id)
  if (i < 0) return
  previewIndex.value = i
  previewOpen.value = true
}

/** 安卓 App 分享进来的内容：文件（已在宿主上）变成附件，文字接在草稿后面 */
async function acceptShare(share: {
  paths?: string[]
  text?: string
  error?: string
}): Promise<void> {
  if (share.error)
    attachError.value = te(
      'yaya.input.share_failed',
      { error: share.error },
      '接收分享失败：{error}'
    )
  const text = share.text?.trim()
  if (text) draft.value = draft.value ? `${draft.value}\n${text}` : text
  if (share.paths?.length) await importPaths(share.paths)
}

defineExpose({ focus: () => textarea.value?.focus(), acceptShare })
</script>

<template>
  <div class="input-wrap" :class="{ 'is-expanded': expanded }">
    <div class="input-card" @dragover.prevent="onDragOver" @drop.prevent="onDrop">
      <component
        :is="extension.component"
        v-for="extension in inputExtensions"
        :key="extension.pluginId"
        :context="inputContext"
      />
      <div v-if="attachments.length || importing" class="att-row">
        <div v-for="att in imageAttachments" :key="att.id" class="att-img">
          <button
            type="button"
            class="att-thumb-btn"
            :title="`${t('yaya.input.image_preview_open', '查看大图')}: ${att.name}`"
            :aria-label="`${t('yaya.input.image_preview_open', '查看大图')}: ${att.name}`"
            @click="openPreview(att.id)"
          >
            <img
              v-if="previews[att.id]"
              :src="previews[att.id]"
              :alt="att.name"
              class="att-thumb"
            />
            <v-icon v-else icon="mdi-image-outline" size="24" class="att-thumb-missing" />
          </button>
          <button
            type="button"
            class="att-remove"
            :title="t('yaya.input.remove', '移除附件')"
            :aria-label="t('yaya.input.remove', '移除附件')"
            @click="remove(att.id)"
          >
            <v-icon icon="mdi-close" size="16" />
          </button>
        </div>
        <div v-for="att in fileAttachments" :key="att.id" class="att">
          <v-icon icon="mdi-file-outline" size="20" class="att-icon" />
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
          @input="onInput"
          @click="onInput"
          @keyup="onInput"
          @paste="onPaste"
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
          @pointerdown="keepFocus"
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
          @pointerdown="keepFocus"
          @click="attach"
        />
        <div ref="toolbarTarget" class="plugin-input-tools" />
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
        <v-menu location="top start">
          <template #activator="{ props: menuProps }">
            <button
              v-bind="menuProps"
              type="button"
              class="wf-pick"
              :title="t('yaya.reasoning.title', '思考强度')"
              :aria-label="`${t('yaya.reasoning.title', '思考强度')}: ${reasoningLabel(reasoning)}`"
            >
              <v-icon :icon="reasoningIcon" size="16" />
              <span class="wf-pick-label">{{ reasoningLabel(reasoning) }}</span>
              <v-icon icon="mdi-chevron-up" size="16" />
            </button>
          </template>
          <v-list density="comfortable" max-width="300" class="wf-menu">
            <v-list-subheader>{{ t('yaya.reasoning.title', '思考强度') }}</v-list-subheader>
            <v-list-item
              v-for="o in REASONING_OPTIONS"
              :key="o.value"
              :active="o.value === reasoning"
              :prepend-icon="o.icon"
              color="primary"
              @click="reasoning = o.value"
            >
              <v-list-item-title>{{ reasoningLabel(o.value) }}</v-list-item-title>
              <v-list-item-subtitle v-if="o.value === 'default'" class="wf-desc">
                {{ t('yaya.reasoning.default_hint', '不发送思考参数，按模型自己的默认') }}
              </v-list-item-subtitle>
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
          @pointerdown="keepFocus"
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
          @pointerdown="keepFocus"
          @click="send"
        >
          <span class="btn-text">{{
            isRunning ? t('yaya.input.interrupt_send', '打断并发送') : t('yaya.send', '发送')
          }}</span>
        </v-btn>
      </div>
    </div>
    <ImagePreviewDialog v-model="previewOpen" :images="previewImages" :index="previewIndex" />
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
  /* @ 候选框相对它定位 */
  position: relative;
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
/* 弹出菜单：图标与文字之间默认 32px 的空隙在手机上显得很散，收紧到与顶栏菜单一致 */
.wf-menu :deep(.v-list-item__spacer) {
  width: 14px !important;
}
.wf-menu :deep(.v-list-item) {
  min-height: 44px;
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
.plugin-input-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}
.plugin-input-tools:empty {
  display: none;
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
/* 图片附件：方形缩略图，点开预览；右上角移除按钮（触屏热区 ≥ 32px） */
.att-img {
  position: relative;
  flex-shrink: 0;
  margin: 6px;
}
.att-thumb-btn {
  display: block;
  width: 64px;
  height: 64px;
  padding: 0;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px;
  overflow: hidden;
  background: rgba(var(--v-theme-on-surface), 0.06);
  cursor: zoom-in;
}
.att-thumb-btn:hover {
  border-color: rgba(var(--v-theme-primary), 0.6);
}
.att-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.att-thumb-missing {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: rgba(var(--v-theme-on-surface), 0.45);
}
.att-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 50%;
  background: rgba(var(--v-theme-surface), 0.95);
  color: rgb(var(--v-theme-on-surface));
  cursor: pointer;
}
.att-remove:hover {
  background: rgba(var(--v-theme-error), 0.16);
}
/* 触屏：移除按钮热区再放大一点 */
@media (pointer: coarse) {
  .att-remove {
    width: 40px;
    height: 40px;
  }
  .att-remove :deep(.v-icon) {
    font-size: 20px;
  }
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
  .att-img {
    margin: 4px;
  }
  .att-thumb-btn {
    width: 56px;
    height: 56px;
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
  /* 两个选择器（工作流 / 思考）只留图标，名字在 aria-label / 菜单里 */
  .wf-pick-label {
    display: none;
  }
}
</style>
