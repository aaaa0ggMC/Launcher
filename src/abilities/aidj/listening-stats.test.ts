import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hourStartOf, clampMinutes, queryTimeRange, loadTimeStats } from './listening-stats'

describe('AIDJ listening-stats', () => {
  it('hourStartOf floors timestamp to exact hour boundary', () => {
    const t0 = 1700000000000
    const oneHour = 3600000
    const expected = Math.floor(t0 / oneHour) * oneHour
    assert.equal(hourStartOf(t0), expected)
    assert.equal(hourStartOf(expected + 1), expected)
    assert.equal(hourStartOf(expected + 3599999), expected)
    assert.equal(hourStartOf(expected + 3600000), expected + oneHour)
  })

  it('clampMinutes clamps and rounds minutes to [0, 60]', () => {
    assert.equal(clampMinutes(-10), 0)
    assert.equal(clampMinutes(0), 0)
    assert.equal(clampMinutes(0.4), 0)
    assert.equal(clampMinutes(0.5), 1)
    assert.equal(clampMinutes(29.4), 29)
    assert.equal(clampMinutes(29.6), 30)
    assert.equal(clampMinutes(59.9), 60)
    assert.equal(clampMinutes(60), 60)
    assert.equal(clampMinutes(80), 60)
  })

  it('queryTimeRange returns empty array when startMs > endMs', async () => {
    const res = await queryTimeRange(2000, 1000)
    assert.deepEqual(res, [])
  })

  it('queryTimeRange / loadTimeStats returns valid structure', async () => {
    const stats = await loadTimeStats()
    assert.ok(Array.isArray(stats.rows))
    assert.ok(typeof stats.totalMinutes === 'number')
    assert.ok(stats.totalMinutes >= 0)
  })
})
