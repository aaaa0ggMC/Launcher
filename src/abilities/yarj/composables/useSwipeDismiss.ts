import { computed, ref } from 'vue'
import type { ComputedRef, Ref, StyleValue } from 'vue'
import { DrawerSwipe } from '@ui/composables/drawer-swipe'

/**
 * 右侧浮动抽屉的「向右滑动收起」（与主侧栏同一套手势判定，只是方向镜像）：
 * 单指、横向为主才接管，竖向滑动照常滚动列表；滑过 1/4 宽度或快速甩动即关闭。
 */
export interface SwipeDismiss {
  style: ComputedRef<StyleValue | undefined>
  handlers: Record<string, (e: PointerEvent) => void>
  onClickCapture: (e: MouseEvent) => void
  reset: () => void
}

export function useSwipeDismiss(enabled: Ref<boolean>, onClose: () => void): SwipeDismiss {
  const swipe = new DrawerSwipe()
  const dragX = ref(0)
  const dragging = ref(false)
  let scale = 1
  let blockClick = false

  function reset(): void {
    swipe.reset()
    dragX.value = 0
    dragging.value = false
  }

  function onPointerDown(e: PointerEvent): void {
    if (!enabled.value || e.button !== 0 || e.pointerType === 'mouse') return
    if ((e.target as Element).closest('input, textarea, [contenteditable="true"]')) return
    blockClick = false
    const el = e.currentTarget as HTMLElement
    const width = el.getBoundingClientRect().width
    // 网页模式的界面缩放是根元素 CSS zoom：指针坐标是缩放后的像素，transform 用的是缩放前的
    scale = width > 0 ? el.offsetWidth / width : 1
    swipe.down(e.pointerId, -e.clientX, e.clientY, width, e.timeStamp)
    dragging.value = false
    dragX.value = 0
  }

  function onPointerMove(e: PointerEvent): void {
    const state = swipe.move(e.pointerId, -e.clientX, e.clientY)
    if (!state) return
    dragging.value = state.dragging
    dragX.value = -state.offset * scale
    if (state.dragging) {
      blockClick = true
      e.preventDefault()
      const el = e.currentTarget as HTMLElement
      if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId)
    }
  }

  function onPointerEnd(e: PointerEvent): void {
    if (e.type === 'lostpointercapture' && e.target !== e.currentTarget) return
    const result = swipe.end(e.pointerId, e.timeStamp, e.type !== 'pointerup')
    dragging.value = false
    dragX.value = 0
    if (result.close) onClose()
  }

  /** 拖动结束时抬手会触发一次 click，别让它点到卡片上的按钮。 */
  function onClickCapture(e: MouseEvent): void {
    if (!blockClick || e.detail === 0) return
    blockClick = false
    e.preventDefault()
    e.stopImmediatePropagation()
  }

  const style = computed<StyleValue | undefined>(() =>
    dragging.value ? { transform: `translateX(${dragX.value}px)`, transition: 'none' } : undefined
  )

  /** 给 `v-on="handlers"` 用（对象语法的键是事件名，不带 on 前缀）。 */
  const handlers = {
    pointerdown: onPointerDown,
    pointermove: onPointerMove,
    pointerup: onPointerEnd,
    pointercancel: onPointerEnd,
    lostpointercapture: onPointerEnd
  }

  return { style, handlers, onClickCapture, reset }
}
