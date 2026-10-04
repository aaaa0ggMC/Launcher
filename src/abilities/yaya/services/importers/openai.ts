/**
 * OpenAI (ChatGPT) 导出会话数据导入器
 * 将 ChatGPT 的 conversations.json 树状数据无缝迁移至 YAYA SQLite。
 *
 * 加固点（相对早期版本）：
 *  - 重复导入同一会话直接跳过（主键冲突不再让整批失败）；
 *  - 被跳过的 system / 空节点的子节点 re-parent 到最近的被保留祖先，分支不断；
 *  - 按树顺序（BFS）插入，保证父先于子；
 *  - 导入结束后显式把 activeLeafId 设回 current_node（若被跳过则取其最近的被保留祖先），
 *    updatedAt 还原成会话原始的 update_time（insertMessage 每次都会改这两个字段）；
 *  - 非文本 part（图片等）用占位文本提示，不再静默丢弃；
 *  - create_time 缺失时沿父节点时间 +1ms 递增，避免全部消息同一时刻；
 *  - 单个会话的所有写入包在一个 SQLite 事务里，失败整条回滚并记入 errors。
 */
import { randomUUID } from 'node:crypto'
import { createSession, getSession, getYayaDb, insertMessage, updateSession } from '../db'
import { makeLogger } from '../../../../main/process/logger'
import { t } from '../../../../main/process/i18n'
import type { MessageNode } from '../../types'

const log = makeLogger('yaya-importer-openai')

interface OpenAiExportNode {
  id: string
  parent: string | null
  children: string[]
  message?: {
    id: string
    author: { role: string; name?: string }
    create_time: number | null
    content?: {
      content_type: string
      parts?: (string | unknown)[]
      text?: string
    }
    metadata?: Record<string, unknown>
    status?: string
  }
}

interface OpenAiConversation {
  id: string
  title: string
  create_time: number
  update_time: number
  mapping: Record<string, OpenAiExportNode>
  current_node?: string
}

export interface ImportProgress {
  /** 已处理的会话数 */
  done: number
  /** 总会话数 */
  total: number
  title?: string
}

export interface ImportResult {
  importedSessions: number
  skippedSessions: number
  importedMessages: number
  errors: string[]
}

const ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'tool'])

type OpenAiMessage = NonNullable<OpenAiExportNode['message']>

function placeholderText(): string {
  return t('yaya.io.placeholder_image', '[图片/附件未导入]')
}

function normalizeRole(role: unknown): MessageNode['role'] {
  return typeof role === 'string' && ROLES.has(role) ? (role as MessageNode['role']) : 'assistant'
}

/** 输入可以是 conversations.json 数组，也可以是单个带 mapping 的对象 */
function normalizeInput(input: unknown): unknown[] {
  if (Array.isArray(input)) return input
  if (input && typeof input === 'object' && 'mapping' in (input as Record<string, unknown>)) {
    return [input]
  }
  throw new Error(
    t(
      'yaya.io.err_import_invalid',
      '导入数据格式不正确：需要 ChatGPT 的 conversations.json（数组，或单个带 mapping 的会话对象）'
    )
  )
}

/** 从 parts 里拼出文本；非字符串 part 记数，供占位提示用 */
function extractContent(msg: OpenAiMessage): string {
  const parts = msg.content?.parts
  if (Array.isArray(parts)) {
    const texts: string[] = []
    let nonText = 0
    for (const p of parts) {
      if (typeof p === 'string') {
        if (p) texts.push(p)
      } else if (p !== null && p !== undefined) {
        nonText++
      }
    }
    const joined = texts.join('\n')
    if (joined) return joined
    // 只有图片 / 音频等非文本 part：留一句占位，别让用户以为内容丢了
    return nonText > 0 ? placeholderText() : ''
  }
  if (typeof msg.content?.text === 'string') return msg.content.text
  return ''
}

/** 秒 → 毫秒；缺失 / 非法时用 fallback */
function toMs(seconds: number | null | undefined, fallback: number): number {
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return Math.floor(seconds * 1000)
  }
  return fallback
}

/** 计划插入的节点（parent 已 re-parent 到被保留的祖先） */
interface PlannedNode {
  id: string
  parent: string | null
  message: OpenAiMessage
}

/**
 * 把一个会话的 mapping 变成「按树顺序、父先于子」的待插入列表：
 * 1) 挑出要保留的节点（有 message、非 system、有内容）；
 * 2) 被跳过节点的子节点 re-parent 到最近的被保留祖先；
 * 3) 从根 BFS 拓扑排序，环 / 不可达节点兜底排在最后。
 */
function planConversation(conv: OpenAiConversation): PlannedNode[] {
  const rawParents = new Map<string, string | null>()
  for (const [nodeId, node] of Object.entries(conv.mapping)) {
    rawParents.set(nodeId, node?.parent ?? null)
  }

  const kept: PlannedNode[] = []
  for (const [nodeId, node] of Object.entries(conv.mapping)) {
    const msg = node?.message
    if (!msg || !msg.author || msg.author.role === 'system') continue
    const content = extractContent(msg)
    // 空节点（既无文本也无非文本 part）不入库，和旧版行为保持一致
    if (!content) continue
    kept.push({ id: nodeId, parent: rawParents.get(nodeId) ?? null, message: msg })
  }

  const keptIds = new Set(kept.map((k) => k.id))

  // re-parent：父节点被跳过 → 沿父链上溯到最近的被保留祖先
  for (const k of kept) {
    let parent = k.parent
    const seen = new Set<string>()
    while (parent && !keptIds.has(parent) && !seen.has(parent)) {
      seen.add(parent)
      parent = rawParents.get(parent) ?? null
    }
    k.parent = parent && keptIds.has(parent) ? parent : null
  }

  // BFS 拓扑排序（父先于子）
  const byParent = new Map<string | null, PlannedNode[]>()
  for (const k of kept) {
    const arr = byParent.get(k.parent) ?? []
    arr.push(k)
    byParent.set(k.parent, arr)
  }
  const ordered: PlannedNode[] = []
  const visited = new Set<string>()
  const queue: PlannedNode[] = [...(byParent.get(null) ?? [])]
  while (queue.length) {
    const cur = queue.shift()!
    if (visited.has(cur.id)) continue
    visited.add(cur.id)
    ordered.push(cur)
    for (const kid of byParent.get(cur.id) ?? []) queue.push(kid)
  }
  for (const k of kept) if (!visited.has(k.id)) ordered.push(k)

  return ordered
}

