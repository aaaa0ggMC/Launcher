import type { ToolCallItem, MessageAttachment, ReasoningEffort, TokenUsage } from '../../types'

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: ToolCallItem[]
  attachments?: MessageAttachment[]
}

/** 发给模型的工具声明（名字是 wire name） */
export interface ProviderTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ProviderGenerateOptions {
  model: string
  messages: ProviderMessage[]
  tools?: ProviderTool[]
  stream?: boolean
  temperature?: number
  /** 思考强度（缺省 default = 不发参数） */
  reasoning?: ReasoningEffort
  signal?: AbortSignal
  onToken?: (token: string) => void
  onReasoning?: (thought: string) => void
  onToolCall?: (call: ToolCallItem) => void
}

export interface ProviderGenerateResult {
  content: string
  reasoningContent?: string
  toolCalls?: ToolCallItem[]
  usage?: TokenUsage
}

export interface AIProvider {
  id: string
  generate(options: ProviderGenerateOptions): Promise<ProviderGenerateResult>
  listModels?(): Promise<string[]>
}
