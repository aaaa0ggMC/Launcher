import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { before, it } from 'node:test'

process.env.HOME = mkdtempSync('/tmp/yaya-importers-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('../db')
let load: typeof import('./load')
let zip: typeof import('./zip')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('../db')
  load = await import('./load')
  zip = await import('./zip')
})

/** 最小 zip 写入（deflate），只给测试用 */
function makeZip(files: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, data] of Object.entries(files)) {
    const comp = deflateRawSync(data)
    const nameBuf = Buffer.from(name)
    const loc = Buffer.alloc(30)
    loc.writeUInt32LE(0x04034b50, 0)
    loc.writeUInt16LE(8, 8)
    loc.writeUInt32LE(comp.length, 18)
    loc.writeUInt32LE(data.length, 22)
    loc.writeUInt16LE(nameBuf.length, 26)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(0x800, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt32LE(comp.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    locals.push(loc, nameBuf, comp)
    centrals.push(cen, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

function branch(sessionId: string): Array<[string, string]> {
  const s = db.getSession(sessionId)
  return db.getMessageBranch(s?.activeLeafId).map((m) => [m.role, m.content])
}

const claudeExport = [
  {
    uuid: 'c-1',
    name: 'Claude 对话',
    created_at: '2025-03-01T10:00:00Z',
    updated_at: '2025-03-01T10:05:00Z',
    chat_messages: [
      {
        uuid: 'u1',
        sender: 'human',
        text: '你好',
        content: [{ type: 'text', text: '你好' }],
        attachments: [{ file_name: 'a.txt', extracted_content: 'hello file' }],
        parent_message_uuid: '00000000-0000-4000-8000-000000000000',
        created_at: '2025-03-01T10:00:00Z'
      },
      {
        uuid: 'a1',
        sender: 'assistant',
        content: [
          { type: 'thinking', thinking: '想一想' },
          { type: 'text', text: '旧回答' }
        ],
        parent_message_uuid: 'u1',
        created_at: '2025-03-01T10:01:00Z'
      },
      {
        uuid: 'a2',
        sender: 'assistant',
        content: [{ type: 'text', text: '新回答' }],
        parent_message_uuid: 'u1',
        created_at: '2025-03-01T10:02:00Z'
      }
    ]
  }
]

it('识别：Claude / DeepSeek / ChatGPT 的 JSON 结构', () => {
  assert.equal(load.detectJsonFormat(claudeExport), 'claude')
  assert.equal(
    load.detectJsonFormat([{ mapping: { a: { message: { fragments: [] } } } }]),
    'deepseek'
  )
  assert.equal(
    load.detectJsonFormat([{ mapping: { a: { message: { author: { role: 'user' } } } } }]),
    'openai'
  )
  assert.equal(load.detectJsonFormat({ foo: 1 }), null)
})

it('Claude：还原分支、思考、附件文本；活动叶子取最新；重复导入跳过', () => {
  const p = load.prepareImport(Buffer.from(JSON.stringify(claudeExport)))
  assert.equal(p.format, 'claude')
  const r = p.run()
  assert.equal(r.importedSessions, 1)
  assert.equal(r.importedMessages, 3)
  const msgs = branch('claude-c-1')
  assert.equal(msgs.length, 2)
  assert.match(msgs[0][1], /你好[\s\S]*<attachment name="a.txt">\nhello file/)
  assert.equal(msgs[1][1], '新回答')
  const all = db.getSessionMessages('claude-c-1')
  assert.equal(all.find((m) => m.content === '旧回答')?.reasoningContent, '想一想')
  // 两个回答是兄弟分支
  const answers = all.filter((m) => m.role === 'assistant')
  assert.equal(answers[0].parentId, answers[1].parentId)
  assert.equal(
    load.prepareImport(Buffer.from(JSON.stringify(claudeExport))).run().skippedSessions,
    1
  )
})

it('DeepSeek：fragments、THINK 进推理、空根节点被跳过；zip 里的 conversations.json', () => {
  const ds = [
    {
      id: 'd-1',
      title: 'DS',
      inserted_at: '2025-02-01T08:00:00+08:00',
      updated_at: '2025-02-01T08:10:00+08:00',
      mapping: {
        root: { id: 'root', parent: null, children: ['1'], message: null },
        '1': {
          id: '1',
          parent: 'root',
          children: ['2'],
          message: { fragments: [{ type: 'REQUEST', content: '1+1?' }] }
        },
        '2': {
          id: '2',
          parent: '1',
          children: [],
          message: {
            model: 'deepseek-reasoner',
            fragments: [
              { type: 'THINK', content: '简单加法' },
              { type: 'RESPONSE', content: '2' }
            ]
          }
        }
      }
    }
  ]
  const buf = makeZip({ 'export/conversations.json': Buffer.from(JSON.stringify(ds)) })
  assert.equal(zip.readZip(buf).length, 1)
  const p = load.prepareImport(buf)
  assert.equal(p.format, 'deepseek')
  p.run()
  assert.deepEqual(branch('deepseek-d-1'), [
    ['user', '1+1?'],
    ['assistant', '2']
  ])
  const answer = db.getSessionMessages('deepseek-d-1').find((m) => m.role === 'assistant')
  assert.equal(answer?.reasoningContent, '简单加法')
  assert.equal(db.getSession('deepseek-d-1')?.model, 'deepseek-reasoner')
})

function rikkahubDb(dir: string, layout: 'json' | 'table'): string {
  const path = join(dir, `rikka_hub_${layout}.db`)
  const d = new DatabaseSync(path)
  const nodes = [
    {
      id: 'n1',
      selectIndex: 0,
      messages: [
        {
          id: 'm-u',
          role: 'USER',
          parts: [{ type: 'me.rerere.ai.ui.UIMessagePart.Text', text: '讲个笑话' }],
          createdAt: '2025-04-01T12:00:00'
        }
      ]
    },
    {
      id: 'n2',
      selectIndex: 1,
      messages: [
        { id: 'm-a1', role: 'ASSISTANT', parts: [{ type: 'text', text: '第一版' }] },
        {
          id: 'm-a2',
          role: 'ASSISTANT',
          parts: [
            { type: 'reasoning', reasoning: '想个好笑的' },
            { type: 'text', text: '第二版' },
            { type: 'image', url: 'file://x.png' }
          ]
        }
      ]
    }
  ]
  if (layout === 'json') {
    d.exec(
      'CREATE TABLE ConversationEntity (id TEXT PRIMARY KEY, assistant_id TEXT, title TEXT, nodes TEXT, create_at INTEGER, update_at INTEGER)'
    )
    d.prepare('INSERT INTO ConversationEntity VALUES (?, ?, ?, ?, ?, ?)').run(
      'r-1',
      'a',
      '笑话',
      JSON.stringify(nodes),
      1743480000000,
      1743480100000
    )
  } else {
    d.exec(
      'CREATE TABLE ConversationEntity (id TEXT PRIMARY KEY, title TEXT, nodes TEXT, create_at INTEGER, update_at INTEGER)'
    )
    d.exec(
      'CREATE TABLE message_node (id TEXT PRIMARY KEY, conversation_id TEXT, node_index INTEGER, messages TEXT, select_index INTEGER)'
    )
    d.prepare('INSERT INTO ConversationEntity VALUES (?, ?, ?, ?, ?)').run(
      'r-2',
      '笑话2',
      '[]',
      1743480000000,
      1743480100000
    )
    nodes.forEach((n, i) =>
      d
        .prepare('INSERT INTO message_node VALUES (?, ?, ?, ?, ?)')
        .run(n.id, 'r-2', i, JSON.stringify(n.messages), n.selectIndex)
    )
  }
  d.close()
  return path
}

it('Rikkahub：两种表结构；候选互为兄弟，活动叶子 = 选中的那条', async () => {
  const { readFileSync } = await import('node:fs')
  const dir = mkdtempSync('/tmp/yaya-rk-')
  // 旧结构：zip 备份
  const zipped = makeZip({ 'rikka_hub.db': readFileSync(rikkahubDb(dir, 'json')) })
  const p1 = load.prepareImport(zipped)
  assert.equal(p1.format, 'rikkahub')
  p1.run()
  assert.deepEqual(branch('rikkahub-r-1'), [
    ['user', '讲个笑话'],
    ['assistant', '第二版\n\n[图片/附件未导入]']
  ])
  const a2 = db.getSessionMessages('rikkahub-r-1').find((m) => m.content.startsWith('第二版'))
  assert.equal(a2?.reasoningContent, '想个好笑的')
  // 新结构：直接给 .db
  const p2 = load.prepareImport(readFileSync(rikkahubDb(dir, 'table')))
  p2.run()
  assert.equal(branch('rikkahub-r-2').at(-1)?.[1].startsWith('第二版'), true)
  assert.equal(db.getSessionMessages('rikkahub-r-2').length, 3)
})

it('认不出的内容给出明确错误', () => {
  assert.throws(() => load.prepareImport(Buffer.from('{"x":1}')), /认不出|Unrecognized/)
  assert.throws(() => load.prepareImport(Buffer.from('not json')), /JSON/)
})