/**
 * 导入一批 ChatGPT 会话。
 *
 * `onProgress` 在每个会话处理完后回调一次；`signal` 用于在会话之间中断
 * （后台任务面板「停止」即经 AbortController 传进来）。
 */
export function importOpenAiConversations(
  list: unknown[],
  onProgress?: (p: ImportProgress) => void,
  signal?: AbortSignal
): ImportResult {
  const conversations = normalizeInput(list)
  const result: ImportResult = {
    importedSessions: 0,
    skippedSessions: 0,
    importedMessages: 0,
    errors: []
  }
  const db = getYayaDb()

  for (let i = 0; i < conversations.length; i++) {
    if (signal?.aborted) break
    const conv = conversations[i] as OpenAiConversation | null | undefined
    try {
      if (!conv || typeof conv !== 'object' || !conv.mapping || typeof conv.mapping !== 'object') {
        throw new Error(
          t('yaya.io.err_import_invalid', '导入数据格式不正确：需要带 mapping 的会话对象')
        )
      }

      const title = conv.title || t('yaya.io.import_default_title', '导入的 ChatGPT 会话')
      const sessionId = conv.id || randomUUID()

      // 已存在 → 跳过（否则主键冲突会让整批导入失败）
      if (getSession(sessionId)) {
        result.skippedSessions++
        log.info('skip existing conversation', { id: sessionId })
        onProgress?.({ done: i + 1, total: conversations.length, title })
        continue
      }

      db.exec('BEGIN')
      try {
        createSession({
          id: sessionId,
          title,
          createdAt: toMs(conv.create_time, Date.now()),
          updatedAt: toMs(conv.update_time, Date.now()),
          activeLeafId: conv.current_node ?? null,
          meta: { source: 'openai_export', sourceId: conv.id ?? '' }
        })
        const planned = planConversation(conv)
        const messages = insertPlannedMessages(sessionId, planned)

        // current_node 自己被跳过时，指向最近的被保留祖先
        const activeLeafId = resolveActiveLeaf(conv, planned)
        updateSession(sessionId, {
          activeLeafId,
          // insertMessage 会把 updated_at 写成消息时间，这里还原成原始 update_time
          updatedAt: toMs(conv.update_time, Date.now())
        })
        db.exec('COMMIT')

        result.importedSessions++
        result.importedMessages += messages.length
        log.info('imported conversation', {
          id: sessionId,
          title,
          messages: messages.length,
          leaf: activeLeafId
        })
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // 事务已不存在（例如 BEGIN 本身就失败了）
        }
        throw e
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      result.errors.push(`${conv?.title ?? conv?.id ?? '?'}: ${message}`)
      log.error('Failed to import conversation', { id: conv?.id, error: message })
    }
    onProgress?.({ done: i + 1, total: conversations.length, title: conv?.title })
  }

  return result
}

/**
 * current_node 指向的活动叶子：本节点被保留就直接用；
 * 被跳过（system / 空节点）则沿原始 parent 链上溯到最近的被保留祖先。
 */
function resolveActiveLeaf(conv: OpenAiConversation, planned: PlannedNode[]): string | null {
  const current = conv.current_node
  if (!current) return null
  const kept = new Set(planned.map((n) => n.id))
  if (kept.has(current)) return current

  const seen = new Set<string>()
  let cur: string | null = current
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    if (kept.has(cur)) return cur
    cur = conv.mapping[cur]?.parent ?? null
  }
  return null
}

/** 按计划顺序插入消息，返回实际写入的节点（父先于子） */
function insertPlannedMessages(sessionId: string, planned: PlannedNode[]): MessageNode[] {
  const out: MessageNode[] = []
  const created = new Map<string, number>()
  const tsOffset = new Map<string, number>()
  let model: string | undefined

  for (const p of planned) {
    // create_time 缺失 → 父节点时间 +1ms 递增（同一父节点下逐个错开）
    const parentTime = p.parent !== null ? (created.get(p.parent) ?? Date.now()) : Date.now()
    const key = p.parent ?? '#root'
    const offset = (tsOffset.get(key) ?? 0) + 1
    tsOffset.set(key, offset)
    const createdAt = toMs(p.message.create_time, parentTime + offset)
    if (!model && p.message.metadata?.model_slug) model = String(p.message.metadata.model_slug)

    const node: MessageNode = {
      id: p.id,
      sessionId,
      parentId: p.parent,
      role: normalizeRole(p.message.author.role),
      content: extractContent(p.message),
      status: 'completed',
      createdAt
    }
    insertMessage(node)
    created.set(node.id, node.createdAt)
    out.push(node)
  }

  // insertMessage 会把 activeLeafId / updated_at 改掉，最后统一收敛
  if (model) updateSession(sessionId, { model })
  return out
}
