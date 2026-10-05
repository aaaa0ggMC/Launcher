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
  /** 工具产出的图片（会话资产 URI），界面显示缩略图 */
  images?: string[]
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
  usage?: TokenUsage
  /**
   * 同级分支（同一 parent 的全部子节点 id，按创建时间）。仅 `yaya.messages-branch`
   * 返回时附带，不落库；长度 > 1 时界面显示 `< i/n >` 翻页器。
   */
  siblingIds?: string[]
  /** 扩展字段；`workflow` = 本次运行的过程记录（只挂在一次运行的第一个 assistant 节点上） */
  meta?: MessageMeta
}

export interface TokenUsage {
  prompt: number
  completion: number
  total: number
  /** 输入里命中提示词缓存的部分（端点给了才有） */
  cached?: number
  /** 输出里的推理 / 思考 token（端点给了才有） */
  reasoning?: number
}

/** 思考强度：default = 不发参数（模型默认）；off = 尽量不思考 */
export type ReasoningEffort = 'default' | 'off' | 'low' | 'medium' | 'high'
/** 思考参数的格式（各家不统一）；auto = 按服务商地址猜 */
export type ReasoningStyle =
  'auto' | 'openai' | 'deepseek' | 'qwen' | 'openrouter' | 'llamacpp' | 'none'

/** 批准的范围：once = 这一次；run = 本次执行里同一工具不再询问；session = 本对话都不再询问 */
export type ApprovalScope = 'once' | 'run' | 'session'

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
  /** 思考强度参数的格式（缺省 auto） */
  reasoningStyle?: ReasoningStyle
}

export type McpTransport = 'streamable-http' | 'sse'

export interface McpServerConfig {
  /** 稳定 id（插件 id = `mcp-<id>`，工具前缀由它派生），创建后不改 */
  id: string
  name: string
  transport: McpTransport
  url: string
  /**
   * 自定义请求头（如 Authorization / X-Api-Key）。值加密落盘；`yaya.config-get` 不回传值，
   * 只回传 `headersSet`（已设置的头名）。保存时值为空串 = 保留原值；`clearHeaders` 里的头名删除。
   */
  headers?: Record<string, string>
  /** 仅 config-get 返回 */
  headersSet?: string[]
  /** 仅 config-save 入参 */
  clearHeaders?: string[]
  enabled: boolean
  /** 单次工具调用超时（缺省 60000） */
  timeoutMs?: number
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
  /** 插件启用覆盖：缺省 = 插件自己的 defaultEnabled（插件 id → 是否启用） */
  pluginEnabled?: Record<string, boolean>
  /**
   * 插件配置值（插件 id → key → 值）。schema 里 `secret` 的字段加密落盘；`yaya.config-get`
   * 不回传它们的值，只回传 `pluginSecretsSet`。保存时 secret 为空串 = 沿用旧值，
   * `pluginClearSecrets` 里的 `<插件 id>/<key>` 删除。
   */
  pluginConfig?: Record<string, Record<string, unknown>>
  /** 仅 config-get 返回：插件 id → 已设置的 secret key */
  pluginSecretsSet?: Record<string, string[]>
  /** 仅 config-save 入参：要清除的 secret，`<插件 id>/<key>` */
  pluginClearSecrets?: string[]
  /** 子分组启用覆盖：`<插件 id>/<分组 id>` → 是否启用（缺省 = 分组的 defaultEnabled） */
  pluginGroupEnabled?: Record<string, boolean>
  /** Skill 目录（缺省 ~/.config/LinuxCockpit/yaya/skills） */
  skillsDir?: string
  /** 被用户禁用的工具（按 wire name 记，缺省 = 全部启用） */
  disabledTools?: string[]
  /**
   * 逐工具审批覆盖：'ask' = 每次都要确认，'auto' = 直接执行；缺省 = 工具提供方的默认值。
   * 显式覆盖优先于全局 `autoApproveTools`（用户点名要确认的工具，开了全局自动也照样确认）。
   */
  toolApproval?: Record<string, ToolApprovalMode>
  /** 新会话默认的思考强度（会话可单独覆盖，存 session.meta.reasoning） */
  reasoningEffort?: ReasoningEffort
  /**
   * 过程卡片收起时仍显示最近几步的预览（默认 1，0–5，0 = 完全折叠）。
   */
  processPreviewSteps?: number
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
