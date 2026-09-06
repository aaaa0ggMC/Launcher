import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatLocalTime } from './song-timeline'

describe('AIDJ song-timeline', () => {
  it('formatLocalTime formats date into YYYYMMDDHHmmss string with 0-padding', () => {
    // Month is 0-indexed in Date: month 8 = September
    const date = new Date(2026, 8, 2, 7, 5, 9)
    const formatted = formatLocalTime(date)
    assert.equal(formatted, '20260902070509')
  })

  it('formatLocalTime handles 2-digit numbers correctly', () => {
    const date = new Date(2025, 11, 25, 23, 59, 58)
    const formatted = formatLocalTime(date)
    assert.equal(formatted, '20251225235958')
  })

  it('formats current date if no argument provided', () => {
    const nowStr = formatLocalTime()
    assert.equal(nowStr.length, 14)
    assert.match(nowStr, /^\d{14}$/)
  })
})
