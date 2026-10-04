/**
 * YAYA Session & Message Database
 * 基于 node:sqlite (DatabaseSync) 实现树状消息流持久化。
 * 纯 Node 内置，零原生编译依赖。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { USER_CONFIG_DIR } from '../../../main/process/paths'
import { makeLogger } from '../../../main/process/logger'
import type { Session, MessageNode } from '../types'
import { deleteSessionAssets } from './assets'

const log = makeLogger('yaya-db')

let db: DatabaseSync | null = null

export function getYayaDbPath(): string {
  return join(USER_CONFIG_DIR, 'yaya', 'yaya.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  active_leaf_id  TEXT,
  model           TEXT,
  provider_id     TEXT,
  system_prompt   TEXT,
  meta            TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions (updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  parent_id         TEXT,
  role              TEXT NOT NULL,
  content           TEXT NOT NULL,
  reasoning_content TEXT,
  tool_calls        TEXT,
  tool_call_id      TEXT,
  name              TEXT,
  attachments       TEXT,
  status            TEXT NOT NULL DEFAULT 'completed',
  error             TEXT,
  created_at        INTEGER NOT NULL,
  usage             TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id);
CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages (parent_id);
`

export function getYayaDb(): DatabaseSync {
  if (db) return db
  const path = getYayaDbPath()
  mkdirSync(dirname(path), { recursive: true })
  const d = new DatabaseSync(path)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec(SCHEMA)
  migrate(d)
  db = d
  log.info('YAYA database initialized at', { path })
  return db
}

/** 增量迁移：只加列，不改旧数据 */
function migrate(d: DatabaseSync): void {
  const cols = d.prepare('PRAGMA table_info(messages)').all() as unknown as { name: string }[]
  if (!cols.some((c) => c.name === 'meta')) d.exec('ALTER TABLE messages ADD COLUMN meta TEXT')
}

interface SessionRow {
  id: string
  title: string
  created_at: number
  updated_at: number
  active_leaf_id: string | null
  model: string | null
  provider_id: string | null
  system_prompt: string | null
  meta: string
}

function parseSessionRow(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeLeafId: row.active_leaf_id,
    model: row.model ?? undefined,
    providerId: row.provider_id ?? undefined,
    systemPrompt: row.system_prompt ?? undefined,
    meta: row.meta ? JSON.parse(row.meta) : {}
  }
}

interface MessageRow {
  id: string
  session_id: string
  parent_id: string | null
  role: string
  content: string
  reasoning_content: string | null
  tool_calls: string | null
  tool_call_id: string | null
  name: string | null
  attachments: string | null
  status: string
  error: string | null
  created_at: number
  usage: string | null
  meta: string | null
}

function parseMessageRow(row: MessageRow): MessageNode {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id,
    role: row.role as MessageNode['role'],
    content: row.content,
    reasoningContent: row.reasoning_content ?? undefined,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    toolCallId: row.tool_call_id ?? undefined,
    name: row.name ?? undefined,
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
    status: row.status as MessageNode['status'],
    error: row.error ?? undefined,
    createdAt: row.created_at,
    usage: row.usage ? JSON.parse(row.usage) : undefined,
    meta: row.meta ? JSON.parse(row.meta) : undefined
  }
}

export function cleanEmptySessions(keepSessionId?: string): void {
  const d = getYayaDb()
  if (keepSessionId) {
    d.prepare(
      `DELETE FROM sessions WHERE id != ? AND id NOT IN (SELECT DISTINCT session_id FROM messages)`
    ).run(keepSessionId)
  } else {
    d.prepare(
      `DELETE FROM sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM messages)`
    ).run()
  }
}

export function listSessions(keepSessionId?: string): Session[] {
  const d = getYayaDb()
  cleanEmptySessions(keepSessionId)
  const rows = d
    .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
    .all() as unknown as SessionRow[]
  return rows.map(parseSessionRow)
}

export function getSession(id: string): Session | null {
  const d = getYayaDb()
  const row = d.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as unknown as
    SessionRow | undefined
  return row ? parseSessionRow(row) : null
}

