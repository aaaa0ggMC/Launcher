/**
 * YAYA 会话导出 — Markdown / JSONL
 *
 * 从 SQLite 消息树里取出会话内容，渲染成人类可读的 Markdown 或可再导入的
 * JSONL（一行一个 MessageNode）。两种格式都支持：
 *  - `branch`（默认）：只导出 active_leaf_id 指向的当前分支，即界面上看到的那条对话链；
 *  - `tree`：导出整棵消息树，按深度优先遍历全部分支，分支起点标注「分支 i/n」。
 */
import { makeLogger } from '../../../main/process/logger'
import { t, te } from '../../../main/process/i18n'
import { getMessageBranch, getSession, getSessionMessages } from './db'
import { loadYayaConfig } from './config'
import type { MessageNode, Session } from '../types'

const log = makeLogger('yaya-io')

/** 工具调用结果超过该长度即截断，避免导出文件被一条日志撑爆 */
const TOOL_RESULT_LIMIT = 4000

export type ExportScope = 'branch' | 'tree'

function resolveScope(scope?: string): ExportScope {
  return scope === 'tree' ? 'tree' : 'branch'
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}:${pad(d.getSeconds())}`
}

function formatSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function roleLabel(role: MessageNode['role'], assistantName: string): string {
  switch (role) {
    case 'user':
      return t('yaya.io.role_user', '用户')
    case 'assistant':
      return assistantName
    case 'tool':
      return t('yaya.io.role_tool', '工具')
    default:
      return t('yaya.io.role_system', '系统')
  }
}

/** 把任意值渲染进代码块：字符串原样，其余 JSON 美化 */
function renderValue(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2) ?? String(v)
  } catch {
    return String(v)
  }
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= TOOL_RESULT_LIMIT) return { text, truncated: false }
  return {
    text: text.slice(0, TOOL_RESULT_LIMIT),
    truncated: true
  }
}

interface Segment {
  /** 分支标注（tree 模式下出现分叉时才写） */
  label?: string
  messages: MessageNode[]
}

/**
 * 把消息集合切成一条条「连续对话段」：
 * 主线沿每个节点的第一个子节点往下走，其余子节点各自另起一段（= 一个分支起点）。
 */
function treeSegments(messages: MessageNode[]): Segment[] {
  const children = new Map<string, MessageNode[]>()
  const roots: MessageNode[] = []
  const present = new Set(messages.map((m) => m.id))

  for (const m of messages) {
    if (m.parentId && present.has(m.parentId)) {
      const arr = children.get(m.parentId) ?? []
      arr.push(m)
      children.set(m.parentId, arr)
    } else {
      roots.push(m)
    }
  }

  const byTime = (a: MessageNode, b: MessageNode): number =>
    a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  roots.sort(byTime)
  for (const arr of children.values()) arr.sort(byTime)

  if (!roots.length) return []

  // 标注总数 = 多根时的每个根 + 每个节点的额外子节点（与下方 DFS 自增顺序一致）
  let extra = 0
  for (const arr of children.values()) if (arr.length > 1) extra += arr.length - 1
  const total = (roots.length > 1 ? roots.length : 1) + extra
  const labelled = total > 1

  const segments: Segment[] = []
  let current: Segment | null = null
  let index = 0

  const walk = (node: MessageNode): void => {
    if (current) current.messages.push(node)
    else {
      index++
      current = {
        label: labelled
          ? te('yaya.io.branch_label', { i: String(index), n: String(total) }, '分支 {i}/{n}')
          : undefined,
        messages: [node]
      }
      segments.push(current)
    }
    const kids = children.get(node.id) ?? []
    if (kids.length) {
      walk(kids[0]) // 主线
      for (let i = 1; i < kids.length; i++) {
        current = null
        walk(kids[i])
      }
    }
  }

  for (const root of roots) {
    current = null
    walk(root)
  }
  return segments
}

/** tool 角色的消息按 toolCallId 归并到发起它的工具调用上 */
function collectToolResults(messages: MessageNode[]): Map<string, MessageNode> {
  const map = new Map<string, MessageNode>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) map.set(m.toolCallId, m)
  }
  return map
}

/** 被某个 assistant 消息的 toolCalls 引用的 tool 消息 id（不再单独成节） */
function consumedToolResults(
  messages: MessageNode[],
  toolResults: Map<string, MessageNode>
): Set<string> {
  const used = new Set<string>()
  for (const m of messages) {
    for (const call of m.toolCalls ?? []) {
      const hit = toolResults.get(call.id)
      if (hit) used.add(hit.id)
    }
  }
  return used
}

function renderMessageMarkdown(
  msg: MessageNode,
  index: number,
  ctx: { assistantName: string; toolResults: Map<string, MessageNode>; consumed: Set<string> }
): string {
  // 已并入某个 assistant 工具调用的 tool 消息不再单独成节
  if (msg.role === 'tool' && ctx.consumed.has(msg.id)) return ''

  const out: string[] = []
  out.push(`## ${index}. ${roleLabel(msg.role, ctx.assistantName)}`)
  if (msg.createdAt) out.push(`_${formatTime(msg.createdAt)}_`)

  const body = msg.content?.trim() ? msg.content.trim() : t('yaya.io.empty_message', '（空消息）')
  out.push('', body)

  if (msg.reasoningContent?.trim()) {
    out.push(
      '',
      `<details>`,
      `<summary>${t('yaya.io.section_reasoning', '思考过程')}</summary>`,
      '',
      msg.reasoningContent.trim(),
      '',
      `</details>`
    )
  }

  for (const call of msg.toolCalls ?? []) {
    const result = ctx.toolResults.get(call.id)
    out.push('', `**${t('yaya.io.tool_call', '工具')} \`${call.name ?? call.id ?? ''}\`**`)
    const status = [call.status, call.ms !== undefined ? `${call.ms} ms` : '']
      .filter(Boolean)
      .join(' · ')
    if (status) out.push(`_${status}_`)
    if (call.args !== undefined && call.args !== '') {
      out.push(
        '',
        `${t('yaya.io.section_tool_args', '参数')}：`,
        '```json',
        renderValue(call.args),
        '```'
      )
    }
    if (call.error) {
      out.push('', `${t('yaya.io.section_tool_error', '错误')}：`, '```', call.error, '```')
    }
    if (result) {
      const { text, truncated } = truncate(renderValue(result.content))
      out.push(
        '',
        `${t('yaya.io.section_tool_result', '结果')}：`,
        '```json',
        text + (truncated ? `\n\n${t('yaya.io.tool_result_truncated', '（结果过长已截断）')}` : ''),
        '```'
      )
    }
  }

  if (msg.attachments?.length) {
    out.push('', `**${t('yaya.io.section_attachments', '附件')}**`)
    for (const a of msg.attachments) {
      const size = formatSize(a.size)
      out.push(`- ${a.name}${size ? ` (${size})` : ''}`)
    }
  }

  // 没能归并到任何工具调用的 tool 消息：作为独立小节兜底输出
  if (msg.role === 'tool') {
    if (msg.name) out.push('', `_${msg.name}_`)
    if (msg.error) out.push('', '```', msg.error, '```')
  }

  return out.join('\n')
}

