import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'

process.env.HOME = mkdtempSync('/tmp/yaya-sessions-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('./db')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('./db')
})

it('多客户端：别的客户端刚新建的空会话不被删除，也不出现在这边的列表里', () => {
  const now = Date.now()
  db.createSession({ id: 'mine', title: 'mine' })
  db.createSession({ id: 'theirs', title: 'theirs' })
  db.createSession({ id: 'stale', title: 'stale', createdAt: now - 2 * 60 * 60 * 1000 })
  db.createSession({ id: 'used', title: 'used' })
  db.insertMessage(
    { id: 'm1', sessionId: 'used', parentId: null, role: 'user', content: 'hi', createdAt: now },
    { moveLeaf: true }
  )

  const ids = db.listSessions('mine').map((s) => s.id)
  assert.deepEqual(ids.sort(), ['mine', 'used'])
  // 别人的空会话还在（只是不显示），过期的空会话被删
  assert.ok(db.getSession('theirs'))
  assert.equal(db.getSession('stale'), null)
  // 那个客户端自己看得到
  assert.ok(db.listSessions('theirs').some((s) => s.id === 'theirs'))
})
