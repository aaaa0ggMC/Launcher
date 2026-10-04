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
  status?: 'pending' | 'executing' | 'success' | 'failed'
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
}

export interface MessageTreeNode extends MessageNode {
  children: MessageTreeNode[]
}

export interface ProviderConfig {
  id: string
  name: string
  type: 'openai' | 'codex-proxy' | 'anthropic' | 'gemini' | 'ollama'
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
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
  activeProviderId: string
  activeModel: string
  systemPrompt: string
  autoApproveTools: boolean
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
  requiresApproval?: boolean
  source?: 'builtin' | 'mcp' | 'custom'
}

export interface ToolExecutionContext {
  sessionId: string
  signal?: AbortSignal
  onProgress?: (progress: unknown) => void
}