export function createSession(s: Partial<Session> & { id: string; title: string }): Session {
  const d = getYayaDb()
  const now = Date.now()
  const session: Session = {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt ?? now,
    updatedAt: s.updatedAt ?? now,
    activeLeafId: s.activeLeafId ?? null,
    model: s.model,
    providerId: s.providerId,
    systemPrompt: s.systemPrompt,
    meta: s.meta ?? {}
  }

  d.prepare(
    `INSERT INTO sessions (id, title, created_at, updated_at, active_leaf_id, model, provider_id, system_prompt, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id,
    session.title,
    session.createdAt,
    session.updatedAt,
    session.activeLeafId ?? null,
    session.model ?? null,
    session.providerId ?? null,
    session.systemPrompt ?? null,
    JSON.stringify(session.meta)
  )

  return session
}

export function updateSession(id: string, updates: Partial<Session>): void {
  const d = getYayaDb()
  const current = getSession(id)
  if (!current) return

  const updated: Session = {
    ...current,
    ...updates,
    updatedAt: updates.updatedAt ?? Date.now()
  }

  d.prepare(
    `UPDATE sessions SET
      title = ?,
      updated_at = ?,
      active_leaf_id = ?,
      model = ?,
      provider_id = ?,
      system_prompt = ?,
      meta = ?
     WHERE id = ?`
  ).run(
    updated.title,
    updated.updatedAt,
    updated.activeLeafId ?? null,
    updated.model ?? null,
    updated.providerId ?? null,
    updated.systemPrompt ?? null,
    JSON.stringify(updated.meta),
    id
  )
}

export function deleteSession(id: string): void {
  const d = getYayaDb()
  d.prepare('DELETE FROM messages WHERE session_id = ?').run(id)
  d.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  deleteSessionAssets(id)
}

export function insertMessage(msg: MessageNode): void {
  const d = getYayaDb()
  d.prepare(
    `INSERT INTO messages (
      id, session_id, parent_id, role, content, reasoning_content,
      tool_calls, tool_call_id, name, attachments, status, error, created_at, usage, meta
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    msg.id,
    msg.sessionId,
    msg.parentId,
    msg.role,
    msg.content,
    msg.reasoningContent ?? null,
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.toolCallId ?? null,
    msg.name ?? null,
    msg.attachments ? JSON.stringify(msg.attachments) : null,
    msg.status ?? 'completed',
    msg.error ?? null,
    msg.createdAt,
    msg.usage ? JSON.stringify(msg.usage) : null,
    msg.meta ? JSON.stringify(msg.meta) : null
  )

  // Update session active_leaf_id and updated_at
  updateSession(msg.sessionId, { activeLeafId: msg.id, updatedAt: msg.createdAt })
}

export function updateMessage(id: string, updates: Partial<MessageNode>): void {
  const d = getYayaDb()
  const current = getMessage(id)
  if (!current) return

  const updated: MessageNode = { ...current, ...updates }

  d.prepare(
    `UPDATE messages SET
      content = ?,
      reasoning_content = ?,
      tool_calls = ?,
      attachments = ?,
      status = ?,
      error = ?,
      usage = ?,
      meta = ?
     WHERE id = ?`
  ).run(
    updated.content,
    updated.reasoningContent ?? null,
    updated.toolCalls ? JSON.stringify(updated.toolCalls) : null,
    updated.attachments ? JSON.stringify(updated.attachments) : null,
    updated.status ?? 'completed',
    updated.error ?? null,
    updated.usage ? JSON.stringify(updated.usage) : null,
    updated.meta ? JSON.stringify(updated.meta) : null,
    id
  )
}

export function getMessage(id: string): MessageNode | null {
  const d = getYayaDb()
  const row = d.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as
    MessageRow | undefined
  return row ? parseMessageRow(row) : null
}

export function getSessionMessages(sessionId: string): MessageNode[] {
  const d = getYayaDb()
  const rows = d
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as unknown as MessageRow[]
  return rows.map(parseMessageRow)
}

/**
 * 删除一个节点及其全部后代。若当前分支经过它，activeLeaf 切到其父节点下最近的分支
 * （没有兄弟就停在父节点）。返回新的 activeLeaf。
 */
export function deleteMessageSubtree(messageId: string): string | null {
  const msg = getMessage(messageId)
  if (!msg) return null
  const d = getYayaDb()
  const ids: string[] = []
  const stack = [messageId]
  const children = d.prepare('SELECT id FROM messages WHERE parent_id = ?')
  while (stack.length) {
    const id = stack.pop()!
    ids.push(id)
    for (const r of children.all(id) as unknown as { id: string }[]) stack.push(r.id)
  }
  const session = getSession(msg.sessionId)
  const onActive = session?.activeLeafId ? ids.includes(session.activeLeafId) : false
  d.exec('BEGIN')
  try {
    const del = d.prepare('DELETE FROM messages WHERE id = ?')
    for (const id of ids) del.run(id)
    d.exec('COMMIT')
  } catch (e) {
    d.exec('ROLLBACK')
    throw e
  }
  if (!session) return null
  if (!onActive) return session.activeLeafId ?? null
  let leaf: string | null = msg.parentId
  if (msg.parentId) leaf = findLatestLeaf(msg.parentId)
  else {
    const root = d
      .prepare(
        'SELECT id FROM messages WHERE session_id = ? AND parent_id IS NULL ORDER BY created_at DESC LIMIT 1'
      )
      .get(msg.sessionId) as unknown as { id: string } | undefined
    leaf = root ? findLatestLeaf(root.id) : null
  }
  updateSession(msg.sessionId, { activeLeafId: leaf })
  return leaf
}

/**
 * 获取某个节点的同级分支数量及索引（兄弟节点集合）
 */
export function getMessageSiblings(messageId: string): { siblings: string[]; index: number } {
  const msg = getMessage(messageId)
  if (!msg) return { siblings: [messageId], index: 0 }
  const d = getYayaDb()
  let rows: { id: string }[]
  if (msg.parentId === null) {
    rows = d
      .prepare(
        'SELECT id FROM messages WHERE session_id = ? AND parent_id IS NULL ORDER BY created_at ASC'
      )
      .all(msg.sessionId) as unknown as { id: string }[]
  } else {
    rows = d
      .prepare(
        'SELECT id FROM messages WHERE session_id = ? AND parent_id = ? ORDER BY created_at ASC'
      )
      .all(msg.sessionId, msg.parentId) as unknown as { id: string }[]
  }
  const siblings = rows.map((r) => r.id)
  const index = siblings.indexOf(messageId)
  return { siblings, index: Math.max(0, index) }
}

/**
 * 从叶子节点回溯至根节点，生成当前分支线性对话链
 */
export function getMessageBranch(leafId: string | null | undefined): MessageNode[] {
  if (!leafId) return []
  const branch: MessageNode[] = []
  const seen = new Set<string>()
  let currId: string | null = leafId

  while (currId && !seen.has(currId)) {
    seen.add(currId)
    const msg = getMessage(currId)
    if (!msg) break
    branch.unshift(msg)
    currId = msg.parentId
  }
  return branch
}

/** 当前分支 + 每个节点的同级分支 id（给界面的 `< i/n >` 翻页器，一次查询代替逐条请求） */
export function getMessageBranchWithSiblings(leafId: string | null | undefined): MessageNode[] {
  const branch = getMessageBranch(leafId)
  if (branch.length === 0) return branch
  const d = getYayaDb()
  const rows = d
    .prepare('SELECT id, parent_id FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(branch[0].sessionId) as unknown as { id: string; parent_id: string | null }[]
  const byParent = new Map<string, string[]>()
  for (const r of rows) {
    const key = r.parent_id ?? ''
    const list = byParent.get(key)
    if (list) list.push(r.id)
    else byParent.set(key, [r.id])
  }
  return branch.map((m) => {
    const sib = byParent.get(m.parentId ?? '') ?? [m.id]
    return sib.length > 1 ? { ...m, siblingIds: sib } : m
  })
}

/**
 * 从某节点往下走到「最近更新」的叶子：切换分支时用，
 * 否则直接把 activeLeaf 设成兄弟节点会把该分支后续的对话截掉。
 */
export function findLatestLeaf(nodeId: string): string {
  const d = getYayaDb()
  const stmt = d.prepare(
    'SELECT id FROM messages WHERE parent_id = ? ORDER BY created_at DESC LIMIT 1'
  )
  let curr = nodeId
  const seen = new Set<string>([curr])
  for (;;) {
    const row = stmt.get(curr) as unknown as { id: string } | undefined
    if (!row || seen.has(row.id)) return curr
    seen.add(row.id)
    curr = row.id
  }
}

export interface SessionSearchHit {
  sessionId: string
  messageId: string
  role: 'user' | 'assistant'
  /** 命中位置附近的一小段文字 */
  snippet: string
  /** 该会话内命中的消息条数 */
  matches: number
}

/**
 * 全文检索消息内容（user / assistant 正文，不含工具输出）。每个会话只返回最近的一条命中 +
 * 命中条数，按会话更新时间倒序。LIKE + 转义，几万条消息内是毫秒级；调用方自行防抖。
 */
export function searchSessionMessages(query: string, limit = 50): SessionSearchHit[] {
  const q = query.trim()
  if (!q) return []
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  const rows = getYayaDb()
    .prepare(
      `SELECT m.id, m.session_id, m.role, m.content, cnt.n AS matches
       FROM messages m
       JOIN (
         SELECT session_id, MAX(created_at) AS last, COUNT(*) AS n
         FROM messages
         WHERE role IN ('user', 'assistant') AND content LIKE ? ESCAPE '\\'
         GROUP BY session_id
       ) cnt ON cnt.session_id = m.session_id AND cnt.last = m.created_at
       JOIN sessions s ON s.id = m.session_id
       WHERE m.role IN ('user', 'assistant') AND m.content LIKE ? ESCAPE '\\'
       ORDER BY s.updated_at DESC
       LIMIT ?`
    )
    .all(pattern, pattern, limit) as unknown as {
    id: string
    session_id: string
    role: 'user' | 'assistant'
    content: string
    matches: number
  }[]
  const seen = new Set<string>()
  const lower = q.toLowerCase()
  const out: SessionSearchHit[] = []
  for (const r of rows) {
    if (seen.has(r.session_id)) continue
    seen.add(r.session_id)
    const text = r.content.replace(/\s+/g, ' ')
    const at = Math.max(0, text.toLowerCase().indexOf(lower))
    const start = Math.max(0, at - 24)
    const snippet =
      (start > 0 ? '…' : '') +
      text.slice(start, at + q.length + 56) +
      (at + q.length + 56 < text.length ? '…' : '')
    out.push({
      sessionId: r.session_id,
      messageId: r.id,
      role: r.role,
      snippet,
      matches: r.matches
    })
  }
  return out
}
