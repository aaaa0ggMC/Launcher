/**
 * 把线性分支（user / assistant / tool 节点交错）折成「轮次」：
 * 一条用户消息 + 其后连续的 assistant 步骤（含工具调用）= 一轮回答。
 * tool 节点不单独显示——结果已经记在对应 assistant 节点的 toolCalls[].result 里，
 * 只有找不到对应调用时（例如导入的数据）才把它当作孤立结果挂到当前轮次。
 */
import type { MessageNode, ToolCallItem, WorkflowRecord, WorkflowStepRecord } from '../types'

export interface UserTurn {
  kind: 'user'
  key: string
  message: MessageNode
}

export interface AssistantTurn {
  kind: 'assistant'
  key: string
  /** 本轮的 assistant 步骤（按顺序） */
  steps: MessageNode[]
  /** 找不到对应工具调用的 tool 结果节点 */
  orphanResults: MessageNode[]
  /** 本轮第一个节点的同级分支（重新生成产生的兄弟回答） */
  siblingIds?: string[]
  firstId: string
  lastId: string
  status: MessageNode['status']
  /** 本次运行的过程记录（挂在第一个 assistant 节点上；旧数据没有） */
  workflow?: WorkflowRecord
}

/**
 * 气泡里显示的「最终回答」：最后一步且没有发起工具调用。
 * 其余步骤（中间思考、工具调用、中间说明）都收进过程卡片。
 */
export function answerStep(turn: AssistantTurn): MessageNode | null {
  const last = turn.steps[turn.steps.length - 1]
  return last && !last.toolCalls?.length ? last : null
}

export function processSteps(turn: AssistantTurn): MessageNode[] {
  const answer = answerStep(turn)
  return answer ? turn.steps.slice(0, -1) : turn.steps
}

/** 是否需要过程卡片：有中间步骤、思考内容，或工作流有子 Agent / 说明步骤 */
export function hasProcess(turn: AssistantTurn): boolean {
  if (processSteps(turn).length > 0) return true
  if (answerStep(turn)?.reasoningContent) return true
  return Boolean(turn.workflow?.steps.some((s) => s.kind !== 'llm'))
}

export function toolCallCount(turn: AssistantTurn): number {
  return turn.steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0)
}

/**
 * 过程时间线的一项。llm 项的 `part` 决定显示哪部分：AI 说的话（content）不在过程卡片里，
 * 而是作为正文段落插在过程块之间（见 `turnSegments`），过程卡片只收思考与工具调用。
 */
export type ProcessItem =
  | {
      kind: 'llm'
      key: string
      node: MessageNode
      /** 是不是最终回答那一步（只有它的思考会进过程） */
      answer: boolean
      rec?: WorkflowStepRecord
      part: 'reasoning' | 'tools' | 'all'
    }
  | { kind: 'subagent' | 'note'; key: string; rec: WorkflowStepRecord }

/** 时间线：有过程记录就按记录顺序（含子 Agent），旧数据按节点顺序 */
export function processItems(turn: AssistantTurn): ProcessItem[] {
  const answer = answerStep(turn)
  const shown = new Set(processSteps(turn).map((n) => n.id))
  if (answer?.reasoningContent) shown.add(answer.id)
  const byId = new Map(turn.steps.map((n) => [n.id, n]))
  const llm = (node: MessageNode, rec?: WorkflowStepRecord): ProcessItem => ({
    kind: 'llm',
    key: node.id,
    node,
    answer: node.id === answer?.id,
    rec,
    part: 'all'
  })
  const rec = turn.workflow
  if (!rec) return turn.steps.filter((n) => shown.has(n.id)).map((n) => llm(n))
  const out: ProcessItem[] = []
  const used = new Set<string>()
  for (const s of rec.steps) {
    if (s.kind === 'llm') {
      const node = s.messageId ? byId.get(s.messageId) : undefined
      if (node && shown.has(node.id)) {
        out.push(llm(node, s))
        used.add(node.id)
      }
    } else out.push({ kind: s.kind, key: s.id, rec: s })
  }
  // 记录里漏掉的节点（理论上不会）补在末尾，保证内容不丢
  for (const n of turn.steps) if (shown.has(n.id) && !used.has(n.id)) out.push(llm(n))
  return out
}

export type TurnSegment =
  | { kind: 'process'; key: string; items: ProcessItem[] }
  | { kind: 'text'; key: string; node: MessageNode }

/**
 * 一轮回答的显示顺序：过程块（思考 / 工具 / 子 Agent）与 AI 中途说的话交错，
 * 最终回答不在这里（AssistantTurn 单独渲染在最后）。一步之内按模型输出顺序：
 * 思考 → 说的话 → 工具调用。
 */
export function turnSegments(turn: AssistantTurn): TurnSegment[] {
  const out: TurnSegment[] = []
  let block: ProcessItem[] = []
  const flush = (): void => {
    if (!block.length) return
    out.push({ kind: 'process', key: `p:${block[0].key}`, items: block })
    block = []
  }
  for (const item of processItems(turn)) {
    if (item.kind !== 'llm') {
      block.push(item)
      continue
    }
    const n = item.node
    const text = !item.answer && n.content?.trim()
    const tools = !item.answer && !!n.toolCalls?.length
    if (!text) {
      if (n.reasoningContent || tools) block.push({ ...item, part: 'all' })
      continue
    }
    if (n.reasoningContent) block.push({ ...item, key: `${item.key}:r`, part: 'reasoning' })
    flush()
    out.push({ kind: 'text', key: `t:${n.id}`, node: n })
    if (tools) block.push({ ...item, key: `${item.key}:t`, part: 'tools' })
  }
  flush()
  return out
}

export type Turn = UserTurn | AssistantTurn

export function buildTurns(branch: MessageNode[]): Turn[] {
  const turns: Turn[] = []
  let current: AssistantTurn | null = null
  const knownCalls = new Set<string>()

  for (const node of branch) {
    if (node.role === 'user') {
      current = null
      turns.push({ kind: 'user', key: node.id, message: node })
      continue
    }
    if (node.role === 'system') continue
    if (!current) {
      current = {
        kind: 'assistant',
        key: node.id,
        steps: [],
        orphanResults: [],
        siblingIds: node.siblingIds,
        firstId: node.id,
        lastId: node.id,
        status: node.status,
        workflow: node.meta?.workflow
      }
      turns.push(current)
    }
    current.lastId = node.id
    if (node.role === 'assistant') {
      for (const c of node.toolCalls ?? []) knownCalls.add(c.id)
      current.steps.push(node)
      current.status = node.status
    } else if (node.role === 'tool' && !(node.toolCallId && knownCalls.has(node.toolCallId))) {
      current.orphanResults.push(node)
    }
  }
  return turns
}

/** 工具参数的一行摘要（折叠态显示），优先取 command / path / url 这类关键字段 */
export function summarizeArgs(call: ToolCallItem, max = 80): string {
  const args = call.args
  let text: string
  if (typeof args === 'string') text = args
  else {
    const key = ['command', 'path', 'url', 'query'].find((k) => typeof args[k] === 'string')
    text = key ? String(args[key]) : JSON.stringify(args)
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 本轮回答的可复制纯文本（各步骤正文拼接） */
export function turnText(turn: AssistantTurn): string {
  return turn.steps
    .map((s) => s.content?.trim())
    .filter(Boolean)
    .join('\n\n')
}
