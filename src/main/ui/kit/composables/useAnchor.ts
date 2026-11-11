import { onScopeDispose, watch } from 'vue'
import type { Ref } from 'vue'

/**
 * 锚定定位原语（kit 唯一一份）。
 *
 * 为什么需要它：仓里的浮层要么用 Vuetify VMenu（定位/翻转/贴边白拿，但内容懒渲染，
 * 「隐藏控件 teleport 进来」的用法会在菜单关闭时整个卸载），要么手写
 * `getBoundingClientRect()` + clamp——而手写的那份在**页面缩放**下必错：
 * `zoom`（设置 → 外观 → 界面缩放，默认 1.1）下 `getBoundingClientRect()` 返回
 * **视觉像素**（100px 的元素量到 110），`offsetWidth` 返回**布局像素**（100），
 * `window.innerWidth` 又是第三种口径。三者混用 → 浮层偏 10%、贴不到触发点、
 * 甚至被视口右缘切掉（KitSmartRow 的「更多」浮层实测复现过）。
 *
 * 所以这里统一：全部测量走 `getBoundingClientRect()`，再除以 zoom 换算成布局像素，
 * 视口用 `window.innerWidth/Height`（布局像素），最后用同一个纯函数算位置。
 */

export type AnchorPlacement = 'bottom-end' | 'bottom-start' | 'top-end' | 'top-start'

export interface AnchorGeometry {
  /** 视口（布局 px） */
  viewport: { width: number; height: number }
  /** 触发块（布局 px） */
  trigger: { left: number; right: number; top: number; bottom: number }
  /** 浮层尺寸（布局 px） */
  floating: { width: number; height: number }
  /** 首选方位 */
  placement: AnchorPlacement
  /** 与视口边缘的最小间距 */
  margin: number
}

export interface AnchorPosition {
  left: number
  top: number
  /** 实际采用的方位（首选放不下时翻转） */
  placement: AnchorPlacement
}

/**
 * 纯函数：算浮层位置。策略＝首选方位 → 竖向翻转 → 横向贴边 clamp。
 * 两个方向都放不下时选空间更大的那一侧，再把横向夹回视口内
 * （宁可贴边也不出屏——出屏就是「被右缘切掉」）。
 */
export function anchorPosition(g: AnchorGeometry): AnchorPosition {
  const { viewport, trigger, floating, margin } = g
  const maxLeft = Math.max(margin, viewport.width - floating.width - margin)
  const minLeft = Math.min(margin, maxLeft)

  // 横向：end = 右缘对齐触发块右缘；start = 左缘对齐触发块左缘；再夹回视口
  const alignEnd = g.placement.endsWith('end')
  const wantLeft = alignEnd ? trigger.right - floating.width : trigger.left
  const left = Math.max(minLeft, Math.min(wantLeft, maxLeft))
  const flip = (p: AnchorPlacement): AnchorPlacement =>
    p.startsWith('top')
      ? (`bottom${alignEnd ? '-end' : '-start'}` as AnchorPlacement)
      : (`top${alignEnd ? '-end' : '-start'}` as AnchorPlacement)

  // 竖向：首选下方；下方放不下且上方放得下就翻上去；都放不下选空间大的
  const below = trigger.bottom + 4
  const above = trigger.top - floating.height - 4
  const fitsBelow = below + floating.height <= viewport.height - margin
  const fitsAbove = above >= margin
  const preferTop = g.placement.startsWith('top')
  let placement = g.placement
  let top: number
  if (preferTop ? fitsAbove : fitsBelow) {
    top = preferTop ? above : below
  } else if (preferTop ? fitsBelow : fitsAbove) {
    placement = flip(g.placement)
    top = preferTop ? below : above
  } else {
    // 都放不下：空间更大的一侧 + 夹回视口
    const roomBelow = viewport.height - margin - trigger.bottom
    const roomAbove = trigger.top - margin
    const useTop = roomAbove > roomBelow
    placement = useTop ? flip(g.placement) : g.placement
    top = useTop
      ? Math.max(margin, above)
      : Math.min(below, viewport.height - floating.height - margin)
  }
  return { left, top, placement }
}

/** 根元素 CSS zoom（设置 → 外观 → 界面缩放）。视觉像素 ÷ zoom = 布局像素 */
export function rootZoom(): number {
  if (typeof document === 'undefined') return 1
  const z = Number.parseFloat(getComputedStyle(document.documentElement).zoom || '1')
  return Number.isFinite(z) && z > 0 ? z : 1
}

/** 把视觉像素的 rect 换算成布局像素（÷ zoom） */
function toLayout(rect: DOMRect, zoom: number): AnchorGeometry['trigger'] {
  return {
    left: rect.left / zoom,
    right: rect.right / zoom,
    top: rect.top / zoom,
    bottom: rect.bottom / zoom
  }
}

export interface UseAnchorOptions {
  placement?: AnchorPlacement
  margin?: number
  /** 是否启用（浮层打开时才定位） */
  active?: Ref<boolean>
}

/**
 * 把浮层锚到触发块上。返回 `place()`（打开时调一次）与内部订阅的 scroll/resize 重算。
 * 传入的都是模板 ref（元素或组件实例都行，内部取 $el）。
 */
export function useAnchor(
  trigger: Ref<HTMLElement | null | { $el?: HTMLElement }>,
  floating: Ref<HTMLElement | null | { $el?: HTMLElement }>,
  opts: UseAnchorOptions = {}
): { place: () => void } {
  const placement = opts.placement ?? 'bottom-end'
  const margin = opts.margin ?? 8

  const el = (r: Ref<HTMLElement | null | { $el?: HTMLElement }>): HTMLElement | null => {
    const v = r.value
    if (!v) return null
    return v instanceof HTMLElement ? v : (v.$el ?? null)
  }

  function place(): void {
    const t = el(trigger)
    const f = el(floating)
    if (!t || !f) return
    const zoom = rootZoom()
    const trig = toLayout(t.getBoundingClientRect(), zoom)
    const frect = f.getBoundingClientRect()
    const pos = anchorPosition({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      trigger: trig,
      floating: { width: frect.width / zoom, height: frect.height / zoom },
      placement,
      margin
    })
    f.style.left = `${pos.left}px`
    f.style.top = `${pos.top}px`
  }

  let bound = false
  function onViewport(): void {
    if (opts.active && !opts.active.value) return
    place()
  }

  function bind(on: boolean): void {
    if (on === bound) return
    bound = on
    if (typeof window === 'undefined') return
    if (on) {
      window.addEventListener('resize', onViewport)
      window.addEventListener('scroll', onViewport, true)
    } else {
      window.removeEventListener('resize', onViewport)
      window.removeEventListener('scroll', onViewport, true)
    }
  }

  if (opts.active) watch(opts.active, (on) => bind(on), { immediate: true })
  onScopeDispose(() => bind(false))

  return { place }
}
