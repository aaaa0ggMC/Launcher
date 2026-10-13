<script setup lang="ts">
/**
 * 表情面板外壳（R5 弹窗式 → 手机 QQ 式）：
 * - 桌面：原样中屏对话框；
 * - 手机 / 触屏：Teleport 到输入条下方的「底部面板区」（bottom-panel.ts），与键盘互斥——
 *   打开先收软键盘（仅粗指针，桌面窄窗口不丢输入焦点）、点输入条换回键盘、
 *   关掉时把焦点还回去。回应条（ReactionBar）与插入模式（EmojiInput）共用这一套。
 */
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from '../../../main/ui/i18n'
import type { ReactionItem } from './plugin-ui'
import EmojiPanelCard from './EmojiPanelCard.vue'
import { bottomPanelEl } from './bottom-panel'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    /** 哪一侧用（表情集有角色过滤）；回应条按消息角色传，插入模式固定用户侧 */
    role?: 'user' | 'assistant'
    /** 当前已有的表情 key（回应模式高亮用） */
    activeKeys?: string[]
    /** 点完表情关面板（回应模式）；插入模式传 false——QQ 式连选多枚，面板留着 */
    closeOnPick?: boolean
  }>(),
  { role: 'assistant', activeKeys: () => [], closeOnPick: true }
)

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void
  (e: 'pick', item: ReactionItem): void
}>()

const lang = inject('cockpit:lang', ref('zh'))
const { t } = useI18n(lang)

const open = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v)
})

/** 底部面板形态的判定与输入框的 sheetMode 同一套（粗指针 / ≤720px） */
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const narrowMq = typeof matchMedia === 'function' ? matchMedia('(max-width: 720px)') : null
const narrow = ref(narrowMq?.matches ?? false)
const onNarrowChange = (e: MediaQueryListEvent): void => {
  narrow.value = e.matches
}
narrowMq?.addEventListener('change', onNarrowChange)
onBeforeUnmount(() => narrowMq?.removeEventListener('change', onNarrowChange))

const useBottom = computed(() => (coarse || narrow.value) && !!bottomPanelEl.value)

const dockEl = ref<HTMLElement | null>(null)
/** 打开前的焦点（关掉时还回去 = 键盘换回来） */
let prevFocus: HTMLElement | null = null

function onPick(item: ReactionItem): void {
  emit('pick', item)
  if (props.closeOnPick) open.value = false
}

/** 焦点跑到面板外的输入元素（点输入条想打字）= 键盘换面板：关掉 */
function onFocusIn(e: FocusEvent): void {
  if (!open.value) return
  const t = e.target
  if (
    t instanceof HTMLElement &&
    (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT') &&
    !dockEl.value?.contains(t)
  )
    open.value = false
}

/** 安卓返回键（原生把返回转成 Escape）：先关面板 */
function onKeydown(e: KeyboardEvent): void {
  if (open.value && e.key === 'Escape') open.value = false
}

watch(open, (o) => {
  if (!useBottom.value) return // 桌面对话框自己管焦点
  if (o) {
    prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // QQ 式互斥：面板顶替键盘——把当前可输入焦点收掉（只在触屏上，桌面窄窗口不丢焦点）
    const a = document.activeElement
    if (coarse && a instanceof HTMLElement && a !== document.body) a.blur()
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('keydown', onKeydown, true)
    return
  }
  document.removeEventListener('focusin', onFocusIn, true)
  document.removeEventListener('keydown', onKeydown, true)
  // 关掉：焦点还给打开前的输入元素（没打开过键盘就别乱弹）
  const a = document.activeElement
  const aEditable = a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement
  if (prevFocus?.isConnected && (!aEditable || a === prevFocus)) prevFocus.focus()
  prevFocus = null
})

onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocusIn, true)
  document.removeEventListener('keydown', onKeydown, true)
})
</script>

<template>
  <!-- 桌面：原中屏对话框 -->
  <v-dialog v-if="!useBottom" v-model="open" max-width="560" scrollable>
    <EmojiPanelCard :role="role" :active-keys="activeKeys" @pick="onPick" />
  </v-dialog>
  <!-- 手机/触屏：QQ 式底部面板——落在输入条下方的挂载点，遮不住输入条 -->
  <Teleport v-else :to="bottomPanelEl || 'body'">
    <Transition name="emoji-dock">
      <div
        v-if="open"
        ref="dockEl"
        class="emoji-dock yaya-pop"
        role="dialog"
        :aria-label="t('yaya.emoji.title', '表情')"
      >
        <button
          type="button"
          class="emoji-dock-handle"
          :title="t('yaya.input.collapse', '收起')"
          :aria-label="t('yaya.input.collapse', '收起')"
          @click="open = false"
        >
          <span aria-hidden="true" />
        </button>
        <EmojiPanelCard :role="role" :active-keys="activeKeys" @pick="onPick" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 底部面板：输入条下方就地展开，圆角朝上、内容内部滚动 */
.emoji-dock {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: min(52vh, 460px);
  margin-top: 8px;
  border-radius: 20px 20px 0 0;
  padding-bottom: env(safe-area-inset-bottom);
  overflow: hidden;
}
.emoji-dock-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 26px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
}
.emoji-dock-handle span {
  width: 36px;
  height: 4px;
  border-radius: 2px;
  background: rgba(var(--v-theme-on-surface), 0.25);
}
/* 面板形态下内容体吃满高度、宫格区内部滚动（对话框 scrollable 分支不受影响） */
.emoji-dock :deep(.emoji-panel) {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 100%;
  box-shadow: none;
  background: transparent;
}
.emoji-dock :deep(.emoji-body) {
  min-height: 0;
  overflow-y: auto;
}
.emoji-dock-enter-active,
.emoji-dock-leave-active {
  transition:
    transform 0.16s ease,
    opacity 0.16s ease;
}
.emoji-dock-enter-from,
.emoji-dock-leave-to {
  transform: translateY(16px);
  opacity: 0;
}
</style>
