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
  /** 用户拒绝时给的理由（已作为工具结果回传给模型） */
  rejectReason?: string
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
  /** 扩展字段；`workflow` = 本次运行的过程记录（只挂在一次运行的第一个 assistant 节点上） */
  meta?: MessageMeta
}

export interface MessageMeta {
  workflow?: WorkflowRecord
  /** 生成这条 assistant 回答时实际使用的模型 / 服务商 id（会话中途换模型也能追溯） */
  model?: string
  provider?: string
  [key: string]: unknown
}

/** 工作流过程记录里的一步 */
export interface WorkflowStepRecord {
  id: string
  /** 执行者：'main' = 写入对话的主 Agent；其余为子 Agent 名（如 'planner'） */
  agent: string
  /** llm = 写进对话的一步（messageId 指向该 assistant 节点）；subagent = 不进对话的子 Agent 调用；note = 说明 */
  kind: 'llm' | 'subagent' | 'note'
  /** 已翻译的显示名 */
  label: string
  /** 子 Agent 输出 / 说明正文（Markdown） */
  detail?: string
  messageId?: string
  /** 这一步调用的模型 */
  model?: string
  status: 'running' | 'ok' | 'error'
  startedAt: number
  ms?: number
  tokens?: number
}

export interface WorkflowRecord {
  runId: string
  workflowId: string
  /** 已翻译的显示名 */
  label: string
  status: 'running' | 'ok' | 'error' | 'stopped'
  startedAt: number
  endedAt?: number
  steps: WorkflowStepRecord[]
  /** 本次运行所有 LLM 调用的 tokens 合计（拿不到 usage 时为 0） */
  tokens: number
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
  /** 新会话默认使用的工作流 id（缺省 'agent'），见 `yaya.workflows-list` */
  defaultWorkflow?: string
  /** 被用户禁用的工具名（缺省 = 全部启用） */
  disabledTools?: string[]
  /**
   * 逐工具审批覆盖：'ask' = 每次都要确认，'auto' = 直接执行；缺省 = 工具提供方的默认值。
   * 显式覆盖优先于全局 `autoApproveTools`（用户点名要确认的工具，开了全局自动也照样确认）。
   */
  toolApproval?: Record<string, ToolApprovalMode>
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

export type ToolApprovalMode = 'ask' | 'auto'

/** `yaya.tools-list` 的条目（给设置页 / agent 看的工具清单） */
export interface ToolInfo {
  name: string
  description: string
  /** 提供方默认是否需要确认（`defaultApproval !== 'auto'`），保留给旧调用方 */
  requiresApproval: boolean
  /**
   * 提供方默认：ask = 总要确认；auto = 直接执行；dynamic = 按参数判断
   * （如 cockpit_command 只对需授权的命令确认）
   */
  defaultApproval: 'ask' | 'auto' | 'dynamic'
  /** 用户覆盖（来自 `toolApproval`）；undefined = 跟随默认 */
  approval?: ToolApprovalMode
  source: 'builtin' | 'mcp' | 'custom'
  enabled: boolean
}

/** `yaya.workflows-list` 的条目 */
export interface WorkflowInfo {
  id: string
  /** 已按当前语言翻译 */
  label: string
  description: string
  /** 是否会调用工具（纯对话类 workflow 为 false） */
  usesTools: boolean
}
