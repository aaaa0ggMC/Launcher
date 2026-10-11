import test from 'node:test'
import assert from 'node:assert/strict'
import { readReactions, toggleReaction } from './reactions'

test('读取：没有 / 脏数据 / 重复 key 都被处理', () => {
  assert.deepEqual(readReactions(undefined), [])
  assert.deepEqual(readReactions({}), [])
  assert.deepEqual(readReactions({ reactions: 'nope' as never }), [])
  const out = readReactions({
    reactions: [
      { key: '👍', at: 1 },
      'x',
      null,
      { key: '👍', at: 2 },
      { key: '  ❤️  ' },
      { key: '   ' },
      { at: 3 }
    ]
  } as never)
  assert.deepEqual(out, [
    { key: '👍', at: 1 },
    { key: '❤️', at: 0 }
  ])
})

test('切换：没有则加、有则去掉', () => {
  const now = 1000
  const a = toggleReaction([], '👍', { now })
  assert.deepEqual(a, [{ key: '👍', at: now }])
  const b = toggleReaction(a, '👍', { now: 2000 })
  assert.deepEqual(b, [])
})

test('remove 显式移除；空白 key 不动', () => {
  const list = [{ key: '😂', at: 1 }]
  assert.deepEqual(toggleReaction(list, '😂', { remove: true }), [])
  assert.deepEqual(toggleReaction(list, '   ', {}), list)
  assert.deepEqual(toggleReaction(list, '👍', { remove: true }), list)
})

test('不修改入参数组', () => {
  const list = [{ key: '👍', at: 1 }]
  const next = toggleReaction(list, '❤️', { now: 5 })
  assert.equal(list.length, 1)
  assert.equal(next.length, 2)
})
