import type { Directive } from 'vue'

/**
 * Touch-friendly 「长按」gesture — a substitute for hover / right-click entries
 * that don't exist on a phone.
 *
 *   <div v-long-press="onLongPress">…</div>
 *
 * Behaviour:
 *  - only reacts to `pointerType === 'touch'` — mouse / pen keep their existing
 *    (right-click) behaviour, nothing changes on the desktop;
 *  - fires after 500ms with the touch point (`clientX` / `clientY`);
 *  - aborted when the finger moves more than 8px, is lifted, or the gesture is
 *    cancelled (`pointercancel`);
 *  - after firing, the follow-up `click` and the browser's own long-press
 *    callout (`contextmenu`) are swallowed so the custom menu stays usable, and
 *    the element gets `-webkit-touch-callout: none`.
 */

/** Where the finger went down — same shape as `MouseEvent.clientX/clientY`. */
export interface LongPressPoint {
  clientX: number
  clientY: number
}

export type LongPressHandler = (point: LongPressPoint, e: PointerEvent) => unknown

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 8
/** How long to keep swallowing events after a fired gesture. */
const SUPPRESS_MS = 600

interface PressState {
  timer: number
  startX: number
  startY: number
  pointerId: number
}

/** Elements the gesture must ignore (controls living inside the surface). */
function inSkippable(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null
  if (!el) return false
  return Boolean(el.closest('button, a, input, [data-lp-skip]'))
}

/** Registry keeps per-element state out of the DOM (handler re-read live). */
const states = new WeakMap<
  HTMLElement,
  {
    handler: LongPressHandler
    press: PressState
    cleanup: () => void
  }
>()

function stopGesture(el: HTMLElement): void {
  const s = states.get(el)
  if (!s) return
  clearTimeout(s.press.timer)
  s.press.timer = 0
  s.press.pointerId = -1
}

function cancelGesture(el: HTMLElement, e: PointerEvent): void {
  const s = states.get(el)
  if (!s || s.press.pointerId !== e.pointerId) return
  stopGesture(el)
}

function onPointerDown(el: HTMLElement, e: PointerEvent): void {
  if (e.pointerType !== 'touch') return
  if (inSkippable(e.target)) return
  const s = states.get(el)
  if (!s) return
  stopGesture(el)
  s.press.pointerId = e.pointerId
  s.press.startX = e.clientX
  s.press.startY = e.clientY
  s.press.timer = setTimeout(() => {
    const st = states.get(el)
    if (!st || st.press.pointerId !== e.pointerId) return
    st.press.timer = 0
    swallowAfterFire(el)
    st.handler({ clientX: st.press.startX, clientY: st.press.startY }, e)
  }, LONG_PRESS_MS) as unknown as number
}

function onPointerMove(el: HTMLElement, e: PointerEvent): void {
  const s = states.get(el)
  if (!s || s.press.pointerId !== e.pointerId) return
  const moved =
    Math.abs(e.clientX - s.press.startX) > MOVE_TOLERANCE ||
    Math.abs(e.clientY - s.press.startY) > MOVE_TOLERANCE
  if (moved) stopGesture(el)
}

/** Swallow the click / contextmenu the browser emits after a fired press. */
function swallowAfterFire(el: HTMLElement): void {
  const swallow = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  const options = { capture: true, once: true } as const
  const clear = (): void => {
    el.removeEventListener('click', swallow, options)
    el.removeEventListener('contextmenu', swallow, options)
  }
  el.addEventListener('click', swallow, options)
  el.addEventListener('contextmenu', swallow, options)
  // Fallback: never leak listeners when no such event arrives.
  setTimeout(clear, SUPPRESS_MS)
}

function attach(el: HTMLElement, bindingValue: LongPressHandler | undefined): void {
  const prev = states.get(el)
  prev?.cleanup()

  const state = {
    handler: bindingValue ?? ((): void => {}),
    press: { timer: 0, startX: 0, startY: 0, pointerId: -1 },
    cleanup: (): void => {}
  }
  states.set(el, state)

  const down = (e: PointerEvent): void => onPointerDown(el, e)
  const move = (e: PointerEvent): void => onPointerMove(el, e)
  const up = (e: PointerEvent): void => cancelGesture(el, e)
  const cancel = (e: PointerEvent): void => cancelGesture(el, e)

  el.addEventListener('pointerdown', down)
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', cancel)

  // The native long-press callout / text selection would compete with the
  // gesture (and the menu it opens) — disable them on the element we own.
  // Touch-primary devices ONLY: on the desktop this would silently stop mouse users
  // from selecting / copying text inside the element.
  if (window.matchMedia?.('(pointer: coarse)').matches) {
    const style = el.style as unknown as Record<string, string>
    style.webkitTouchCallout = 'none'
    style.webkitUserSelect = 'none'
    style.userSelect = 'none'
  }

  state.cleanup = (): void => {
    clearTimeout(state.press.timer)
    el.removeEventListener('pointerdown', down)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', cancel)
    states.delete(el)
  }
}

/**
 * `v-long-press="handler"` — touch-only long press. The handler receives the
 * touch point; the raw pointer event follows for callers that need it.
 */
export const vLongPress: Directive<HTMLElement, LongPressHandler | undefined> = {
  mounted(el, binding) {
    attach(el, binding.value)
  },
  updated(el, binding) {
    const s = states.get(el)
    if (!s) attach(el, binding.value)
    else if (binding.value) s.handler = binding.value
  },
  unmounted(el) {
    states.get(el)?.cleanup()
  }
}
