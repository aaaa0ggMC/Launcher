<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, type Ref } from 'vue'
import { translate } from '../../../main/ui/i18n'
import type { ChatCommandDef } from './chat-commands'

defineProps<{
  commands: ChatCommandDef[]
  active: number
  bottom: number
}>()

const emit = defineEmits<{
  (e: 'select', index: number): void
  (e: 'apply', index: number): void
}>()

const uiLang = inject('cockpit:lang', ref('zh')) as Ref<string>
const t = (key: string, fallback?: string): string => translate(uiLang.value, key, fallback)

/**
 * 指针手势：触摸/笔按下后只有"抬起且没滑动"才算一次明确选择，
 * 一旦发生拖动（滚动列表）就取消，绝不误选。
 * 鼠标保持自然单击选择，但同样在 pointerup 阶段才 apply，不再在按下瞬间触发。
 */
interface PopupGesture {
  pointerId: number
  index: number
  startX: number
  startY: number
  element: HTMLElement
}

/** 手指/笔按下期间允许的抖动距离，超过即视为拖动（滚动列表） */
const TAP_SLOP_PX = 10

const gesture = ref<PopupGesture | null>(null)
/** 当前被按住的候选行（拖动开始即取消），只作视觉反馈，不改写 active */
const pressedIndex = computed(() => {
  const g = gesture.value
  return g ? g.index : -1
})

function releaseGesture(): void {
  gesture.value = null
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  window.removeEventListener('blur', onPointerCancel)
  document.removeEventListener('mouseleave', onPointerCancel)
}

function onPointerDown(e: PointerEvent, index: number): void {
  if (e.pointerType === 'mouse' && e.button !== 0) return
  if (!e.isPrimary) return
  // 同一时刻只跟踪一个指针（多指触摸时忽略后续手指）
  if (gesture.value && gesture.value.pointerId !== e.pointerId) return
  releaseGesture()
  // 鼠标按下时保留输入框焦点；触摸/笔不能 preventDefault，否则部分 WebView
  // 会连 `touch-action: pan-y` 允许的原生滚动也一起取消。
  if (e.pointerType === 'mouse') e.preventDefault()
  gesture.value = {
    pointerId: e.pointerId,
    index,
    startX: e.clientX,
    startY: e.clientY,
    element: e.currentTarget as HTMLElement
  }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  window.addEventListener('blur', onPointerCancel)
  document.addEventListener('mouseleave', onPointerCancel)
}

function onPointerMove(e: PointerEvent): void {
  const g = gesture.value
  if (!g || e.pointerId !== g.pointerId) return
  const dx = e.clientX - g.startX
  const dy = e.clientY - g.startY
  // 超过阈值即判定为滚动/拖动：放弃这次选择，指针流交给浏览器滚动
  if (dx * dx + dy * dy > TAP_SLOP_PX * TAP_SLOP_PX) releaseGesture()
}

function onPointerUp(e: PointerEvent): void {
  const g = gesture.value
  releaseGesture()
  if (!g || e.pointerId !== g.pointerId) return
  const releasedOn = document.elementFromPoint(e.clientX, e.clientY)
  if (!releasedOn || (releasedOn !== g.element && !g.element.contains(releasedOn))) return
  emit('apply', g.index)
}

function onPointerCancel(): void {
  releaseGesture()
}

/** 桌面鼠标悬停即高亮；触摸滑动途中的 pointerenter 一律忽略 */
function onPointerEnter(e: PointerEvent, index: number): void {
  if (e.pointerType !== 'mouse') return
  if (gesture.value) return
  emit('select', index)
}

// 弹窗在按压中途被卸载（如键盘收起）时，清掉挂在不属于它的 window 监听
onBeforeUnmount(releaseGesture)
</script>

<template>
  <Transition name="cmd-pop">
    <div v-if="commands.length > 0" class="cmd-popup" :style="{ bottom: `${bottom}px` }">
      <div
        v-for="(c, i) in commands"
        :key="c.name"
        class="cmd-item"
        :class="{ 'is-active': i === active, 'is-pressed': i === pressedIndex }"
        @pointerdown="onPointerDown($event, i)"
        @pointerenter="onPointerEnter($event, i)"
      >
        <span class="cmd-name"
          >/{{ c.name }} <span class="cmd-args">{{ c.args }}</span></span
        >
        <span class="cmd-desc">{{ t(c.descKey, c.descFallback) }}</span>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.cmd-popup {
  position: absolute;
  left: 16px;
  right: 16px;
  z-index: 30;
  max-height: 168px;
  overflow-y: auto;
  /* 允许浏览器接管纵向滚动手势，并阻止滚动链传递到页面外壳 */
  touch-action: pan-y;
  overscroll-behavior: contain;
  border-radius: 10px;
  background: rgba(var(--v-theme-surface), var(--glass-a, 0.2));
  backdrop-filter: blur(18px) saturate(1.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(var(--v-theme-surface-bright), 0.28);
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.25);
  padding: 4px;
}
.cmd-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.82rem;
}
.cmd-item.is-active {
  background: rgba(var(--v-theme-primary), 0.15);
}
/* 只有按住的反馈：拖动开始即消失，不等于选中 */
.cmd-item.is-pressed {
  background: rgba(var(--v-theme-primary), 0.1);
}
.cmd-name {
  font-family: monospace;
  font-weight: 600;
  color: rgb(var(--v-theme-primary));
  white-space: nowrap;
}
.cmd-args {
  color: rgb(var(--v-theme-on-surface-variant));
  font-weight: 400;
}
.cmd-desc {
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 触摸/笔：候选行保持 44px 命中高度，并关掉长按选中与点击高亮 */
@media (hover: none), (pointer: coarse), (max-width: 720px) {
  .cmd-item {
    min-height: 44px;
    padding: 10px 12px;
    user-select: none;
    -webkit-user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
}
.cmd-pop-enter-active,
.cmd-pop-leave-active {
  transition:
    opacity 0.14s ease,
    transform 0.14s ease;
}
.cmd-pop-enter-from,
.cmd-pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>
