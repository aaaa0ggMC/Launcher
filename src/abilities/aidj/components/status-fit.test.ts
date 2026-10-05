import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitStatusCount } from './status-fit'

test('fits as many leading chips as the row allows, reserving the +N chip', () => {
  // more 40 + (6 + 80) * 3 = 298 ≤ 300; a 4th would need 384
  assert.equal(fitStatusCount([80, 80, 80, 80], 300, 6, 40), 3)
})

test('everything fits', () => {
  assert.equal(fitStatusCount([50, 50], 400, 6, 40), 2)
})

test('stops at the first chip that does not fit (keeps order)', () => {
  assert.equal(fitStatusCount([60, 200, 30], 200, 6, 40), 1)
})

test('exact fit is allowed', () => {
  assert.equal(fitStatusCount([100], 146, 6, 40), 1)
  assert.equal(fitStatusCount([100], 145, 6, 40), 0)
})

test('nothing fits on a very narrow row', () => {
  assert.equal(fitStatusCount([120, 90], 100, 6, 40), 0)
  assert.equal(fitStatusCount([], 300, 6, 40), 0)
})
