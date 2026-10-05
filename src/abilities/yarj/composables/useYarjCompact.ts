import { inject, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import type { InjectionKey, Ref } from 'vue'

/** 旅行记录页面宽度低于这个值时按手机排版（浮层铺满、按钮收成图标）。 */
export const YARJ_COMPACT_WIDTH = 600

const KEY: InjectionKey<Ref<boolean>> = Symbol('yarj-compact')

/**
 * 按页面容器（而不是视口）的宽度判断窄屏：网页模式的界面缩放是根元素 CSS zoom，
 * vw / 媒体查询都会算错，容器实际宽度才准。
 */
export function provideYarjCompact(el: Ref<HTMLElement | null>): Ref<boolean> {
  const compact = ref(false)
  let ro: ResizeObserver | null = null
  onMounted(() => {
    if (!el.value) return
    ro = new ResizeObserver(([entry]) => {
      // 页面被 keep-alive 隐藏时宽度为 0，保持上一次的判断
      const w = entry.contentRect.width
      if (w > 0) compact.value = w < YARJ_COMPACT_WIDTH
    })
    ro.observe(el.value)
  })
  onBeforeUnmount(() => ro?.disconnect())
  provide(KEY, compact)
  return compact
}

export function useYarjCompact(): Ref<boolean> {
  return inject(KEY, ref(false))
}
