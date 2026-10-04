import type { ToolDefinition, ToolCallItem, MessageAttachment } from '../../types'

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: ToolCallItem[]
  attachments?: MessageAttachment[]
}

export interface ProviderGenerateOptions {
  model: string
  messages: ProviderMessage[]
  tools?: ToolDefinition[]
  stream?: boolean
  temperature?: number
  signal?: AbortSignal
  onToken?: (token: string) => void
  onReasoning?: (thought: string) => void
  onToolCall?: (call: ToolCallItem) => void
}

export interface ProviderGenerateResult {
  content: string
  reasoningContent?: string
  toolCalls?: ToolCallItem[]
  usage?: { prompt: number; completion: number; total: number }
}

export interface AIProvider {
  id: string
  generate(options: ProviderGenerateOptions): Promise<ProviderGenerateResult>
  listModels?(): Promise<string[]>
}
