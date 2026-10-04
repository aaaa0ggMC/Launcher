/**
 * YAYA Loop 核心定义与上下文契约
 */
import type { ToolCallItem, ToolDefinition, YayaConfig } from '../../types'
import type { AIProvider } from '../providers/types'

export type WorkflowStatus =
  | 'idle'
  | 'pending'
  | 'streaming'
  | 'tool_executing'
  | 'waiting_approval'
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
}

export interface LoopContext {
  sessionId: string
  assistantMessageId: string
  userMessageId: string
  config: YayaConfig
  provider: AIProvider
  tools: ToolDefinition[]
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
