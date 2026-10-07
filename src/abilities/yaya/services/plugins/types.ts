/**
 * YAYA 插件 SDK —— 后端契约。
 *
 * 插件 = 0..n 个工具 + 可选的系统提示词片段（instructions）+ 可选的生命周期。
 * 三种来源：
 * - builtin：随 YAYA 一起的插件，`src/abilities/yaya/plugins/<id>/index.ts` 默认导出 `YayaPlugin`
 *   （commands.ts 里 glob 自动注册，无需改任何注册表）；
 * - mcp：每个 MCP 服务器一个插件，由 MCP 提供方按配置动态生成；
 * - skill：每个 Skill 一个插件，由 Skill 提供方扫描目录动态生成。
 *
 * 渲染端对应的 UI 契约见 `components/plugin-ui.ts`（代码块渲染器 / 工具结果视图）。
 *
 * 提示词缓存规则（照 codex-proxy-node）：工具顺序、instructions 内容对同样的配置必须逐字节稳定；
 * 不要在 instructions 里放时间、随机数；动态内容走工具结果。
 */
import type { MessageAttachment, YayaConfig } from '../../types'
import type { ProviderMessage } from '../providers/types'
import type { SessionUsage, UsageSection } from '../usage'
import type {
  AgentRunOptions,
  AgentRunResult,
  AvailableTool,
  SubAgentOptions,
  WorkflowDefinition
} from '../workflow/types'

export type PluginKind = 'builtin' | 'mcp' | 'skill'

/** 工具结果里可以交给模型的内容片段 */
export type ToolContentPart =
  | { type: 'text'; text: string }
  /** data = base64（不带 data: 前缀）；宿主会存成会话资产，不进数据库正文 */
  | { type: 'image'; mimeType: string; data: string }

/**
 * 结构化工具结果：`content` 交给模型（文本 + 图片），`display` 只给界面看（不进模型上下文），
 * `isError` 标记失败（模型看到的是失败结果，界面标红）。
 * 不返回这个形状时：字符串原样、其它值 JSON 序列化后交给模型，并作为 display。
 */
export interface ToolContentResult {
  content: ToolContentPart[]
  display?: unknown
  isError?: boolean
}

/**
 * 本次运行的上下文信息（插件 SDK 提供，插件自己决定怎么用：给模型看、据此裁剪输出等）。
 * 只读快照；token 数来自服务商最近一次返回的 usage，没有时为 null。
 */
export interface ToolSessionContext {
  sessionId: string
  model: string
  providerId: string
  /** 当前第几步 / 本次运行的步数上限 */
  step: number
  maxSteps: number
  /** 最近一次模型调用的输入 token（≈ 当前上下文大小）/ 输出 token / 缓存命中 */
  lastPromptTokens: number | null
  lastCompletionTokens: number | null
  lastCachedTokens: number | null
  /** 本次运行累计 token */
  runTotalTokens: number
  /** 当前分支的消息节点数（user / assistant / tool） */
  branchMessages: number
  /** 当前可用的工具数（wire name 去重） */
  toolCount: number
}

// ---------------------------------------------------------------------------
// 插件配置（PLAN 6.4）：插件声明 schema，设置页按 schema 自动生成表单
// ---------------------------------------------------------------------------

export interface PluginConfigOption {
  value: string
  label: string
  labelKey?: string
}

export interface PluginConfigField {
  /** 插件内唯一：[a-zA-Z0-9_]+ */
  key: string
  type: 'string' | 'text' | 'number' | 'boolean' | 'select'
  label: string
  labelKey?: string
  description?: string
  descriptionKey?: string
  default?: string | number | boolean
  /**
   * 凭据（API key 等）：加密落盘；`yaya.config-get` / 插件列表只给「已设置」不给值；
   * 保存时空串 = 沿用旧值，显式清除才删除（与 MCP 请求头同规则）。
   */
  secret?: boolean
  /** select 的选项 */
  options?: PluginConfigOption[]
  /** number 的范围 */
  min?: number
  max?: number
  step?: number
  placeholder?: string
  /** 属于哪个子分组（缺省 = 插件本身的配置） */
  group?: string
}

/**
 * 子分组：插件把工具挂在分组下（如 Android Controller 的 Shizuku / Termux:API），
 * 分组有自己的状态、开关与配置。分组不可用（status.state !== 'ready'）或被用户关掉时，
 * 整组工具不提供给模型，设置页显示原因。
 */
export interface PluginGroup {
  /** 插件内唯一：[a-z0-9-]+ */
  id: string
  label: string
  labelKey?: string
  description?: string
  descriptionKey?: string
  /** 缺省 true；用户覆盖记在 `config.pluginGroupEnabled['<插件 id>/<分组 id>']` */
  defaultEnabled?: boolean
  /** 缺省视为 ready */
  status?: () => PluginStatus
}

