import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shouldResumeFollow,
  FOLLOW_CENTER_TOLERANCE_PX,
  FOLLOW_IDLE_RESUME_MS
} from './lyrics-follow'

test('current line dragged back to the center resumes immediately', () => {
  assert.equal(shouldResumeFollow({ offsetPx: 0, idleMs: 150 }), true)
  assert.equal(shouldResumeFollow({ offsetPx: -12, idleMs: 150 }), true)
})

test('center tolerance boundary is inclusive', () => {
  const tol = FOLLOW_CENTER_TOLERANCE_PX
  assert.equal(shouldResumeFollow({ offsetPx: tol, idleMs: 150 }), true)
  assert.equal(shouldResumeFollow({ offsetPx: -tol, idleMs: 150 }), true)
  assert.equal(shouldResumeFollow({ offsetPx: tol + 1, idleMs: 150 }), false)
  assert.equal(shouldResumeFollow({ offsetPx: -(tol + 1), idleMs: 150 }), false)
})

test('far from center waits for the idle timeout', () => {
  assert.equal(shouldResumeFollow({ offsetPx: 400, idleMs: 3000 }), false)
  assert.equal(shouldResumeFollow({ offsetPx: 400, idleMs: FOLLOW_IDLE_RESUME_MS - 1 }), false)
  assert.equal(shouldResumeFollow({ offsetPx: 400, idleMs: FOLLOW_IDLE_RESUME_MS }), true)
})

test('no current line only resumes on idle', () => {
  assert.equal(shouldResumeFollow({ offsetPx: null, idleMs: 200 }), false)
  assert.equal(shouldResumeFollow({ offsetPx: null, idleMs: FOLLOW_IDLE_RESUME_MS }), true)
})

test('holding the lyrics never resumes, even centered or idle', () => {
  assert.equal(shouldResumeFollow({ offsetPx: 0, idleMs: 200, holding: true }), false)
  assert.equal(shouldResumeFollow({ offsetPx: 0, idleMs: 60_000, holding: true }), false)
})

test('custom tolerance and idle window', () => {
  assert.equal(shouldResumeFollow({ offsetPx: 50, idleMs: 0, tolerancePx: 64 }), true)
  assert.equal(shouldResumeFollow({ offsetPx: 500, idleMs: 2000, idleResumeMs: 2000 }), true)
})
