/**
 * 导入器公共层：各来源（Claude / DeepSeek / Rikkahub …）先解析成统一的 `ImportedConversation`，
 * 再由这里统一写库（与 ChatGPT 导入器同样的加固规则）：
 *  - 同一会话重复导入直接跳过（会话 id = `<来源>-<原 id>`，消息 id 再带上会话 id，跨会话不冲突）；
 *  - 空节点不入库，其子节点 re-parent 到最近的被保留祖先；按树顺序（父先于子）插入；
 *  - 时间缺失时沿父节点 +1ms；活动叶子缺省取最后创建的叶子；
 *  - 单个会话包在一个事务里，失败整条回滚并记入 errors。
 */
import { createSession, getSession, getYayaDb, insertMessage, updateSession } from '../db'
import { makeLogger } from '../../../../main/process/logger'
import type { MessageNode } from '../../types'
import type { ImportProgress, ImportResult } from './openai'

const log = makeLogger('yaya-importer')

export type ImportSource = 'claude' | 'deepseek' | 'rikkahub'

export interface ImportedNode {
  /** 会话内唯一 */
  id: string
  parent: string | null
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  /** 毫秒；缺失时由写入层补 */
  createdAt?: number
  model?: string
}

export interface ImportedConversation {
  source: ImportSource
  /** 来源里的原始 id */
  id: string
  title: string
  createdAt?: number
  updatedAt?: number
  /** 当前选中的分支叶子（原 id）；缺省 = 最后创建的叶子 */
  activeLeaf?: string | null
  model?: string
  nodes: ImportedNode[]
}

/** 资产目录 / 会话 id 只允许 `[A-Za-z0-9._-]` */
export function safeId(s: string): string {
  return (
    String(s)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 120) || 'x'
  )
}

/** 各种时间表示 → 毫秒：秒 / 毫秒数字、ISO 字符串、Kotlin LocalDateTime 字符串 */
export function parseTime(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string' && v.trim()) {
    if (/^\d+(\.\d+)?$/.test(v.trim())) return parseTime(Number(v))
    const ms = Date.parse(v)
    if (Number.isFinite(ms)) return ms
  }
  return undefined
}

interface Planned extends ImportedNode {
  parent: string | null
}

/** 保留有内容的节点、re-parent、BFS 排序（父先于子；环 / 不可达兜底排最后） */
export function planNodes(nodes: ImportedNode[]): Planned[] {
  const rawParent = new Map(nodes.map((n) => [n.id, n.parent]))
  const kept: Planned[] = nodes
    .filter((n) => n.content.trim() || n.reasoning?.trim())
    .map((n) => ({ ...n }))
  const keptIds = new Set(kept.map((k) => k.id))
  for (const k of kept) {
    let p = k.parent
    const seen = new Set<string>()
    while (p && !keptIds.has(p) && !seen.has(p)) {
      seen.add(p)
      p = rawParent.get(p) ?? null
    }
    k.parent = p && keptIds.has(p) && p !== k.id ? p : null
  }
  const byParent = new Map<string | null, Planned[]>()
  for (const k of kept) {
    const arr = byParent.get(k.parent) ?? []
    arr.push(k)
    byParent.set(k.parent, arr)
  }
  const ordered: Planned[] = []
  const visited = new Set<string>()
  const queue = [...(byParent.get(null) ?? [])]
  while (queue.length) {
    const cur = queue.shift()!
    if (visited.has(cur.id)) continue
    visited.add(cur.id)
    ordered.push(cur)
    queue.push(...(byParent.get(cur.id) ?? []))
  }
  for (const k of kept) if (!visited.has(k.id)) ordered.push({ ...k, parent: null })
  return ordered
}

export function writeImportedConversations(
  conversations: ImportedConversation[],
  onProgress?: (p: ImportProgress) => void,
  signal?: AbortSignal
): ImportResult {
  const result: ImportResult = {
    importedSessions: 0,
    skippedSessions: 0,
    importedMessages: 0,
    errors: []
  }
  const db = getYayaDb()
  const total = conversations.length
  for (let i = 0; i < total; i++) {
    if (signal?.aborted) break
    const conv = conversations[i]
    const sessionId = `${conv.source}-${safeId(conv.id)}`
    try {
      if (getSession(sessionId)) {
        result.skippedSessions++
        onProgress?.({ done: i + 1, total, title: conv.title })
        continue
      }
      const planned = planNodes(conv.nodes)
      const msgId = (id: string): string => `${sessionId}_${safeId(id)}`
      const now = Date.now()
      const createdAt = conv.createdAt ?? planned[0]?.createdAt ?? now
      db.exec('BEGIN')
      try {
        createSession({
          id: sessionId,
          title: conv.title || conv.id,
          createdAt,
          updatedAt: conv.updatedAt ?? createdAt,
          meta: { source: `${conv.source}_export`, sourceId: conv.id }
        })
        const times = new Map<string, number>()
        const offsets = new Map<string, number>()
        let lastLeaf: { id: string; at: number } | null = null
        const hasChild = new Set(planned.map((p) => p.parent).filter(Boolean) as string[])
        for (const p of planned) {
          const key = p.parent ?? '#root'
          const off = (offsets.get(key) ?? 0) + 1
          offsets.set(key, off)
          const base = p.parent ? (times.get(p.parent) ?? createdAt) : createdAt
          const at = p.createdAt ?? base + off
          times.set(p.id, at)
          const node: MessageNode = {
            id: msgId(p.id),
            sessionId,
            parentId: p.parent ? msgId(p.parent) : null,
            role: p.role,
            content: p.content,
            ...(p.reasoning?.trim() ? { reasoningContent: p.reasoning } : {}),
            status: 'completed',
            createdAt: at,
            ...(p.model ? { meta: { model: p.model } } : {})
          }
          insertMessage(node)
          if (!hasChild.has(p.id) && (!lastLeaf || at >= lastLeaf.at)) lastLeaf = { id: p.id, at }
        }
        // 指定的活动叶子被跳过（空节点）时，沿原始父链找最近的被保留祖先
        let leaf: string | null = null
        const keptIds = new Set(planned.map((p) => p.id))
        const parentOf = new Map(conv.nodes.map((n) => [n.id, n.parent]))
        let cur = conv.activeLeaf ?? null
        const seen = new Set<string>()
        while (cur && !seen.has(cur)) {
          seen.add(cur)
          if (keptIds.has(cur)) {
            leaf = cur
            break
          }
          cur = parentOf.get(cur) ?? null
        }
        leaf = leaf ?? lastLeaf?.id ?? null
        const model = conv.model ?? planned.find((p) => p.model)?.model
        updateSession(sessionId, {
          activeLeafId: leaf ? msgId(leaf) : null,
          updatedAt: conv.updatedAt ?? lastLeaf?.at ?? createdAt,
          ...(model ? { model } : {})
        })
        db.exec('COMMIT')
        result.importedSessions++
        result.importedMessages += planned.length
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 事务已不存在 */
        }
        throw e
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      result.errors.push(`${conv.title || conv.id}: ${message}`)
      log.error('Failed to import conversation', {
        source: conv.source,
        id: conv.id,
        error: message
      })
    }
    onProgress?.({ done: i + 1, total, title: conv.title })
  }
  return result
}
