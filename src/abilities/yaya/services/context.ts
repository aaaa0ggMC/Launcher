/**
 * 上下文管理：对话太长时丢弃或压缩较早的消息（设置 → 助手 → 上下文）。
 *
 * - `drop`：较早的消息不再发给模型，第一条保留的用户消息前加一句说明；
 * - `compress`：较早的消息由模型压缩成摘要（过程卡片里一个「压缩上下文」步骤），摘要拼在第一条
 *   保留的用户消息前；再次超出时把旧摘要和新切掉的部分一起再压缩一次。
 *
 * 提示词缓存：切点（boundary）记在会话 `meta.context` 里，之后每次请求都从同一个切点开始，
 * 前缀不变；只有再次超出预算才移动切点。切到预算的一半（留出余量），避免每条消息都重切。
 * 切点永远落在用户消息上（工具调用和结果不会被拆开），最近 `keepTurns` 轮永远保留。
 * token 是按字数估算的（中日韩字符 ≈ 1，其他 ≈ 4 字符 1 个），不是服务商的精确值。
 */
import type { MessageNode } from '../types'

export type ContextMode = 'off' | 'drop' | 'compress'

export interface ContextConfig {
  mode: ContextMode
  /** 上下文预算（估算 token）；0 = 按模型上下文长度的 75%（模型元数据），不知道时 96K */
  maxTokens: number
  /** 最近几轮（从用户消息算起）永远完整保留 */
  keepTurns: number
}

/** 存在会话 meta.context 上 */
export interface ContextState {
  /** 第一条保留的消息（一定是用户消息） */
  boundaryId: string
  /** compress 模式的摘要 */
  summary?: string
  /** 切点之前的消息数 */
  dropped: number
  mode: Exclude<ContextMode, 'off'>
  at: number
  /** 切之前 / 之后的估算 token（界面显示） */
  before: number
  after: number
}

export const DEFAULT_CONTEXT: ContextConfig = { mode: 'off', maxTokens: 0, keepTurns: 4 }
export const FALLBACK_BUDGET = 96_000
/** 摘要本身大约占的 token（选切点时预留） */
const SUMMARY_ALLOWANCE = 2_000
/** 切到预算的这个比例 */
const TARGET_RATIO = 0.5

export function normalizeContextConfig(raw: unknown): ContextConfig {
  const r = (raw ?? {}) as Partial<ContextConfig>
  const mode: ContextMode = r.mode === 'drop' || r.mode === 'compress' ? r.mode : 'off'
  const maxTokens = Number(r.maxTokens)
  const keepTurns = Number(r.keepTurns)
  return {
    mode,
    maxTokens:
      Number.isFinite(maxTokens) && maxTokens > 0
        ? Math.min(Math.max(Math.round(maxTokens), 4_000), 10_000_000)
        : 0,
    keepTurns:
      Number.isFinite(keepTurns) && keepTurns >= 1
        ? Math.min(Math.round(keepTurns), 50)
        : DEFAULT_CONTEXT.keepTurns
  }
}

export function resolveBudget(cfg: ContextConfig, contextWindow?: number): number {
  if (cfg.maxTokens > 0) return cfg.maxTokens
  if (contextWindow && contextWindow > 0) return Math.round(contextWindow * 0.75)
  return FALLBACK_BUDGET
}

const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g

/** 粗略估算 token：中日韩字符各算 1，其余每 4 个字符算 1 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK)?.length ?? 0
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/** 每张图片大致的 token */
const IMAGE_TOKENS = 1_000

export function estimateNode(n: MessageNode): number {
  let sum = 4 + estimateTokens(n.content ?? '')
  for (const c of n.toolCalls ?? [])
    sum += 8 + estimateTokens(typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}))
  sum += (n.attachments?.length ?? 0) * IMAGE_TOKENS
  if (n.role === 'user' && typeof n.meta?.mentionNote === 'string')
    sum += estimateTokens(n.meta.mentionNote)
  return sum
}

/** 状态在这条分支上是否有效：切点在分支里且是用户消息 */
export function boundaryIndex(
  nodes: MessageNode[],
  state: ContextState | null | undefined
): number {
  if (!state?.boundaryId) return -1
  const i = nodes.findIndex((n) => n.id === state.boundaryId)
  return i > 0 && nodes[i].role === 'user' ? i : -1
}

export interface ContextPlan {
  /** 新切点在 nodes 里的下标 */
  index: number
  /** 这次新切掉的消息（旧切点 → 新切点） */
  cut: MessageNode[]
  before: number
  after: number
}

