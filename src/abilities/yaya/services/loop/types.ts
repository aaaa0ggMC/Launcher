/**
 * YAYA Loop 核心定义与上下文契约
 */
import type { ToolCallItem, YayaConfig } from '../../types'
import type { AIProvider } from '../providers/types'

export type WorkflowStatus =
  | 'idle'
  | 'pending'
  | 'streaming'
  | 'tool_executing'
  | 'waiting_approval'
  /** 用户在 AgentBar 上暂停了 */
  | 'paused'
  | 'completed'
  | 'interrupted'
  | 'error'

export interface WorkflowSnapshot {
  sessionId: string
  messageId: string
  status: WorkflowStatus
  currentStep: number
  maxSteps: number
  pendingApprovalTool?: ToolCallItem
  bufferedTokens: string
  bufferedReasoning: string
  startedAt: number
  /** 模型请求出错、正在等待自动重试（重试成功或放弃后清掉） */
  retry?: WorkflowRetry
}

export interface WorkflowRetry {
  /** 第几次重试（从 1 开始） */
  attempt: number
  max: number
  /** 预计什么时候重试（ms 时间戳） */
  at: number
  /** 出错原因（简短） */
  error: string
}

export interface LoopContext {
  sessionId: string
  assistantMessageId: string
  userMessageId: string
  config: YayaConfig
  provider: AIProvider
  tools: unknown[]
  step: number
  maxSteps: number
  signal?: AbortSignal
  status: WorkflowStatus
  pendingApprovalTool?: ToolCallItem
  // 环形事件缓存，用于断线重放
  ringBuffer: string[]
  onUpdate?: (snapshot: WorkflowSnapshot) => void
}

export interface AgentStepResult {
  done: boolean
  content: string
  reasoningContent?: string
  toolCalls?: ToolCallItem[]
  error?: string
}
