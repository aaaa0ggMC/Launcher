import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'
import type { MessageNode } from '../types'

process.env.HOME = mkdtempSync('/tmp/yaya-tree-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('./db')
let tree: typeof import('./tree')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('./db')
  tree = await import('./tree')
})

let at = 1
function add(
  session: string,
  id: string,
  parent: string | null,
  role: MessageNode['role'],
  content: string,
  extra: Partial<MessageNode> = {}
): void {
  db.insertMessage(
    { id, sessionId: session, parentId: parent, role, content, createdAt: at++, ...extra },
    { moveLeaf: true }
  )
}

it('提问 / 回答折成轮次，工具链合并，编辑与重新生成形成分叉', () => {
  db.createSession({ id: 't1', title: 't' })
  add('t1', 'u1', null, 'user', 'hello')
  add('t1', 'a1', 'u1', 'assistant', '', {
    toolCalls: [{ id: 'c1', name: 'x', args: {} }] as MessageNode['toolCalls']
  })
  add('t1', 'r1', 'a1', 'tool', 'result', { toolCallId: 'c1' })
  add('t1', 'a1b', 'r1', 'assistant', 'first answer')
  add('t1', 'u2', 'a1b', 'user', 'follow up')
  add('t1', 'a2', 'u2', 'assistant', 'second answer')
  // 重新生成第一轮回答（u1 下的兄弟回答）
  add('t1', 'a1x', 'u1', 'assistant', 'regenerated')
  // 编辑第二个问题（a1b 下的兄弟提问）——当前分支
  add('t1', 'u2x', 'a1b', 'user', 'edited follow up')
  add('t1', 'a2x', 'u2x', 'assistant', 'edited answer')

  const t = tree.buildSessionTree('t1')
  const by = new Map(t.turns.map((x) => [x.id, x]))
  assert.equal(by.get('a1')?.endId, 'a1b')
  assert.equal(by.get('a1')?.tools, 1)
  assert.equal(by.get('a1')?.preview, 'first answer')
  assert.equal(by.get('u2')?.parent, 'a1')
  assert.equal(by.get('u2x')?.parent, 'a1')
  assert.equal(by.get('a1x')?.parent, 'u1')
  assert.equal(t.current, 'a2x')
  assert.deepEqual(
    t.turns.filter((x) => x.active).map((x) => x.id),
    ['u1', 'a1', 'u2x', 'a2x']
  )
  assert.equal(t.turns.length, 7)
})
