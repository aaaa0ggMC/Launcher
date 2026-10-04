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

export interface ToolRunContext {
  sessionId: string
  pluginId: string
  signal: AbortSignal
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
  /** 给人看的 Markdown 文档 */
  docs?: string
  /** 拼进系统提示词的片段（必须稳定）；返回空串 = 无 */
  instructions?: () => string
  /** 当前工具列表（动态插件可能在 start 之后才有） */
  tools: () => PluginTool[]
  status?: () => PluginStatus
  /** 启用后首次需要工具前调用（连接 MCP 等）；失败抛错，status 应反映错误 */
  start?: () => Promise<void>
  /** 禁用 / 配置变化 / 退出时调用 */
  stop?: () => Promise<void>
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
