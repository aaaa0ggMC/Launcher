import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SELF_PLUGIN_ID, cycleIndex, usableCandidates, validTriggerRange } from './select'
import type { MentionCandidate } from '../../services/plugins/mention'

const candidate = (ref: string): MentionCandidate => ({
  ref,
  label: ref,
  kind: 'builtin',
  description: '',
  enabled: true,
  tools: 0
})

test('usableCandidates 滤掉本插件自己与已点名的，顺序不变', () => {
  const items = [
    candidate('alpha'),
    candidate(SELF_PLUGIN_ID),
    candidate('beta'),
    candidate('chart')
  ]
  assert.deepEqual(
    usableCandidates(items, [candidate('beta')]).map((c) => c.ref),
    ['alpha', 'chart']
  )
  assert.equal(
    usableCandidates(items, []).some((c) => c.ref === SELF_PLUGIN_ID),
    false
  )
  assert.deepEqual(usableCandidates([], []), [])
})

test('cycleIndex 上下环绕，空列表恒为 0', () => {
  assert.equal(cycleIndex(0, 1, 3), 1)
  assert.equal(cycleIndex(2, 1, 3), 0)
  assert.equal(cycleIndex(0, -1, 3), 2)
  assert.equal(cycleIndex(1, -1, 3), 0)
  assert.equal(cycleIndex(5, 1, 3), 0)
  assert.equal(cycleIndex(0, 1, 0), 0)
})

test('validTriggerRange 接受未被改动的 @query 区间', () => {
  // '帮我看看 @chart 然后'：@ 在 5，'@chart' 占 [5,11)
  const draft = '帮我看看 @chart 然后'
  const range = { start: 5, end: 11, text: '@chart' }
  assert.equal(validTriggerRange(draft, range, { start: 11, end: 11 }), true)
  assert.equal(
    validTriggerRange('@chart', { start: 0, end: 6, text: '@chart' }, { start: 6, end: 6 }),
    true
  )
})

test('validTriggerRange 草稿变了就不删', () => {
  // 起始处被塞进别的字符，不再是边界（x 紧挨着 @）
  assert.equal(
    validTriggerRange(
      '帮我看看x@chart',
      { start: 5, end: 11, text: '@chart' },
      { start: 11, end: 11 }
    ),
    false
  )
  // 这段文字被改过，不再以 @ 开头
  assert.equal(
    validTriggerRange(
      '帮我看看 #chart 然后',
      { start: 5, end: 11, text: '@chart' },
      { start: 11, end: 11 }
    ),
    false
  )
  // 区间里出现了空白
  assert.equal(
    validTriggerRange(
      '帮我看看 @cha rt',
      { start: 5, end: 12, text: '@chart' },
      { start: 12, end: 12 }
    ),
    false
  )
  // 超界 / 空区间
  assert.equal(
    validTriggerRange('@chart', { start: 0, end: 99, text: '@chart' }, { start: 6, end: 6 }),
    false
  )
  assert.equal(
    validTriggerRange('@chart', { start: 3, end: 3, text: '@chart' }, { start: 6, end: 6 }),
    false
  )
})

test('validTriggerRange 光标退回区间里就不删', () => {
  const draft = '帮我看看 @chart 然后'
  const range = { start: 5, end: 11, text: '@chart' }
  assert.equal(validTriggerRange(draft, range, { start: 7, end: 7 }), false)
  // 光标在区间后面但选区往回覆盖了区间
  assert.equal(validTriggerRange(draft, range, { start: 12, end: 6 }), false)
})

test('rejects a replaced query and a cursor moved away', () => {
  const range = { start: 0, end: 6, text: '@chart' }
  assert.equal(validTriggerRange('@other', range, { start: 6, end: 6 }), false)
  assert.equal(validTriggerRange('@chart next', range, { start: 11, end: 11 }), false)
})
