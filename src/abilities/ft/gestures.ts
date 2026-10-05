/**
 * Pointer gesture state machine for the FT view.
 *
 * The view used to keep ONE global `dragButton` + last-position pair, which
 * falls apart the moment a second finger lands (the second pointerdown
 * overwrote the baseline, so the first finger's next move teleported the
 * scene) and never cleaned up after `pointercancel` / `lostpointercapture`
 * (a cancelled gesture stayed "stuck" and kept panning forever).
 *
 * This module is the pure (DOM-free) decision layer: the view feeds it
 * pointer events and it emits camera intents (`pan` / `orbit` / `zoom`).
 * Everything here is synchronous and side-effect free apart from the `emit`
 * callback, so it is unit-testable without a browser.
 *
 * Gesture map (desktop behaviour is unchanged):
 *
 * | input                     | 2D                  | 3D                            |
 * | ------------------------- | ------------------- | ----------------------------- |
 * | left drag (mouse)         | pan                 | pan                           |
 * | right drag (mouse)        | — (ignored)         | orbit                         |
 * | wheel                     | zoomBy(factor)      | zoomBy(factor)                |
 * | one finger                | pan                 | pan (orbit with touchRotate)  |
 * | two fingers (drag)        | pan (centroid)      | orbit (centroid)              |
 * | two fingers (pinch)       | zoom (ratio)        | zoom (ratio)                  |
 *
 * A third pointer is tolerated: gestures freeze (no intent) until the extra
 * pointer is lifted, and every transition re-baselines so nothing jumps.
 */

export type FtGestureMode = '2d' | '3d'

/** Minimal pointer data the machine needs — keeps it testable without a DOM. */
export interface FtGesturePointerInput {
  pointerId: number
  x: number
  y: number
  /** `PointerEvent.button` on down, `PointerEvent.buttons` (bitmask) on move. */
  button: number
  /**
   * `PointerEvent.buttons` — when a move arrives with it explicitly 0 the
   * pointer no longer holds any button (the pointerup was swallowed: capture
   * stolen, pointer left the window, …), so the drag must be closed.
   */
  buttons?: number
  /** `PointerEvent.pointerType` — 'mouse' | 'pen' | 'touch'. */
  pointerType: string
}

export type FtGestureIntent =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'orbit'; dx: number; dy: number }
  | { kind: 'zoom'; factor: number }

/** Everything the machine needs from the view (queried per event). */
export interface FtGestureHost {
  emit(intent: FtGestureIntent): void
  mode(): FtGestureMode
  /** Explicit touch toggle: single-finger drag rotates instead of pans (3D). */
  touchRotate(): boolean
}

/** Only the first two pointers drive gestures; extras just freeze them. */
const MAX_POINTERS = 2

/** Per-event pinch ratio clamp — a jittery finger must not fling the camera. */
const MIN_PINCH_FACTOR = 0.2
const MAX_PINCH_FACTOR = 5

/** Mouse buttons that start a drag (left = pan, right = orbit). */
const MOUSE_PAN_BUTTON = 0
const MOUSE_ORBIT_BUTTON = 2

interface Slot {
  id: number
  x: number
  y: number
  button: number
  mouse: boolean
}

function isMouse(type: string): boolean {
  return type === 'mouse'
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}

export class FtGestures {
  private readonly host: FtGestureHost
  /** Active pointers, insertion ordered (first down = first entry). */
  private readonly pointers = new Map<number, Slot>()
  /** Centroid / pinch baseline — refreshed on every (de)activation. */
  private prevCentroid = { x: 0, y: 0 }
  private pinchDist = 0
  /** More than two pointers down: ignore moves until we are back to ≤ 2. */
  private frozen = false

  constructor(host: FtGestureHost) {
    this.host = host
  }

  /** Number of tracked pointers (0–n); exposed for the view/tests. */
  get pointerCount(): number {
    return this.pointers.size
  }

  /** True while a gesture is frozen by an extra (3rd+) pointer. */
  get isFrozen(): boolean {
    return this.frozen
  }

  /** Drop all state — used when the page is hidden / unmounted. */
  reset(): void {
    this.pointers.clear()
    this.pinchDist = 0
    this.prevCentroid = { x: 0, y: 0 }
    this.frozen = false
  }

