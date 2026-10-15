import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'

process.env.HOME = mkdtempSync('/tmp/yaya-search-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('./db')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('./db')
})

it('同时间戳的命中不重复占用会话搜索名额，稳定选择最后插入的消息', () => {
  for (const session of ['search-old', 'search-new']) {
    db.createSession({ id: session, title: session })
    for (let i = 0; i < 3; i++) {
      db.insertMessage({
        id: `${session}-${i}`,
        sessionId: session,
        parentId: null,
        role: 'user',
        content: 'needle',
        createdAt: 100
      })
    }
  }
  db.updateSession('search-new', { updatedAt: 200 })
  const hits = db.searchSessionMessages('needle', 2)
  assert.deepEqual(
    hits.map((h) => h.sessionId),
    ['search-new', 'search-old']
  )
  assert.deepEqual(
    hits.map((h) => h.messageId),
    ['search-new-2', 'search-old-2']
  )
  assert.deepEqual(
    hits.map((h) => h.matches),
    [3, 3]
  )
})

it('搜索把 SQL 通配符当文字，并排除工具消息', () => {
  db.createSession({ id: 'search-literal', title: 'literal' })
  for (const [id, role, content] of [
    ['literal-user', 'user', 'literal %_\\ value'],
    ['literal-tool', 'tool', 'tool-only']
  ] as const) {
    db.insertMessage({
      id,
      sessionId: 'search-literal',
      parentId: null,
      role,
      content,
      createdAt: 1
    })
  }
  assert.equal(db.searchSessionMessages('%_\\')[0]?.messageId, 'literal-user')
  assert.deepEqual(db.searchSessionMessages('tool-only'), [])
  assert.deepEqual(db.searchSessionMessages('  '), [])
})

it('返回最近的命中消息而非最近的任意消息', () => {
  db.createSession({ id: 'search-recent', title: 'recent' })
  for (const [id, content, createdAt] of [
    ['recent-first', 'unique-needle old', 10],
    ['recent-match', 'unique-needle newest match', 20],
    ['recent-last', 'unrelated', 30]
  ] as const) {
    db.insertMessage({
      id,
      sessionId: 'search-recent',
      parentId: null,
      role: 'assistant',
      content,
      createdAt
    })
  }
  const [hit] = db.searchSessionMessages('unique-needle', 1)
  assert.equal(hit.messageId, 'recent-match')
  assert.equal(hit.matches, 2)
})