function loadSessionOrThrow(sessionId: string): Session {
  const session = getSession(sessionId)
  if (!session) {
    throw new Error(te('yaya.io.err_session_not_found', { id: sessionId }, '会话不存在: {id}'))
  }
  return session
}

function messagesFor(session: Session, scope: ExportScope): MessageNode[] {
  if (scope === 'tree') return getSessionMessages(session.id)
  return getMessageBranch(session.activeLeafId)
}

export function exportSessionMarkdown(sessionId: string, scope?: ExportScope): string {
  const sc = resolveScope(scope)
  const session = loadSessionOrThrow(sessionId)
  const messages = messagesFor(session, sc)
  const assistantName = loadYayaConfig().assistantName
  const toolResults = collectToolResults(messages)
  const consumed = consumedToolResults(messages, toolResults)

  const out: string[] = []
  out.push(`# ${session.title}`)
  out.push('')
  const meta: string[] = []
  if (session.model) meta.push(`${t('yaya.io.meta_model', '模型')}: ${session.model}`)
  if (session.providerId)
    meta.push(`${t('yaya.io.meta_provider', '服务商')}: ${session.providerId}`)
  meta.push(`${t('yaya.io.meta_exported_at', '导出于')}: ${formatTime(Date.now())}`)
  meta.push(
    `${t('yaya.io.meta_messages', '消息数')}: ${messages.length}（${
      sc === 'tree'
        ? t('yaya.io.meta_scope_tree', '全部分支')
        : t('yaya.io.meta_scope_branch', '当前分支')
    }）`
  )
  out.push(meta.map((m) => `- ${m}`).join('\n'))

  let index = 0
  for (const seg of treeSegments(messages)) {
    if (seg.label) out.push('', `### ${seg.label}`)
    for (const msg of seg.messages) {
      const block = renderMessageMarkdown(msg, index + 1, {
        assistantName,
        toolResults,
        consumed
      })
      // 被并入工具调用的 tool 消息不占序号
      if (!block) continue
      index++
      out.push('', block)
    }
  }

  const doc =
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  log.info('export markdown', {
    sessionId,
    scope: sc,
    messages: messages.length,
    bytes: doc.length
  })
  return doc
}

/** JSONL：第一行 session，之后一行一个 message（去掉 siblingIds 这类运行时字段） */
export function exportSessionJsonl(sessionId: string, scope?: ExportScope): string {
  const sc = resolveScope(scope)
  const session = loadSessionOrThrow(sessionId)
  const messages = messagesFor(session, sc)

  const lines: Record<string, unknown>[] = [{ type: 'session', ...session }]
  for (const msg of messages) {
    // siblingIds 只是 yaya.messages-branch 附带的运行时字段，不落库也不导出
    const node: MessageNode = { ...msg }
    delete node.siblingIds
    lines.push({ type: 'message', ...node })
  }

  const doc = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  log.info('export jsonl', { sessionId, scope: sc, lines: lines.length, bytes: doc.length })
  return doc
}
