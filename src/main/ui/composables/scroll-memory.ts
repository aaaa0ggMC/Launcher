/**
 * 「同一个滚动容器里切换子视图」时，按子视图分别记住滚动位置。
 *
 * 设置页这类主从界面里，列表 / 详情共用外层的同一个滚动容器：不处理的话，从列表中部点进详情，
 * 详情也停在中部；返回时列表又停在详情的滚动位置，错位。用法：
 *
 *   const rootEl = ref<HTMLElement | null>(null)
 *   useScrollMemory(rootEl, () => `${tab.value}|${selectedId.value ?? ''}`, 'yaya-plugins')
 *
 * key 变化前记下旧视图的 scrollTop，新视图渲染后恢复它上次的位置（没来过 = 顶部）。
 * 滚动容器 = anchor 往上最近的可滚动祖先，切换时现找（组件可能被挂在设置页或浮窗里）。
 * 记忆只在内存里（本次启动），不落盘。
 */
import { nextTick, onBeforeUnmount, watch } from 'vue'
import type { Ref } from 'vue'

const memory = new Map<string, number>()

/** anchor 往上最近的纵向可滚动祖先（overflow-y auto / scroll），没有就是文档滚动元素 */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null
  while (node) {
    const oy = getComputedStyle(node).overflowY
    if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement | null) ?? null
}

/** 恢复要等内容渲染出来（过渡 out-in、异步加载列表），最多重试这么久 */
const RESTORE_WINDOW_MS = 900

export function useScrollMemory(
  anchor: Ref<HTMLElement | null>,
  key: () => string,
  scope: string
): void {
  let frame = 0
  let stopUserWatch: (() => void) | null = null

  function cancelRestore(): void {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    stopUserWatch?.()
    stopUserWatch = null
  }

  function restore(target: number): void {
    cancelRestore()
    const scroller = scrollParent(anchor.value)
    if (!scroller) return
    // 用户自己动了滚轮 / 手指就不再强行定位
    const onUser = (): void => cancelRestore()
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
    for (const e of events) scroller.addEventListener(e, onUser, { passive: true })
    stopUserWatch = () => {
      for (const e of events) scroller.removeEventListener(e, onUser)
    }
    const started = performance.now()
    const step = (): void => {
      // 过渡期间旧内容还在、新内容高度还在变，整个窗口内都按目标位置钉住
      if (Math.abs(scroller.scrollTop - target) > 1) scroller.scrollTop = target
      if (performance.now() - started > RESTORE_WINDOW_MS) return cancelRestore()
      frame = requestAnimationFrame(step)
    }
    step()
  }

  watch(
    key,
    (next, prev) => {
      const scroller = scrollParent(anchor.value)
      if (scroller && prev !== undefined) memory.set(`${scope}:${prev}`, scroller.scrollTop)
      void nextTick(() => restore(memory.get(`${scope}:${next}`) ?? 0))
    },
    // pre：在 DOM 换成新视图之前记下旧视图的位置
    { flush: 'pre' }
  )

  onBeforeUnmount(cancelRestore)
}
