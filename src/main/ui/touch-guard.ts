/**
 * 触控防误触：滑块（Vuetify v-slider / v-range-slider）在触控输入下只接受「按住圆点拖动」。
 *
 * Vuetify 默认点轨道任意位置就把值跳过去；手机上划页面时手指擦过滑块、或者想点旁边的东西，
 * 值就被悄悄改了。这里在 document 捕获阶段拦掉「触控 + 不在圆点上」的按下事件，
 * Vuetify 收不到就不会跳值；页面照常滚动（不 preventDefault touchstart）。
 *
 * 按「每次输入」判断而不是按设备判断：触屏笔记本用鼠标点轨道仍然照旧跳值，
 * 只有手指触摸时才收紧。触控产生的兼容 mousedown（点按后浏览器补发）同样拦掉。
 */

const SLIDER = '.v-slider__container'
const THUMB = '.v-slider-thumb'
/** 触摸后浏览器补发兼容鼠标事件的时间窗口 */
const COMPAT_MOUSE_MS = 800

let lastTouchAt = 0

function onTrackWithoutThumb(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null
  if (!el) return false
  const slider = el.closest(SLIDER)
  if (!slider) return false
  // 只读 / 禁用的滑块 Vuetify 自己不响应，不用管
  return !el.closest(THUMB)
}

function onTouchStart(e: TouchEvent): void {
  lastTouchAt = Date.now()
  if (onTrackWithoutThumb(e.target)) e.stopPropagation()
}

/** 触控补发的 mousedown：Chromium 有 sourceCapabilities.firesTouchEvents，其它浏览器靠时间窗口 */
function isTouchCompatMouse(e: MouseEvent): boolean {
  const caps = (e as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } })
    .sourceCapabilities
  if (caps?.firesTouchEvents) return true
  return Date.now() - lastTouchAt < COMPAT_MOUSE_MS
}

function onMouseDown(e: MouseEvent): void {
  if (!isTouchCompatMouse(e)) return
  if (onTrackWithoutThumb(e.target)) {
    e.stopPropagation()
    e.preventDefault()
  }
}

let installed = false

export function installTouchGuard(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
  document.addEventListener('mousedown', onMouseDown, { capture: true })
}
