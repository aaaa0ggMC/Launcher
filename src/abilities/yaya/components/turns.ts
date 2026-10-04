/**
 * 把线性分支（user / assistant / tool 节点交错）折成「轮次」：
 * 一条用户消息 + 其后连续的 assistant 步骤（含工具调用）= 一轮回答。
 * tool 节点不单独显示——结果已经记在对应 assistant 节点的 toolCalls[].result 里，
 * 只有找不到对应调用时（例如导入的数据）才把它当作孤立结果挂到当前轮次。
 */
import type { MessageNode, ToolCallItem } from '../types'

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
        status: node.status
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
