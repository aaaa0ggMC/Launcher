/**
 * 会话用量统计（`yaya.session-usage`）：token（输入 / 缓存命中 / 输出 / 推理，按模型）、
 * 每次模型调用的上下文大小、工具调用（按工具汇总 + 明细，带风险等级）、每次运行。
 * 纯函数，数据来自会话的全部消息节点（含其它分支：花掉的 token 都算），每项标记是否在当前分支上。
 */
import type { MessageNode, ToolCallItem } from '../types'
import { summarizeArgs } from '../components/turns'

/** 风险：工具提供方默认要确认 = high；按参数判断 = medium；直接执行 = low；工具已不存在 = unknown */
export type ToolRisk = 'high' | 'medium' | 'low' | 'unknown'

export interface UsageCall {
  messageId: string
  at: number
  model: string
  prompt: number
  completion: number
  cached: number
  reasoning: number
  total: number
  /** 在当前分支上 */
  active: boolean
}

export interface UsageModel {
  model: string
  calls: number
  prompt: number
  completion: number
  cached: number
  total: number
}

export interface UsageTool {
  name: string
  risk: ToolRisk
  count: number
  ok: number
  failed: number
  rejected: number
  ms: number
}

export interface UsageToolCall {
  id: string
  messageId: string
  at: number
  name: string
  risk: ToolRisk
  status: 'success' | 'failed' | 'rejected' | 'pending'
  summary: string
  ms?: number
  rejectReason?: string
  active: boolean
}

export interface UsageRun {
  runId: string
  label: string
  startedAt: number
  endedAt?: number
  status: string
  tokens: number
  steps: number
  active: boolean
}

export interface SessionUsage {
  totals: {
    prompt: number
    completion: number
    total: number
    cached: number
    reasoning: number
    /** 有 usage 的主 Agent 调用次数 */
    calls: number
    /** 子 Agent（规划等）的 token（只有合计，没有输入 / 输出拆分） */
    subagentTokens: number
    toolCalls: number
    runs: number
  }
  models: UsageModel[]
  calls: UsageCall[]
  tools: UsageTool[]
  toolLog: UsageToolCall[]
  runs: UsageRun[]
  /** 明细是否被截断（只保留最近的 MAX_LOG 条） */
  truncated: boolean
}

const MAX_LOG = 1000

function callStatus(c: ToolCallItem): UsageToolCall['status'] {
  if (c.rejectReason) return 'rejected'
  if (c.status === 'success') return 'success'
  if (c.status === 'failed') {
    return /rejected|拒绝/i.test(c.error ?? '') ? 'rejected' : 'failed'
  }
  return 'pending'
}

/**
 * @param messages 会话的全部节点
 * @param activeIds 当前分支上的节点 id
 * @param riskOf 工具 wire name → 风险
 * @param onlyActive 只统计当前分支
 */
export function computeSessionUsage(
  messages: MessageNode[],
  activeIds: Set<string>,
  riskOf: (name: string) => ToolRisk,
  onlyActive = false
): SessionUsage {
  const nodes = [...messages]
    .filter((m) => !onlyActive || activeIds.has(m.id))
    .sort((a, b) => a.createdAt - b.createdAt)

  const totals: SessionUsage['totals'] = {
    prompt: 0,
    completion: 0,
    total: 0,
    cached: 0,
    reasoning: 0,
    calls: 0,
    subagentTokens: 0,
    toolCalls: 0,
    runs: 0
  }
  const models = new Map<string, UsageModel>()
  const tools = new Map<string, UsageTool>()
  const calls: UsageCall[] = []
  const toolLog: UsageToolCall[] = []
  const runs: UsageRun[] = []

  for (const m of nodes) {
    if (m.role !== 'assistant') continue
    const active = activeIds.has(m.id)
    const u = m.usage
    if (u && (u.total || u.prompt || u.completion)) {
      const model = m.meta?.model ?? ''
      const call: UsageCall = {
        messageId: m.id,
        at: m.createdAt,
        model,
        prompt: u.prompt ?? 0,
        completion: u.completion ?? 0,
        cached: u.cached ?? 0,
        reasoning: u.reasoning ?? 0,
        total: u.total || (u.prompt ?? 0) + (u.completion ?? 0),
        active
      }
      calls.push(call)
      totals.calls++
      totals.prompt += call.prompt
      totals.completion += call.completion
      totals.cached += call.cached
      totals.reasoning += call.reasoning
      totals.total += call.total
      const mm = models.get(model) ?? {
        model,
        calls: 0,
        prompt: 0,
        completion: 0,
        cached: 0,
        total: 0
      }
      mm.calls++
      mm.prompt += call.prompt
      mm.completion += call.completion
      mm.cached += call.cached
      mm.total += call.total
      models.set(model, mm)
    }

    const rec = m.meta?.workflow
    if (rec) {
      totals.runs++
      const sub = rec.steps.reduce((n, s) => (s.kind === 'subagent' ? n + (s.tokens ?? 0) : n), 0)
      totals.subagentTokens += sub
      totals.total += sub
      runs.push({
        runId: rec.runId,
        label: rec.label,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        status: rec.status,
        tokens: rec.tokens,
        steps: rec.steps.length,
        active
      })
    }

    for (const c of m.toolCalls ?? []) {
      const risk = riskOf(c.name)
      const status = callStatus(c)
      totals.toolCalls++
      const tt = tools.get(c.name) ?? {
        name: c.name,
        risk,
        count: 0,
        ok: 0,
        failed: 0,
        rejected: 0,
        ms: 0
      }
      tt.count++
      if (status === 'success') tt.ok++
      else if (status === 'failed') tt.failed++
      else if (status === 'rejected') tt.rejected++
      tt.ms += c.ms ?? 0
      tools.set(c.name, tt)
      toolLog.push({
        id: c.id,
        messageId: m.id,
        at: m.createdAt,
        name: c.name,
        risk,
        status,
        summary: summarizeArgs(c, 120),
        ...(c.ms !== undefined ? { ms: c.ms } : {}),
        ...(c.rejectReason ? { rejectReason: c.rejectReason.slice(0, 200) } : {}),
        active
      })
    }
  }

  const truncated = toolLog.length > MAX_LOG
  return {
    totals,
    models: [...models.values()].sort((a, b) => b.total - a.total),
    calls,
    tools: [...tools.values()].sort((a, b) => b.count - a.count),
    toolLog: truncated ? toolLog.slice(-MAX_LOG) : toolLog,
    runs,
    truncated
  }
}