  down(input: FtGesturePointerInput): void {
    if (isMouse(input.pointerType)) {
      // Middle / extra buttons never start a camera drag.
      if (input.button !== MOUSE_PAN_BUTTON && input.button !== MOUSE_ORBIT_BUTTON) return
    }
    // A pointer that went down again without an up (re-down) just rebases.
    this.pointers.set(input.pointerId, {
      id: input.pointerId,
      x: input.x,
      y: input.y,
      button: input.button,
      mouse: isMouse(input.pointerType)
    })
    this.frozen = this.pointers.size > MAX_POINTERS
    this.rebaseline()
  }

  move(input: FtGesturePointerInput): void {
    const slot = this.pointers.get(input.pointerId)
    if (!slot) return
    // A pointer whose buttons dropped to 0 ended without a pointerup
    // (capture stolen, pointer left the window, …) — close it cleanly.
    if (input.buttons === 0) {
      this.drop(input.pointerId)
      return
    }
    const dx = input.x - slot.x
    const dy = input.y - slot.y
    slot.x = input.x
    slot.y = input.y
    this.apply(slot, dx, dy)
  }

  /** pointerup / pointercancel. Unknown ids are a no-op (double events). */
  up(pointerId: number): void {
    this.drop(pointerId)
  }

  /** Capture was lost (element removed, another element took it): the gesture
   *  must stop instead of staying stuck on a stale baseline. */
  lostCapture(pointerId: number): void {
    this.drop(pointerId)
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private drop(pointerId: number): void {
    if (!this.pointers.delete(pointerId)) return
    this.frozen = this.pointers.size > MAX_POINTERS
    this.rebaseline()
  }

  /** Refresh the two-pointer baseline so the next gesture starts clean. */
  private rebaseline(): void {
    this.prevCentroid = this.centroid()
    this.pinchDist = this.pointers.size >= 2 ? this.distance() : 0
  }

  private centroid(): { x: number; y: number } {
    let x = 0
    let y = 0
    let n = 0
    for (const s of this.pointers.values()) {
      x += s.x
      y += s.y
      n++
    }
    if (n === 0) return { x: 0, y: 0 }
    return { x: x / n, y: y / n }
  }

  private distance(): number {
    const pts = [...this.pointers.values()]
    if (pts.length < 2) return 0
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
  }

  /** Turn one pointer's movement into intent(s). `slot` already moved. */
  private apply(slot: Slot, dx: number, dy: number): void {
    if (this.frozen) {
      // Extra pointer down: keep the baseline fresh but emit nothing, so
      // lifting the extra finger resumes without a jump.
      this.rebaseline()
      return
    }

    const slots = [...this.pointers.values()]
    const mouse = slots.find((s) => s.mouse)

    if (mouse) {
      // A mouse drag wins over any touch pointers; only its own moves count.
      if (mouse.id !== slot.id) return
      this.mouseIntent(mouse.button, dx, dy)
      return
    }

    if (slots.length === 1) {
      if (this.host.mode() === '3d' && this.host.touchRotate()) {
        this.host.emit({ kind: 'orbit', dx, dy })
      } else {
        this.host.emit({ kind: 'pan', dx, dy })
      }
      return
    }

    if (slots.length === 2) {
      const c = this.centroid()
      const cdx = c.x - this.prevCentroid.x
      const cdy = c.y - this.prevCentroid.y
      this.prevCentroid = c
      if (this.host.mode() === '3d') {
        this.host.emit({ kind: 'orbit', dx: cdx, dy: cdy })
      } else {
        this.host.emit({ kind: 'pan', dx: cdx, dy: cdy })
      }
      // Pinch: scene.zoomBy(factor) multiplies the view distance, so a factor
      // < 1 zooms IN. Fingers spreading apart must therefore zoom in.
      const d = this.distance()
      if (this.pinchDist > 0 && d > 0) {
        const factor = clamp(this.pinchDist / d, MIN_PINCH_FACTOR, MAX_PINCH_FACTOR)
        this.host.emit({ kind: 'zoom', factor })
      }
      this.pinchDist = d
    }
  }

  private mouseIntent(button: number, dx: number, dy: number): void {
    if (button === MOUSE_ORBIT_BUTTON) {
      // Orbit is 3D-only (scene.orbitBy is a no-op in 2D).
      if (this.host.mode() !== '3d') return
      this.host.emit({ kind: 'orbit', dx, dy })
      return
    }
    this.host.emit({ kind: 'pan', dx, dy })
  }
}
