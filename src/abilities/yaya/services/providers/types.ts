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
  /** 打开模型自带的联网搜索（Gemini google_search / Claude web_search / OpenRouter web 等），见 search-mode.ts */
  builtinSearch?: boolean
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
  /** reasoningContent 是闭源模型给的思考摘要（Gemini / Claude / OpenAI），不是原始思维链 */
  reasoningSummary?: boolean
  /** 模型自带搜索的查询词与来源（打开 builtinSearch 且模型真的搜了才有） */
  search?: BuiltinSearchInfo
}

/** 模型自带搜索这一步搜了什么、引用了哪些网页（存到 assistant 节点的 `meta.search`） */
export interface BuiltinSearchInfo {
  queries: string[]
  sources: Array<{ url: string; title?: string }>
}

export interface AIProvider {
  id: string
  generate(options: ProviderGenerateOptions): Promise<ProviderGenerateResult>
  listModels?(): Promise<string[]>
}
