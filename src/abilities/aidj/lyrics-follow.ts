/**
 * Lyrics page scroll-follow: when does a manual scroll hand control back to
 * auto-follow? Pure so it can be unit-tested (`lyrics-follow.test.ts`).
 *
 * - The user dragged the current line back near the vertical center → resume
 *   right after the gesture settles.
 * - Otherwise resume after `idleResumeMs` without any gesture.
 */

/** How close (px) the current line's center must be to the viewport center. */
export const FOLLOW_CENTER_TOLERANCE_PX = 32
/** No gesture for this long → resume following and recenter. */
export const FOLLOW_IDLE_RESUME_MS = 10_000
/** A gesture (incl. momentum scroll) counts as settled after this quiet gap. */
export const FOLLOW_SETTLE_MS = 150

export interface ResumeInput {
  /** Current line center minus viewport center, px; null = no current line. */
  offsetPx: number | null
  /** Time since the last user gesture / scroll movement, ms. */
  idleMs: number
  /** A finger / mouse button is still held on the lyrics. */
  holding?: boolean
  tolerancePx?: number
  idleResumeMs?: number
}

export function shouldResumeFollow(input: ResumeInput): boolean {
  if (input.holding) return false
  const idleResume = input.idleResumeMs ?? FOLLOW_IDLE_RESUME_MS
  if (input.idleMs >= idleResume) return true
  const tol = input.tolerancePx ?? FOLLOW_CENTER_TOLERANCE_PX
  return input.offsetPx !== null && Math.abs(input.offsetPx) <= tol
}
