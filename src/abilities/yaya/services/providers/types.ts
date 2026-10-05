import type { ToolCallItem, MessageAttachment, ReasoningEffort, TokenUsage } from '../../types'

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  toolCallId?: string
  toolCalls?: ToolCallItem[]
  attachments?: MessageAttachment[]
  /** 原生 Provider 上次返回的协议状态（思考签名等），只有同类 Provider + 同模型才会用它 */
  native?: NativeState
}

/**
 * 原生 Provider 需要原样回传的内容（Anthropic 的 thinking 块签名、Gemini 的 thoughtSignature）。
 * 存在 assistant 节点的 `meta.native` 上；换了 Provider 类型或模型就不再回传。
 */
export interface NativeState {
  /** Provider 类型（anthropic / gemini） */
  type: string
  model: string
  data: unknown
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
  native?: NativeState
}

export interface AIProvider {
  id: string
  generate(options: ProviderGenerateOptions): Promise<ProviderGenerateResult>
  listModels?(): Promise<string[]>
}
