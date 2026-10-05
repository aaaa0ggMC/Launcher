import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'

process.env.HOME = mkdtempSync('/tmp/yaya-docs-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('../../services/db')
let assets: typeof import('../../services/assets')
let plugin: typeof import('./index').default
let note: typeof import('../../services/providers/attachments').attachmentRefNote

before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('../../services/db')
  assets = await import('../../services/assets')
  plugin = (await import('./index')).default
  note = (await import('../../services/providers/attachments')).attachmentRefNote
})

function tool(name: string): (args: Record<string, unknown>) => Promise<unknown> {
  const t = plugin.tools().find((x) => x.name === name)!
  return (args) =>
    t.run(args, { sessionId: 's1', pluginId: 'documents', signal: new AbortController().signal })
}

it('列出 / 检索 / 按行读取本会话的大文本附件', async () => {
  const body = Array.from({ length: 5000 }, (_, i) =>
    i === 4200 ? 'the secret token is PINEAPPLE' : `line ${i} of the manual`
  ).join('\n')
  db.createSession({ id: 's1', title: 'docs' })
  const att = await assets.saveAsset('s1', 'manual.txt', Buffer.from(body), 'text/plain')
  db.insertMessage(
    {
      id: 'u1',
      sessionId: 's1',
      parentId: null,
      role: 'user',
      content: 'see attachment',
      attachments: [att],
      createdAt: Date.now()
    },
    { moveLeaf: true }
  )

  const list = (await tool('list')({})) as { documents: Array<Record<string, unknown>> }
  assert.equal(list.documents.length, 1)
  assert.equal(list.documents[0].lines, 5000)

  const found = (await tool('search')({ query: 'pineapple' })) as {
    results: Array<Record<string, unknown>>
  }
  assert.equal(found.results[0].document, att.id)
  assert.match(String(found.results[0].text), /PINEAPPLE/)

  const read = (await tool('read')({ document: 'manual.txt', start_line: 4201, max_lines: 1 })) as {
    content: Array<{ text: string }>
  }
  assert.match(read.content[0].text, /4201│the secret token is PINEAPPLE/)

  const missing = (await tool('read')({ document: 'nope' })) as { isError?: boolean }
  assert.equal(missing.isError, true)

  // 给模型的附件说明带 id、摘要与检索提示
  const text = await note(att)
  assert.match(text, new RegExp(`id="${att.id}"`))
  assert.match(text, /docs_search/)
  assert.match(text, /summary="line 0 of the manual/)
})
