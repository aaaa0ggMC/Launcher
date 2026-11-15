import { computed, onScopeDispose, ref, watch } from 'vue'
import type { ComputedRef, Ref } from 'vue'

/**
 * 截断揭示原语（SPEC「信息降级链」档 1）——kit 唯一一份。
 *
 * 背景（用户：「我怀疑整个 UI 库目前还没有为截断后如何展示信息考虑过」——他说得对）：
 * 截断原先被当成**样式问题**散在各组件里（各自写 ellipsis），于是「不折行」被做成了
 * 「看不见」：手机上点不到、桌面没 title。截断是**信息问题**：内容被降级了，
 * 就必须永远有办法看到原文。
 *
 * 三条腿（桌面 title / 触摸点按出全文 / 被 priority 收进「更多」浮层的显示全文）里，
 * 这个原语管前两条；判定用 `scrollWidth > clientWidth`（布局像素，页面缩放下口径一致），
 * **只有真截断时才挂 title 和点按**——没截断什么都不做，避免满屏 title。
 * 暴露的 `truncated` 是响应式的，布局自检靠它给「这页哪里有信息被降级」上标记。
 */
export interface Truncatable {
  /** 是否真的被截断（响应式，自检与样式都用它） */
  truncated: Ref<boolean>
  /** 桌面腿：原生 title（只在真截断时有值，否则 undefined） */
  title: ComputedRef<string | undefined>
  /** 触摸腿：点按 / 回车揭示全文 */
  tipOpen: Ref<boolean>
  toggleTip: () => void
  closeTip: () => void
}

export function useTruncatable(
  target: Ref<HTMLElement | null | undefined>,
  fullText: Ref<string> | ComputedRef<string> | string
): Truncatable {
  const truncated = ref(false)
  const tipOpen = ref(false)
  const text = typeof fullText === 'string' ? computed(() => fullText) : fullText

  /** 真截断判定：内容宽 > 盒子宽（都取布局像素，zoom 下口径一致） */
  function check(): void {
    const el = target.value
    if (!el) {
      truncated.value = false
      return
    }
    const cs = getComputedStyle(el)
    const ellipsis = cs.textOverflow === 'ellipsis'
    const nowrap = cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre'
    const cut = el.scrollWidth > el.clientWidth + 1
    truncated.value = ellipsis && nowrap && cut
    if (!truncated.value) tipOpen.value = false
  }

  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => check())
    watch(
      target,
      (el, _, onCleanup) => {
        if (el) ro?.observe(el)
        onCleanup(() => {
          if (el) ro?.unobserve(el)
        })
      },
      { immediate: true }
    )
  }
  watch(text, () => check())
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', check)
    onScopeDispose(() => window.removeEventListener('resize', check))
  }
  onScopeDispose(() => {
    ro?.disconnect()
    ro = null
  })

  const title = computed(() => (truncated.value ? text.value : undefined))

  function toggleTip(): void {
    if (!truncated.value) return
    tipOpen.value = !tipOpen.value
  }
  function closeTip(): void {
    tipOpen.value = false
  }

  return { truncated, title, tipOpen, toggleTip, closeTip }
}
