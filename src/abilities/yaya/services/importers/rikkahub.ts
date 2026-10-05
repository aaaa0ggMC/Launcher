/**
 * Rikkahub（Android 客户端）备份导入：设置 → 数据备份 → 导出得到的 zip（内含 `rikka_hub.db`
 * 及其 `-wal` / `-shm`），或直接给 `.db` 文件。用内置 `node:sqlite` 只读查询。
 *
 * 两代表结构都兼容（按列名探测，不写死版本）：
 * - 旧：`ConversationEntity.nodes` 是 JSON 数组 `[{ id, messages: [UIMessage…], selectIndex }]`；
 * - 新：`message_node` 表（`conversation_id`, `node_index`, `messages`, `select_index`）。
 * 每个 node 是对话里的一个位置，`messages` 是该位置的候选（重新生成 / 编辑产生的分支），
 * 映射成：同一位置的候选互为兄弟，父 = 上一位置被选中的那条；活动叶子 = 最后位置被选中的那条。
 * UIMessage 的 parts 是多态 JSON：有 `text` 的算正文，类型含 reasoning 的进推理过程，
 * 图片 / 文件留占位，工具调用写一行摘要，工具结果跳过。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { t } from '../../../../main/process/i18n'
import { parseTime, type ImportedConversation, type ImportedNode } from './common'
import { findEntry, type ZipEntry } from './zip'

type Rec = Record<string, unknown>

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/** zip 里有 Rikkahub 数据库 */
export function zipHasRikkahub(entries: ZipEntry[]): boolean {
  return Boolean(findEntry(entries, 'rikka_hub.db'))
}

/** 把 zip 里的数据库（含 wal / shm）解到临时目录，返回 .db 路径与清理函数 */
export function extractRikkahubDb(entries: ZipEntry[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'yaya-rikkahub-'))
  const db = findEntry(entries, 'rikka_hub.db')
  if (!db) throw new Error('rikka_hub.db not found in the backup')
  for (const suffix of ['', '-wal', '-shm']) {
    const e = findEntry(entries, `rikka_hub.db${suffix}`)
    if (e) writeFileSync(join(dir, `rikka_hub.db${suffix}`), e.read())
  }
  return {
    path: join(dir, 'rikka_hub.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}

function partsText(parts: unknown): { content: string; reasoning: string } {
  const content: string[] = []
  const reasoning: string[] = []
  for (const p of (Array.isArray(parts) ? parts : []) as Rec[]) {
    if (!p || typeof p !== 'object') continue
    const type = str(p.type).toLowerCase()
    if (type.includes('reason')) {
      const r = str(p.reasoning) || str(p.text)
      if (r) reasoning.push(r)
    } else if (type.includes('toolresult') || type.includes('tool_result')) {
      continue
    } else if (type.includes('tool')) {
      content.push(
        `[${t('yaya.io.tool_call', '工具调用')}: ${str(p.toolName) || str(p.name) || '?'}]`
      )
    } else if (typeof p.text === 'string') {
      if (p.text) content.push(p.text)
    } else if (type.includes('image') || type.includes('document') || type.includes('file')) {
      content.push(t('yaya.io.placeholder_image', '[图片/附件未导入]'))
    } else if (typeof p.reasoning === 'string' && p.reasoning) {
      reasoning.push(p.reasoning)
    }
  }
  return { content: content.join('\n\n'), reasoning: reasoning.join('\n\n') }
}

interface RkNode {
  messages: Rec[]
  selectIndex: number
}

function toNodes(rawNodes: RkNode[]): { nodes: ImportedNode[]; leaf: string | null } {
  const nodes: ImportedNode[] = []
  let parent: string | null = null
  let leaf: string | null = null
  rawNodes.forEach((n, pos) => {
    const msgs = Array.isArray(n.messages) ? n.messages : []
    const want = Math.max(0, Math.floor(Number(n.selectIndex) || 0))
    let selected: string | null = null
    let first: string | null = null
    msgs.forEach((m, i) => {
      const role = str(m.role).toLowerCase()
      if (role !== 'user' && role !== 'assistant') return
      const id = str(m.id) || `n${pos}-${i}`
      const { content, reasoning } = partsText(m.parts)
      nodes.push({
        id,
        parent,
        role,
        content: content || str(m.content),
        reasoning,
        createdAt: parseTime(m.createdAt ?? m.created_at),
        model: str(m.modelId) || undefined
      })
      first = first ?? id
      if (i === want) selected = id
    })
    selected = selected ?? first
    if (selected) {
      parent = selected
      leaf = selected
    }
  })
  return { nodes, leaf }
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Rec[]).map((r) =>
    str(r.name)
  )
}

export function parseRikkahubDb(path: string): ImportedConversation[] {
  const db = new DatabaseSync(path)
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Rec[]
    ).map((r) => str(r.name))
    const convTable =
      tables.find((n) => n.toLowerCase() === 'conversationentity') ??
      tables.find((n) => {
        const cols = columns(db, n)
        return cols.includes('title') && cols.includes('id') && /conversation/i.test(n)
      })
    if (!convTable) throw new Error('no conversation table found (not a Rikkahub database?)')
    const convCols = columns(db, convTable)
    const nodeTable = tables.find((n) => {
      const cols = columns(db, n)
      return cols.includes('conversation_id') && cols.includes('messages')
    })
    const nodeCols = nodeTable ? columns(db, nodeTable) : []
    const pick = (cols: string[], ...names: string[]): string | undefined =>
      names.find((x) => cols.includes(x))
    const createdCol = pick(convCols, 'create_at', 'created_at', 'createAt')
    const updatedCol = pick(convCols, 'update_at', 'updated_at', 'updateAt')
    const orderCol = pick(nodeCols, 'node_index', 'index', 'position')
    const selectCol = pick(nodeCols, 'select_index', 'selectIndex')

    const out: ImportedConversation[] = []
    for (const c of db.prepare(`SELECT * FROM "${convTable}"`).all() as Rec[]) {
      const id = String(c.id ?? '')
      let raw: RkNode[] = []
      if (convCols.includes('nodes') && typeof c.nodes === 'string' && c.nodes.length > 2) {
        const parsed = parseJson(c.nodes)
        if (Array.isArray(parsed)) raw = parsed as RkNode[]
      }
      if (!raw.length && nodeTable) {
        const rows = db
          .prepare(
            `SELECT * FROM "${nodeTable}" WHERE conversation_id = ?${orderCol ? ` ORDER BY "${orderCol}"` : ''}`
          )
          .all(id) as Rec[]
        raw = rows.map((r) => ({
          messages: (parseJson(r.messages) as Rec[]) ?? [],
          selectIndex: Number(selectCol ? r[selectCol] : 0) || 0
        }))
      }
      const { nodes, leaf } = toNodes(raw)
      out.push({
        source: 'rikkahub',
        id,
        title: str(c.title) || t('yaya.io.import_default_title_rikkahub', '导入的 Rikkahub 会话'),
        createdAt: createdCol ? parseTime(c[createdCol]) : undefined,
        updatedAt: updatedCol ? parseTime(c[updatedCol]) : undefined,
        activeLeaf: leaf,
        nodes
      })
    }
    return out
  } finally {
    db.close()
  }
}
