/**
 * YAYA (Yet Another Yes Agent) 核心领域模型与类型契约
 */

export interface Session {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  activeLeafId?: string | null
  model?: string
  providerId?: string
  systemPrompt?: string
  meta?: Record<string, unknown>
}

export interface MessageAttachment {
  id: string
  name: string
  mimeType: string
  size: number
  assetPath: string
  summary?: string
}

export interface ToolCallItem {
  id: string
  name: string
  args: Record<string, unknown> | string
  result?: unknown
  error?: string
  status?: 'pending' | 'awaiting_approval' | 'executing' | 'success' | 'failed'
  ms?: number
}

export interface MessageNode {
  id: string
  sessionId: string
  parentId: string | null
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  reasoningContent?: string
  toolCalls?: ToolCallItem[]
  toolCallId?: string
  name?: string
  attachments?: MessageAttachment[]
  status?:
    | 'pending'
    | 'streaming'
    | 'tool_executing'
    | 'waiting_approval'
    | 'completed'
    | 'interrupted'
    | 'error'
  error?: string
  createdAt: number
  usage?: {
    prompt: number
    completion: number
    total: number
  }
  /**
   * 同级分支（同一 parent 的全部子节点 id，按创建时间）。仅 `yaya.messages-branch`
   * 返回时附带，不落库；长度 > 1 时界面显示 `< i/n >` 翻页器。
   */
  siblingIds?: string[]
}

export interface MessageTreeNode extends MessageNode {
  children: MessageTreeNode[]
}

/** 目前真正实现的协议都走 OpenAI 兼容接口；新增类型前先实现对应 Provider。 */
export type ProviderType = 'openai' | 'codex-proxy' | 'ollama'

export interface ProviderConfig {
  id: string
  name: string
  type: ProviderType
  baseUrl?: string
  /**
   * 明文仅存在于主进程内存。`yaya.config-get` 一律不回传（置空并给 `apiKeySet`）；
   * `yaya.config-save` 收到空值 = 保留原密钥，`clearApiKey: true` 才清空。
   */
  apiKey?: string
  /** 仅 config-get 返回：该 Provider 是否已设置密钥 */
  apiKeySet?: boolean
  /** 仅 config-save 入参：显式清空密钥 */
  clearApiKey?: boolean
  models: string[]
  defaultModel?: string
  enabled: boolean
}

export interface McpServerConfig {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  enabled: boolean
}

export interface YayaConfig {
  /** 助手显示名（页面顶部 / 消息署名 / 系统提示词里的 {name}），默认 YAYA */
  assistantName: string
  activeProviderId: string
  activeModel: string
  systemPrompt: string
  autoApproveTools: boolean
  /** 被用户禁用的工具名（缺省 = 全部启用） */
  disabledTools?: string[]
  maxLoopSteps: number
  streamOutput: boolean
  providers: ProviderConfig[]
  mcpServers: McpServerConfig[]
  headlessPort?: number
  headlessHost?: string
}

export type LoopEvent =
  | { type: 'start'; sessionId: string; messageId: string }
  | { type: 'thinking'; content: string }
  | { type: 'token'; chunk: string }
  | { type: 'tool_call'; tool: ToolCallItem }
  | { type: 'tool_result'; id: string; name: string; result: unknown; ok: boolean; ms: number }
  | { type: 'step'; step: number; maxSteps: number }
  | {
      type: 'done'
      messageId: string
      usage?: { prompt: number; completion: number; total: number }
    }
  | { type: 'error'; error: string }

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>
  /** true = 每次都要人工确认；函数 = 按本次参数判断 */
  requiresApproval?: boolean | ((args: Record<string, unknown>) => boolean)
  source?: 'builtin' | 'mcp' | 'custom'
}

export interface ToolExecutionContext {
  sessionId: string
  signal?: AbortSignal
  onProgress?: (progress: unknown) => void
}

/** `yaya.tools-list` 的条目（给设置页 / agent 看的工具清单） */
export interface ToolInfo {
  name: string
  description: string
  requiresApproval: boolean
  source: 'builtin' | 'mcp' | 'custom'
  enabled: boolean
}