export interface ToolRunContext {
  sessionId: string
  pluginId: string
  signal: AbortSignal
  /** 本插件的配置值（默认值已填好，secret 已解密）；插件没有配置时为 {} */
  config?: Record<string, unknown>
  /** 本次运行的上下文信息（宿主按需计算；旧调用方 / 测试里可能没有） */
  context?: () => ToolSessionContext
  /**
   * 正在运行的工作流（工具由工作流宿主执行时才有）：插件工具借它操纵这次运行——
   * 派出子 Agent（可带工具）、往过程卡片里记步骤。见 ToolWorkflowHandle。
   */
  workflow?: ToolWorkflowHandle
}

/**
 * 插件工具拿到的「当前工作流」句柄（WorkflowContext 的一个安全子集）。
 * 子 Agent 的步骤记在本次运行的过程卡片里，和工作流自己的子 Agent 一样能暂停 / 停止 / 审批。
 */
export interface ToolWorkflowHandle {
  /** 工作流 id（如 'agent'） */
  readonly workflowId: string
  /** 当前分支的对话历史（不含系统提示词） */
  history(): ProviderMessage[]
  /** 本次运行可用的插件工具（wire name + 插件 id） */
  availableTools(): AvailableTool[]
  /** 不带工具的子 Agent（一次模型调用） */
  subAgent(opts: SubAgentOptions): Promise<{ content: string }>
  /** 带工具的子 Agent（自己的工具循环），见 AgentRunOptions */
  runAgent(opts: AgentRunOptions): Promise<AgentRunResult>
  /** 往过程卡片里加一条说明 */
  note(label: string, detail?: string): void
}

/** 提供方默认审批：ask = 每次确认；auto = 直接执行；函数 = 按参数判断 */
export type ApprovalDefault = 'ask' | 'auto' | ((args: Record<string, unknown>) => boolean)

export interface PluginTool {
  /** 插件内唯一的裸名：[a-zA-Z0-9_-]，对模型暴露时由注册表加插件前缀 */
  name: string
  /** 给模型看的说明 */
  description: string
  /** JSON Schema（type: 'object'） */
  parameters: Record<string, unknown>
  /** 缺省 'auto' */
  approval?: ApprovalDefault
  /** 缺省 60s；超时视为失败 */
  timeoutMs?: number
  /** 所属子分组 id（见 YayaPlugin.groups） */
  group?: string
  /** 给人看的 Markdown 说明（设置页插件详情） */
  docs?: string
  run(args: Record<string, unknown>, ctx: ToolRunContext): Promise<unknown>
}

export interface PluginStatus {
  state: 'ready' | 'connecting' | 'error' | 'idle'
  message?: string
}

export interface YayaPlugin {
  /** 全局唯一：builtin 用目录名，mcp = `mcp-<服务器 id>`，skill = `skill-<名字>` */
  id: string
  kind: PluginKind
  /** 显示名 / 描述：builtin 给翻译键 + 中文兜底；动态插件直接给文本（labelKey 留空） */
  label: string
  labelKey?: string
  description: string
  descriptionKey?: string
  /** mdi 图标 */
  icon?: string
  /**
   * 工具名前缀（wire name = `<prefix>_<tool>`）。缺省 = 插件 id 中的非法字符替换为 `_`；
   * `false` = 不加前缀（仅内置 system 插件，为兼容旧会话里的工具名）。
   */
  namespace?: string | false
  /** 新装时是否默认启用（缺省 true；用户覆盖记在 config.pluginEnabled） */
  defaultEnabled?: boolean
  /** Infrastructure plugins can opt out of user mention candidates. Defaults to true. */
  mentionable?: boolean
  /** 给人看的 Markdown 文档 */
  docs?: string
  /** 拼进系统提示词的片段（必须稳定）；返回空串 = 无 */
  instructions?: () => string
  /** 当前工具列表（动态插件可能在 start 之后才有） */
  tools: () => PluginTool[]
  status?: () => PluginStatus
  /**
   * 配置 schema（缺省 = 无配置）。值存 `config.pluginConfig[<插件 id>]`。
   * 配置变化会触发 refreshPlugins，但**工具表与 instructions 不能因配置而变**（提示词缓存）。
   */
  configSchema?: PluginConfigField[]
  /** 子分组（缺省 = 无分组） */
  groups?: () => PluginGroup[]
  /**
   * 插件注入的工作流（缺省 = 无）。插件对某个助手启用时，这些工作流出现在该助手的默认工作流
   * 选择与输入框的工作流菜单里；插件被关掉后，选了它的会话 / 助手回落到默认工作流。
   * id 建议 `<插件 id>.<名字>`；契约见 `services/workflow/types.ts`（可用子 Agent、计算节点、
   * 数据卡片、按分支保存的状态）。
   */
  workflows?: () => WorkflowDefinition[]
  /**
   * 用户在输入框 `@` 点名本插件时**额外**的效果（PLAN 6.3）。插件的全部工具由宿主统一注入，
   * 这里只补充附注 / 随消息加载的内容：skill = SKILL.md 正文（Skill 提供方实现）；
   * 显示类插件（没有工具）应返回一句 note，如「可以用 ```mermaid 代码块画图」。
   * 效果只作用于**这条用户消息及之后**，不改系统提示词（提示词缓存不失效）。
   */
  mention?: (ctx: MentionContext) => MentionEffect | Promise<MentionEffect>
  /**
   * 数据流钩子（插件启用时才调用，按插件注册顺序串起来）。只能做确定性的文本变换：
   * 结果会入库、会发给模型，不能依赖时间 / 随机（提示词缓存）。
   */
  hooks?: PluginHooks
  /** 启用后首次需要工具前调用（连接 MCP 等）；失败抛错，status 应反映错误 */
  start?: () => Promise<void>
  /** 禁用 / 配置变化 / 退出时调用 */
  stop?: () => Promise<void>
}

