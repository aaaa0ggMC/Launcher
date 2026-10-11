import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeReactions,
  readAllReactions,
  readReactions,
  reactionNote,
  toggleReaction
} from './reactions'

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

test('消息级与气泡级分开读：不串台', () => {
  const meta = {
    reactions: [
      { key: '👍', at: 1 },
      { key: '❤️', at: 2, segment: 's1' },
      { key: '😂', at: 3, segment: 's2' },
      { key: '❤️', at: 4 }
    ]
  } as never
  assert.deepEqual(
    readReactions(meta).map((r) => r.key),
    ['👍', '❤️']
  )
  assert.deepEqual(
    readReactions(meta, 's1').map((r) => r.key),
    ['❤️']
  )
  assert.deepEqual(readReactions(meta, 's9'), [])
  assert.equal(readAllReactions(meta).length, 4)
})

test('气泡级切换：每个气泡是独立的一份（选择器只拿自己那份）', () => {
  const inSeg = toggleReaction([], '👍', { segment: 's1', now: 7 })
  assert.deepEqual(inSeg, [{ key: '👍', at: 7, segment: 's1' }])
  // 同一气泡内再点 = 移除
  assert.deepEqual(toggleReaction(inSeg, '👍', { segment: 's1' }), [])
  // 另一个气泡从空列表起算，互不影响
  const seg2 = toggleReaction([], '👍', { segment: 's2', now: 8 })
  assert.deepEqual(seg2, [{ key: '👍', at: 8, segment: 's2' }])
  // 写回时合到一份里，读取仍按 segment 分开
  const merged = [...inSeg, ...seg2]
  assert.equal(readAllReactions({ reactions: merged } as never).length, 2)
  assert.equal(readReactions({ reactions: merged } as never, 's1').length, 1)
})

test('mergeReactions：只换自己那一份，其余原位不动', () => {
  const all = [
    { key: '👍', at: 1 },
    { key: '❤️', at: 2, segment: 's1' },
    { key: '😂', at: 3 }
  ]
  const next = [
    { key: '❤️', at: 2, segment: 's1' },
    { key: '🎉', at: 9, segment: 's1' }
  ]
  // s1 那一份被整体替换（原位），消息级的两条不受影响
  assert.deepEqual(
    mergeReactions(all, 's1', next).map((r) => r.key),
    ['👍', '❤️', '🎉', '😂']
  )
  // 消息级那一份被清空：原位删除（👍 与 😂 都属于它）
  assert.deepEqual(
    mergeReactions(all, undefined, []).map((r) => r.key),
    ['❤️']
  )
  // 新的第一份追加在末尾
  assert.equal(mergeReactions(all, 's2', [{ key: '👍', at: 4, segment: 's2' }]).length, 4)
})

test('reactionNote：英文、稳定、消息级与气泡级各一行', () => {
  assert.equal(reactionNote({}), '')
  assert.equal(reactionNote(undefined), '')
  const meta = {
    reactions: [
      { key: '👍', at: 1 },
      { key: '❤️', at: 2 },
      { key: '😂', at: 3, segment: 's1' }
    ]
  } as never
  assert.equal(
    reactionNote(meta),
    '[user reacted to this message: 👍 ❤️]\n[user reacted to your segment "s1": 😂]'
  )
  // 稳定：同输入同输出（提示词缓存）
  assert.equal(reactionNote(meta), reactionNote(meta))
})
