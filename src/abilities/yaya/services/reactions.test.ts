import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addTombstone,
  MAX_TOMBSTONES,
  mergeReactions,
  readAllReactions,
  readReactions,
  readTombstones,
  reactionNote,
  stripEchoedReactionNotes,
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

test('by：AI 点的表态带 by=ai 落库并读回（用户点的不落字段，老数据兼容）', () => {
  const ai = toggleReaction([], '🎯', { now: 5, by: 'ai' })
  assert.deepEqual(ai, [{ key: '🎯', at: 5, by: 'ai' }])
  const back = readAllReactions({ reactions: ai } as never)
  assert.equal(back[0].by, 'ai')
  const user = toggleReaction([], '👍', { now: 6 })
  assert.equal(user[0].by, undefined)
  // 脏数据里的 by 不认识 → 按用户算
  assert.equal(
    readAllReactions({ reactions: [{ key: 'x', by: 'human' }] } as never)[0].by,
    undefined
  )
})

test('reactionNote：按角色措辞——用户消息区分自己点的 / AI 点的', () => {
  const meta = {
    reactions: [
      { key: '👍', at: 1 },
      { key: '🎯', at: 2, by: 'ai' }
    ]
  } as never
  assert.equal(
    reactionNote(meta, 'user'),
    "[user reacted to their own message: 👍]\n[you reacted to this user's message: 🎯]"
  )
  // 同一份 meta，assistant 视角：AI 点的（by=ai）只会出现在用户消息上，这里静默跳过
  assert.equal(reactionNote(meta, 'assistant'), '[user reacted to this message: 👍]')
})

test('取消墓碑：addTombstone 去重封顶，reactionNote 表达「点过又取消」', () => {
  let tombs = addTombstone([], { key: '👍', at: 1 })
  tombs = addTombstone(tombs, { key: '😂', at: 2 })
  tombs = addTombstone(tombs, { key: '👍', at: 3 }) // 同 key 再取消 = 换新（以最新为准）
  assert.deepEqual(
    tombs.map((t) => [t.key, t.at]),
    [
      ['😂', 2],
      ['👍', 3]
    ]
  )
  for (let i = 0; i < 20; i++) tombs = addTombstone(tombs, { key: `k${i}`, at: 10 + i })
  assert.equal(tombs.length, MAX_TOMBSTONES)

  const meta = {
    reactionTombstones: [
      { key: '👍', at: 1 },
      { key: '🎯', at: 2, by: 'ai' }
    ]
  } as never
  assert.equal(readTombstones(meta).length, 2)
  assert.equal(reactionNote(meta), '[user removed their reaction: 👍]')
  assert.equal(
    reactionNote(meta, 'user'),
    "[user removed their reaction from their own message: 👍]\n[you removed your reaction from this user's message: 🎯]"
  )
  // 既有表情 + 取消墓碑同时出现：当前状态在前、墓碑在后
  const both = {
    reactions: [{ key: '❤️', at: 9 }],
    reactionTombstones: [{ key: '👍', at: 1 }]
  } as never
  assert.equal(
    reactionNote(both),
    '[user reacted to this message: ❤️]\n[user removed their reaction: 👍]'
  )
})

test('stripEchoedReactionNotes：只剥复读的 note 行，普通文本不动', () => {
  // 整行复读 → 丢弃该行
  assert.equal(
    stripEchoedReactionNotes('收到\n\n[user reacted to your segment "b3": 👍]\n\n哈哈别夸'),
    '收到\n\n哈哈别夸'
  )
  // 行首粘连 → 只剥前缀
  assert.equal(
    stripEchoedReactionNotes('[user reacted to your segment "b1": ❤️]想不想看个小的？'),
    '想不想看个小的？'
  )
  // 取消 / AI 自己的 note 同样剥
  assert.equal(
    stripEchoedReactionNotes('[user removed their reaction: 👍]\n[your reply]'),
    '[your reply]'
  )
  // 普通含方括号的文本（不匹配前缀）原样保留
  const plain = '看这个 [示例] 和 [user guide] 都留着'
  assert.equal(stripEchoedReactionNotes(plain), plain)
  assert.equal(stripEchoedReactionNotes(''), '')
})
