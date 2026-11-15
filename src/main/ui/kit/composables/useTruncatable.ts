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

/** 一次截断判定需要的测量值（纯数据，方便单测） */
export interface TruncateProbe {
  /** 自身内容宽 / 盒子宽（布局像素） */
  scrollWidth: number
  clientWidth: number
  /** 自身右缘（视觉像素，getBoundingClientRect().right） */
  right: number
  /** 祖先链上第一个会裁的盒子的**内容右缘**（视觉像素）；没有则 null */
  clipRight: number | null
}

/**
 * 纯函数：这个元素是不是「被截断」了。两条路取或——
 *   ① 自己这个盒子在裁：scrollWidth > clientWidth（KitRowItem truncate /
 *      KitSettingRow label 走的就是这条，一直正常工作）；
 *   ② **被祖先裁**：自己盒子和内容一样宽（sw==cw），但右缘超出了祖先链上第一个
 *      overflow 非 visible 的盒子的内容右缘。用户 live 数据里的胶囊正是这种：
 *      sw==cw==58 却被切短，之前只认①所以永远判 false、没 title、点按没反应。
 * 两条都量视觉像素（缩放下同口径相乘，比较不受影响）；①用布局像素（自身两个值同口径）。
 */
export function isTruncatedProbe(p: TruncateProbe): boolean {
  const self = p.clientWidth > 0 && p.scrollWidth > p.clientWidth + 1
  const byAncestor = p.clipRight !== null && p.right > p.clipRight + 1
  return self || byAncestor
}

/** 沿祖先链找第一个会裁的盒子，返回它的**内容右缘**（视觉像素）；没有则 null */
export function clipRightOf(el: HTMLElement): number | null {
  let p = el.parentElement
  while (p && p !== document.body && p !== document.documentElement) {
    const cs = getComputedStyle(p)
    const ox = cs.overflowX
    const oy = cs.overflowY
    const clips = ox !== 'visible' || oy !== 'visible'
    if (clips) {
      const r = p.getBoundingClientRect()
      const pad = Number.parseFloat(cs.paddingRight || '0') || 0
      const border = Number.parseFloat(cs.borderRightWidth || '0') || 0
      return r.right - pad - border
    }
    p = p.parentElement
  }
  return null
}

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

  /**
   * 真截断判定（SPEC「信息降级链」档 1）：**自己盒子在裁，或被祖先裁，都算**。
   * 用户 live 数据里胶囊 sw==cw 却被切短——只认前者就永远判 false（没 title、
   * 点按没反应）。ellipsis + nowrap 是前提（没有这俩样式，文字会换行而不是被裁）。
   */
  function check(): void {
    const el = target.value
    if (!el) {
      truncated.value = false
      return
    }
    const cs = getComputedStyle(el)
    const ellipsis = cs.textOverflow === 'ellipsis'
    const nowrap = cs.whiteSpace === 'nowrap' || cs.whiteSpace === 'pre'
    const probe: TruncateProbe = {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      right: el.getBoundingClientRect().right,
      clipRight: clipRightOf(el)
    }
    truncated.value = ellipsis && nowrap && isTruncatedProbe(probe)
    if (!truncated.value) tipOpen.value = false
  }

  // 三重触发，缺一不可（都踩过）：
  //   ① ResizeObserver 观察**元素本身**：盒子宽度变化（容器变窄 / 行重排）；
  //   ② ResizeObserver 观察**父元素**：盒子由父级决定时，父级先变；
  //   ③ MutationObserver 观察 style / class：字号是异步算的（KitCircleStat 的 fit
  //      缩放）——那时**盒子宽度没变、只有文字宽度变**，RO 一个都不触发，
  //      检测就停在旧结论上（实测 kit-circle__label 截断了却没 title，就是这个坑）。
  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => check())
    watch(
      target,
      (el, _, onCleanup) => {
        if (!el) return
        ro?.observe(el)
        if (el.parentElement) ro?.observe(el.parentElement)
        onCleanup(() => {
          ro?.unobserve(el)
          if (el.parentElement) ro?.unobserve(el.parentElement)
        })
      },
      { immediate: true }
    )
  }
  // ③ 异步兜底重判：字号常是异步算出来的（KitCircleStat 的 fit 缩放、翻译后置），
  //    那时**盒子宽度没变、只有文字宽度变**——RO 不触发，而 Vue 的样式更新走
  //    style 属性赋值也不产生 MutationObserver 的 attribute mutation（实测无效）。
  //    所以挂载后补几拍定时重判，不停地轮询（1s 后自停）。
  if (typeof requestAnimationFrame !== 'undefined') {
    const later = [250, 1000]
    requestAnimationFrame(() => {
      check()
      requestAnimationFrame(() => check())
      for (const ms of later) setTimeout(check, ms)
    })
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

  const unregister = registerTruncateRecheck(check)
  onScopeDispose(unregister)

  return { truncated, title, tipOpen, toggleTip, closeTip }
}

/** 需要重判的实例登记（供 KitSmartRow 打开「更多」浮层时统一通知） */
const rechecks = new Set<() => void>()
/** 登记 / 反登记 */
export function registerTruncateRecheck(fn: () => void): () => void {
  rechecks.add(fn)
  return () => rechecks.delete(fn)
}
/** 让所有已挂载的截断判定重跑一遍（浮层从 display:none 变可见时用） */
export function recheckAllTruncatables(): void {
  for (const fn of rechecks) fn()
}
