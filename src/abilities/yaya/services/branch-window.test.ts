import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'
import type { MessageNode } from '../types'

process.env.HOME = mkdtempSync('/tmp/yaya-window-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('./db')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('./db')
})

/** u1 a1 t1 a1b u2 a2 u3 a3 …：每轮 = 用户消息 + 若干 assistant / tool 节点 */
function seed(session: string, turns: number): string[] {
  db.createSession({ id: session, title: 't' })
  const ids: string[] = []
  let parent: string | null = null
  let at = 1
  const add = (role: MessageNode['role'], tag: string): void => {
    const id = `${session}-${tag}`
    db.insertMessage(
      { id, sessionId: session, parentId: parent, role, content: tag, createdAt: at++ },
      { moveLeaf: true }
    )
    ids.push(id)
    parent = id
  }
  for (let i = 1; i <= turns; i++) {
    add('user', `u${i}`)
    add('assistant', `a${i}`)
    if (i % 2) {
      add('tool', `t${i}`)
      add('assistant', `b${i}`)
    }
  }
  return ids
}

it('takes the last N user turns without splitting a turn', () => {
  const ids = seed('s1', 5)
  const leaf = ids[ids.length - 1]
  const w = db.getMessageBranchWindow(leaf, { limit: 2 })
  assert.deepEqual(
    w.messages.map((m) => m.content),
    ['u4', 'a4', 'u5', 'a5', 't5', 'b5']
  )
  assert.equal(w.hasMore, true)

  const older = db.getMessageBranchWindow(leaf, { limit: 2, before: w.messages[0].id })
  assert.deepEqual(
    older.messages.map((m) => m.content),
    ['u2', 'a2', 'u3', 'a3', 't3', 'b3']
  )
  assert.equal(older.hasMore, true)

  const first = db.getMessageBranchWindow(leaf, { limit: 2, before: older.messages[0].id })
  assert.deepEqual(
    first.messages.map((m) => m.content),
    ['u1', 'a1', 't1', 'b1']
  )
  assert.equal(first.hasMore, false)
})

it('whole branch fits → hasMore false; unknown before → empty', () => {
  const ids = seed('s2', 2)
  const leaf = ids[ids.length - 1]
  const w = db.getMessageBranchWindow(leaf, { limit: 30 })
  assert.equal(w.messages.length, ids.length)
  assert.equal(w.hasMore, false)
  assert.deepEqual(db.getMessageBranchWindow(leaf, { limit: 3, before: 'nope' }), {
    messages: [],
    hasMore: false
  })
})

it('attaches sibling ids only inside the window', () => {
  const ids = seed('s3', 3)
  // 给 u3 加一个兄弟分支（重新编辑产生）
  const u3 = ids.find((x) => x.endsWith('-u3'))!
  const u3Parent = db.getMessage(u3)!.parentId
  db.insertMessage({
    id: 's3-u3x',
    sessionId: 's3',
    parentId: u3Parent,
    role: 'user',
    content: 'u3x',
    createdAt: 999
  })
  const w = db.getMessageBranchWindow(ids[ids.length - 1], { limit: 1 })
  assert.deepEqual(w.messages[0].siblingIds, [u3, 's3-u3x'])
})

it('include extends the window back to the target turn plus one turn of context', () => {
  const ids = seed('s4', 8)
  const leaf = ids[ids.length - 1]
  const target = 's4-a3'
  const w = db.getMessageBranchWindow(leaf, { limit: 2, include: target })
  assert.equal(w.messages[0].content, 'u2')
  assert.ok(w.messages.some((m) => m.id === target))
  assert.equal(w.messages.at(-1)?.id, leaf)
  assert.equal(w.hasMore, true)
  // 已在窗口里 / 不在当前分支：窗口不变
  const same = db.getMessageBranchWindow(leaf, { limit: 2, include: 's4-u8' })
  assert.equal(same.messages[0].content, 'u7')
  const off = db.getMessageBranchWindow(leaf, { limit: 2, include: 'nope' })
  assert.equal(off.messages[0].content, 'u7')
  // 目标在第一轮：一直扩到开头
  const head = db.getMessageBranchWindow(leaf, { limit: 2, include: 's4-u1' })
  assert.equal(head.messages[0].content, 'u1')
  assert.equal(head.hasMore, false)
})
