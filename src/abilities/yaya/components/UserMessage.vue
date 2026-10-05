<script setup lang="ts">
import { computed, inject, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import { vLongPress, type LongPressPoint } from '../../../main/ui/directives/long-press'
import type { MessageNode } from '../types'
import type { MessageMenuRequest } from './message-menu'
import ImagePreviewDialog from './ImagePreviewDialog.vue'
import { assetUrl } from './asset-url'

const props = defineProps<{
  message: MessageNode
  /** 有工作流在跑时禁止编辑重发 */
  busy: boolean
}>()

const emit = defineEmits<{
  (e: 'switchBranch', messageId: string): void
  /** 编辑后重发：在原消息的父节点下开新分支 */
  (e: 'edit', text: string): void
  (e: 'menu', req: MessageMenuRequest): void
}>()

/** 编辑态由父组件控制（右键菜单「编辑」也能打开） */
const editing = defineModel<boolean>('editing', { default: false })

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const draft = ref('')
const copied = ref(false)
const previews = ref<Record<string, string>>({})
const editor = ref<{ focus: () => void } | null>(null)

function startEdit(): void {
  editing.value = true
}

watch(
  editing,
  async (on) => {
    if (!on) return
    draft.value = props.message.content
    await nextTick()
    editor.value?.focus()
  },
  { immediate: true }
)

function openMenu(x: number, y: number): void {
  emit('menu', {
    x,
    y,
    kind: 'user',
    messageId: props.message.id,
    text: props.message.content,
    selection: window.getSelection()?.toString() ?? ''
  })
}
function onContextMenu(ev: MouseEvent): void {
  ev.preventDefault()
  openMenu(ev.clientX, ev.clientY)
}
function onLongPress(p: LongPressPoint): void {
  openMenu(p.clientX, p.clientY)
}

/** 这条消息里的 @ 点名（只显示；附注 mentionNote 只给模型看） */
const mentionList = computed(() => {
  const list = props.message.meta?.mentions
  return Array.isArray(list) ? (list as { ref: string; label: string; kind: string }[]) : []
})

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

onMounted(() => {
  for (const att of props.message.attachments ?? []) {
    if (att.mimeType.startsWith('image/')) previews.value[att.id] = assetUrl(att.assetPath)
  }
})

/** 缩略图加载失败（文件已删等）：退回文件名 chip */
function dropPreview(id: string): void {
  delete previews.value[id]
}

/** 图片（已有预览）= 缩略图网格，点击看大图；其余 = 文件 chip */
const imageAttachments = computed(() =>
  (props.message.attachments ?? []).filter(
    (a) => a.mimeType.startsWith('image/') && !!previews.value[a.id]
  )
)
const fileAttachments = computed(() =>
  (props.message.attachments ?? []).filter((a) => !imageAttachments.value.includes(a))
)
const previewImages = computed(() =>
  imageAttachments.value.map((a) => ({ src: previews.value[a.id], name: a.name }))
)

const previewOpen = ref(false)
const previewIndex = ref(0)
function openPreview(id: string): void {
  const i = imageAttachments.value.findIndex((a) => a.id === id)
  if (i < 0) return
  previewIndex.value = i
  previewOpen.value = true
}
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
        <button
          v-for="att in imageAttachments"
          :key="att.id"
          type="button"
          class="thumb"
          :title="att.name"
          :aria-label="`${t('yaya.input.image_preview_open', '查看大图')}: ${att.name}`"
          @click="openPreview(att.id)"
        >
          <img
            :src="previews[att.id]"
            :alt="att.name"
            loading="lazy"
            @error="dropPreview(att.id)"
          />
        </button>
        <div v-for="att in fileAttachments" :key="att.id" class="file-chip" :title="att.name">
          <v-icon icon="mdi-file-outline" size="16" />
          <span class="text-truncate">{{ att.name }}</span>
        </div>
      </div>
      <div v-if="mentionList.length" class="mentions">
        <span v-for="m in mentionList" :key="m.ref" class="mention-tag">
          <v-icon :icon="m.kind === 'tool' ? 'mdi-wrench-outline' : 'mdi-at'" size="14" />
          {{ m.label }}
        </span>
      </div>
      <div
        v-if="message.content"
        v-long-press="onLongPress"
        class="bubble"
        @contextmenu="onContextMenu"
      >
        {{ message.content }}
      </div>

      <div class="user-actions">
        <v-btn
          icon
          variant="text"
          density="comfortable"
          :title="copied ? t('yaya.copied', '已复制') : t('yaya.copy', '复制')"
          :aria-label="t('yaya.copy', '复制')"
          @click="copy"
        >
          <v-icon :icon="copied ? 'mdi-check' : 'mdi-content-copy'" size="20" />
        </v-btn>
        <v-btn
          icon="mdi-pencil-outline"
          variant="text"
          density="comfortable"
          :disabled="busy"
          :title="t('yaya.edit', '编辑并重新发送')"
          :aria-label="t('yaya.edit', '编辑并重新发送')"
          @click="startEdit"
        />
        <v-btn
          icon="mdi-dots-horizontal"
          variant="text"
          density="comfortable"
          :title="t('yaya.more', '更多')"
          :aria-label="t('yaya.more', '更多')"
          @click="(e: MouseEvent) => openMenu(e.clientX, e.clientY)"
        />
      </div>
    </template>

    <ImagePreviewDialog v-model="previewOpen" :images="previewImages" :index="previewIndex" />
  </div>
</template>

<style scoped>
.mentions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  max-width: 100%;
}
.mention-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 28px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  background: rgba(var(--v-theme-primary), 0.12);
  word-break: break-all;
}
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
  border-radius: 18px 6px 18px 18px;
  background: rgba(var(--v-theme-primary), 0.16);
  border: 1px solid rgba(var(--v-theme-primary), 0.28);
  backdrop-filter: blur(16px) saturate(1.15);
  -webkit-backdrop-filter: blur(16px) saturate(1.15);
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.05);
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
  align-self: flex-end;
  width: fit-content;
  gap: 8px;
  max-width: 85%;
}
.thumb {
  display: block;
  flex: 0 0 88px;
  width: 88px;
  height: 88px;
  padding: 0;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: none;
  cursor: zoom-in;
}
.thumb:hover {
  border-color: rgba(var(--v-theme-primary), 0.6);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
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
  min-height: 44px;
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
  .attachments {
    justify-content: flex-end;
  }
  .thumb {
    flex-basis: 72px;
    width: 72px;
    height: 72px;
  }
}

@container yaya (max-width: 600px) {
  .bubble {
    max-width: 92%;
    padding: 8px 12px;
    font-size: 0.9rem;
    line-height: 1.55;
    border-radius: 14px 6px 14px 14px;
  }
  .attachments {
    justify-content: flex-end;
  }
  .thumb {
    flex-basis: 64px;
    width: 64px;
    height: 64px;
  }
  .user-actions {
    min-height: 34px;
  }
  .user-actions :deep(.v-btn) {
    width: 34px;
    height: 34px;
  }
  .user-actions :deep(.v-icon) {
    font-size: 18px;
  }
}
</style>