/**
 * 是否需要（重新）切：现有切点下的估算超出预算才切。返回 null = 不用动。
 * `overhead` = 系统提示词 + 工具表的估算。
 */
export function planContext(
  nodes: MessageNode[],
  opts: {
    budget: number
    keepTurns: number
    overhead: number
    mode: Exclude<ContextMode, 'off'>
    state?: ContextState | null
  }
): ContextPlan | null {
  const users: number[] = []
  nodes.forEach((n, i) => {
    if (n.role === 'user') users.push(i)
  })
  if (users.length < 2) return null
  const protect = users[Math.max(0, users.length - opts.keepTurns)]
  const current = Math.max(0, boundaryIndex(nodes, opts.state))

  const sizes = nodes.map(estimateNode)
  // 后缀和：从 i 开始保留时的消息 token
  const suffix = new Array<number>(nodes.length + 1).fill(0)
  for (let i = nodes.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + sizes[i]
  const extra = (from: number): number =>
    from > 0 ? (opts.mode === 'compress' ? SUMMARY_ALLOWANCE : 50) : 0
  const est = (from: number): number => opts.overhead + suffix[from] + extra(from)

  if (est(current) <= opts.budget) return null
  const candidates = users.filter((i) => i > current && i <= protect)
  if (!candidates.length) return null
  const target = opts.budget * TARGET_RATIO
  const index = candidates.find((i) => est(i) <= target) ?? candidates[candidates.length - 1]
  return {
    index,
    cut: nodes.slice(current, index),
    before: est(0),
    after: est(index)
  }
}

/** 压缩用的系统提示词（固定英文，任何界面语言都一样） */
export const SUMMARY_SYSTEM = [
  'You compress the earlier part of a conversation between a user and an AI assistant so the',
  'assistant can continue it without the full history. Write a faithful, dense summary:',
  '- the user’s goals, requests, preferences and constraints, and decisions made;',
  '- facts, names, numbers, file paths, URLs, code identifiers and results that later turns may need;',
  '- what the assistant did (tools used and their important outcomes) and what is still open.',
  'Merge the previous summary (if given) with the new messages into one summary. Keep [[secret_…]]',
  'references verbatim. Do not add commentary, do not answer the user, do not invent anything.',
  'Write in the language the conversation mostly uses. Stay under 1200 words.'
].join('\n')

const ROLE: Record<string, string> = { user: 'User', assistant: 'Assistant', tool: 'Tool result' }

/** 把要压缩的消息排成纯文本记录；单条过长截断，整体超出 maxChars 时去掉中间 */
export function renderTranscript(
  nodes: MessageNode[],
  previousSummary: string | undefined,
  maxChars = 120_000
): string {
  const clip = (s: string, n: number): string =>
    s.length > n ? `${s.slice(0, n)} …[${s.length - n} chars omitted]` : s
  const parts: string[] = []
  for (const n of nodes) {
    const lines: string[] = []
    const body = (n.content ?? '').trim()
    if (body) lines.push(clip(body, n.role === 'tool' ? 2_000 : 8_000))
    for (const c of n.toolCalls ?? [])
      lines.push(
        `[calls ${c.name}(${clip(typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}), 600)})]`
      )
    if (n.attachments?.length) lines.push(`[${n.attachments.length} attachment(s)]`)
    if (!lines.length) continue
    parts.push(`${ROLE[n.role] ?? n.role}${n.name ? ` (${n.name})` : ''}:\n${lines.join('\n')}`)
  }
  let text = parts.join('\n\n')
  if (text.length > maxChars) {
    const half = Math.floor(maxChars / 2)
    text = `${text.slice(0, half)}\n\n…[middle of the conversation omitted]…\n\n${text.slice(-half)}`
  }
  const prev = previousSummary?.trim()
  return [
    prev ? `## Previous summary\n\n${prev}` : '',
    `## Messages to add to the summary\n\n${text}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 拼在第一条保留的用户消息前面的说明 */
export function contextPreamble(state: ContextState): string {
  if (state.mode === 'compress' && state.summary?.trim())
    return `[Summary of the earlier part of this conversation (${state.dropped} earlier messages were compressed):]\n${state.summary.trim()}\n\n[The conversation continues:]\n\n`
  return `[${state.dropped} earlier messages of this conversation were dropped to fit the context window.]\n\n`
}
