/**
 * 触屏点按补救：按钮已经显示按下（波纹 / 变色），手指抬起后却没有触发。
 *
 * 成因：手机 Chromium 在手指抬起时按手指的接触面积重新判定点到了谁（touch adjustment），
 * 判定结果可能与按下时的目标不同（按在边缘、旁边有别的可点元素时最常见）；两者不同，
 * click 就落在它们的公共祖先上，按下显示了反馈的那个按钮反而没收到。
 *
 * 这里只处理两种明确的情况，都以「手指按下的那个可点元素」为准：
 * - click 落在了它的**祖先**上 → 拦掉这次（祖先的处理不执行），改点它；
 * - 抬起后完全没有 click → 稍等片刻补点一次（之后迟到的 click 会被吞掉，不会触发两次）。
 * 手指移动超过阈值 / 被浏览器判为滚动（pointercancel）/ 长按 / 组件自己取消了点按（touchend
 * preventDefault）都不补。补发的 click 是合成事件（isTrusted=false），只认真实手势的地方（授权弹窗）不受影响。
 */

const CLICKABLE =
  'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], .v-list-item--link'
const MOVE_PX = 10
const MAX_TAP_MS = 500
/** 抬起后等 click 的时间 */
const WAIT_CLICK_MS = 120
/** 补点之后吞掉迟到 click 的窗口 */
const SWALLOW_MS = 400

interface Pending {
  el: HTMLElement
  pointerId: number
  x: number
  y: number
  t: number
  cancelled: boolean
  clicked: boolean
}

let pending: Pending | null = null
let rescued: { el: HTMLElement; until: number } | null = null

function disabled(el: HTMLElement): boolean {
  return (
    (el as HTMLButtonElement).disabled === true ||
    el.getAttribute('aria-disabled') === 'true' ||
    el.classList.contains('v-btn--disabled')
  )
}

function onPointerDown(e: PointerEvent): void {
  pending = null
  if (e.pointerType !== 'touch' || !e.isPrimary) return
  const target = e.target instanceof Element ? e.target : null
  const el = target?.closest<HTMLElement>(CLICKABLE)
  if (!el || disabled(el) || target?.closest('.v-slider__container')) return
  pending = {
    el,
    pointerId: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    t: Date.now(),
    cancelled: false,
    clicked: false
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!pending || e.pointerId !== pending.pointerId) return
  if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > MOVE_PX) pending.cancelled = true
}

function onPointerCancel(e: PointerEvent): void {
  if (pending && e.pointerId === pending.pointerId) pending = null
}

/** 窗口冒泡阶段（组件的处理都执行过了）：组件取消了点按就不补 */
function onTouchEndLate(e: TouchEvent): void {
  if (pending && e.defaultPrevented) pending.cancelled = true
}

function onPointerUp(e: PointerEvent): void {
  const p = pending
  if (!p || e.pointerId !== p.pointerId) return
  if (Date.now() - p.t > MAX_TAP_MS) p.cancelled = true
  setTimeout(() => {
    if (pending !== p) return
    pending = null
    if (p.cancelled || p.clicked || !p.el.isConnected || disabled(p.el)) return
    rescued = { el: p.el, until: Date.now() + SWALLOW_MS }
    p.el.click()
  }, WAIT_CLICK_MS)
}

function onClickCapture(e: MouseEvent): void {
  const target = e.target instanceof Node ? e.target : null
  if (!target) return
  // 补点之后迟到的真实 click：吞掉，避免触发两次
  if (rescued && e.isTrusted) {
    if (Date.now() > rescued.until) rescued = null
    else if (rescued.el.contains(target)) {
      e.stopImmediatePropagation()
      e.preventDefault()
      rescued = null
      return
    }
  }
  const p = pending
  if (!p || !e.isTrusted) return
  p.clicked = true
  if (p.cancelled || p.el.contains(target)) return
  // 落在了按下目标的祖先上：改点按下的那个
  if (target.contains(p.el) && p.el.isConnected && !disabled(p.el)) {
    e.stopImmediatePropagation()
    e.preventDefault()
    pending = null
    p.el.click()
  }
}

let installed = false

export function installTapRescue(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
  document.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  document.addEventListener('pointercancel', onPointerCancel, { capture: true, passive: true })
  document.addEventListener('pointerup', onPointerUp, { capture: true, passive: true })
  window.addEventListener('touchend', onTouchEndLate, { passive: true })
  document.addEventListener('click', onClickCapture, { capture: true })
}