export interface PluginHooks {
  /** 用户消息入库前改写正文（如把 `#Secret("…")` 换成引用）。编辑重发 / 新消息都会经过 */
  userText?: (ctx: { sessionId: string; text: string }) => string
  /** 工具执行前改写参数。只影响这次执行：库里与模型看到的仍是原参数 */
  toolArgs?: (ctx: {
    sessionId: string
    tool: string
    args: Record<string, unknown>
  }) => Record<string, unknown>
  /** 工具结果（给模型的文本 / 界面显示 / 错误）入库前改写 */
  toolResult?: <T>(ctx: { sessionId: string; tool: string; value: T }) => T
  /**
   * 用量统计（`yaya.session-usage`）里加一块：如按模型价格算出的费用。
   * 只影响界面，不进模型上下文；返回 null = 这次不显示。数据变了可以广播
   * `cockpit:yaya-usage-changed` 让打开着的统计窗口重新拉取。
   */
  usage?: (ctx: {
    sessionId: string
    usage: SessionUsage
  }) => PluginUsageSection | null | Promise<PluginUsageSection | null>
  /**
   * 模型选择里某个模型旁边的小标签（如价格、上下文长度）。多个插件的标签会拼在一起。
   * 数据变了广播 `cockpit:yaya-model-hints-changed`。
   */
  modelHint?: (ctx: { providerId: string; model: string }) => ModelHint | null
}

export type PluginUsageSection = Omit<UsageSection, 'pluginId'>

export interface ModelHint {
  /** 短标签，如「$1.25 / $10」「400K」 */
  badges?: string[]
  /** 悬停说明 */
  title?: string
  /** 模型的上下文长度（token）；上下文管理的「自动」预算按它算 */
  contextWindow?: number
}

export interface MentionContext {
  sessionId: string
}

export interface MentionEffect {
  /** 拼进这条用户消息的附注（给模型看，不显示在用户气泡里） */
  note?: string
  /** 随这条消息加载的内容（文本 / 图片，走工具结果同一套规范化） */
  content?: ToolContentPart[]
  /** 连带启用的其他插件 id（如 Skill 需要 skills 枢纽的 skill_read_file） */
  requires?: string[]
}

/** 动态插件来源（MCP / Skill）：配置变化时重算插件列表；返回的同 id 插件应复用连接 */
export interface PluginProvider {
  id: string
  sync(config: YayaConfig): YayaPlugin[]
}

// ---------------------------------------------------------------------------
// 给渲染端 / 设置页的视图（yaya.plugins-list）
// ---------------------------------------------------------------------------

export interface PluginToolInfo {
  /** 对模型暴露的名字（toolCall.name 就是它；disabledTools / toolApproval 也按它记） */
  wireName: string
  name: string
  description: string
  docs?: string
  defaultApproval: 'ask' | 'auto' | 'dynamic'
  approval?: 'ask' | 'auto'
  enabled: boolean
  group?: string
}

export interface PluginGroupInfo {
  id: string
  /** 已翻译 */
  label: string
  description: string
  enabled: boolean
  defaultEnabled: boolean
  status: PluginStatus
  /** 本组工具此刻是否会提供给模型（启用且 ready） */
  available: boolean
}

export interface PluginConfigInfo {
  /** 已翻译的 schema */
  schema: PluginConfigField[]
  /** 非 secret 字段的当前值（缺省值已填） */
  values: Record<string, unknown>
  /** 已设置的 secret 字段 key */
  secretsSet: string[]
}

export interface PluginInfo {
  id: string
  kind: PluginKind
  /** 已翻译 */
  label: string
  description: string
  icon?: string
  docs?: string
  enabled: boolean
  defaultEnabled: boolean
  status: PluginStatus
  /** instructions 的长度（设置页提示「会占用多少系统提示词」） */
  instructionsChars: number
  tools: PluginToolInfo[]
  groups?: PluginGroupInfo[]
  config?: PluginConfigInfo
}

/** 宿主规范化后的工具结果 */
export interface NormalizedToolResult {
  /** 交给模型的文本 */
  text: string
  /** 交给模型的图片（已存成会话资产） */
  images: MessageAttachment[]
  /** 界面展示用（toolCall.result） */
  display: unknown
  isError: boolean
}
