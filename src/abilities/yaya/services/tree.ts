/**
 * 会话树（对话树视图）：把消息 DAG 折成「轮次」节点——一次提问 = 一个 user 节点，
 * 一轮回答（assistant + 工具结果的连续链）= 一个 answer 节点。分叉来自编辑重发（兄弟 user 节点）
 * 与重新生成（同一提问下的兄弟回答）。只查轻量列（内容截断），长会话也便宜。
 */
import { getYayaDb, getSession, getMessageBranch } from './db'
import type { SessionTree, TreeTurn } from '../types'

export type { SessionTree, TreeTurn }

interface Row {
  id: string
  parent_id: string | null
  role: string
  snippet: string | null
  created_at: number
  status: string | null
  tool_calls: string | null
}

const PREVIEW = 120

function clean(s: string | null): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW)
}

export function buildSessionTree(sessionId: string): SessionTree {
  const session = getSession(sessionId)
  if (!session) return { turns: [], current: null }
  const rows = getYayaDb()
    .prepare(
      `SELECT id, parent_id, role, substr(content, 1, ${PREVIEW * 2}) AS snippet, created_at, status,
              CASE WHEN tool_calls IS NULL OR tool_calls = '' THEN NULL ELSE tool_calls END AS tool_calls
         FROM messages WHERE session_id = ? AND role != 'system' ORDER BY created_at ASC`
    )
    .all(sessionId) as unknown as Row[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const children = new Map<string, Row[]>()
  for (const r of rows) {
    const key = r.parent_id && byId.has(r.parent_id) ? r.parent_id : ''
    const list = children.get(key)
    if (list) list.push(r)
    else children.set(key, [r])
  }
  const activeIds = new Set(getMessageBranch(session.activeLeafId).map((m) => m.id))

  /** 消息 id → 所在轮次 id */
  const turnOf = new Map<string, string>()
  const turns: TreeTurn[] = []

  const toolCount = (r: Row): number => {
    if (!r.tool_calls) return 0
    try {
      const v = JSON.parse(r.tool_calls) as unknown[]
      return Array.isArray(v) ? v.length : 0
    } catch {
      return 0
    }
  }

  // 广度不要紧，按创建时间顺序遍历即可：父节点一定先于子节点创建
  const starts: { row: Row; parentTurn: string | null }[] = (children.get('') ?? []).map((row) => ({
    row,
    parentTurn: null
  }))
  while (starts.length) {
    const { row, parentTurn } = starts.shift()!
    if (row.role === 'user') {
      turnOf.set(row.id, row.id)
      turns.push({
        id: row.id,
        kind: 'user',
        parent: parentTurn,
        endId: row.id,
        preview: clean(row.snippet),
        tools: 0,
        createdAt: row.created_at,
        active: activeIds.has(row.id),
        status: row.status ?? undefined
      })
      for (const c of children.get(row.id) ?? []) starts.push({ row: c, parentTurn: row.id })
      continue
    }
    // 回答链：沿第一个非 user 子节点走；其余非 user 子节点另起分叉，user 子节点挂到本轮之后
    const turn: TreeTurn = {
      id: row.id,
      kind: 'answer',
      parent: parentTurn,
      endId: row.id,
      preview: '',
      tools: 0,
      createdAt: row.created_at,
      active: false,
      status: row.status ?? undefined
    }
    turns.push(turn)
    let cur: Row | undefined = row
    while (cur) {
      turnOf.set(cur.id, turn.id)
      turn.endId = cur.id
      if (activeIds.has(cur.id)) turn.active = true
      if (cur.role === 'assistant') {
        turn.tools += toolCount(cur)
        const text = clean(cur.snippet)
        if (text) turn.preview = text
        turn.status = cur.status ?? turn.status
      }
      const kids: Row[] = children.get(cur.id) ?? []
      const next: Row | undefined = kids.find((k) => k.role !== 'user')
      for (const k of kids) {
        if (k === next) continue
        starts.push({ row: k, parentTurn: turn.id })
      }
      cur = next
    }
  }
  const leaf = session.activeLeafId ?? null
  return { turns, current: leaf ? (turnOf.get(leaf) ?? null) : null }
}
