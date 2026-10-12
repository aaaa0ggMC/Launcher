/**
 * YAYA 插件 SDK —— 渲染端契约。
 *
 * 插件可选地在 `src/abilities/yaya/plugins/<id>/ui.ts` 默认导出 `definePluginUi({...})`：
 * - `toolViews`：某个工具结果的自定义展示（替换工具调用卡片里默认的「结果」字段视图；参数区不变）；
 * - `fences`：接管回答里某种语言的代码块（如 ```mermaid），渲染成组件；
 * - `settingsView`：替换插件详情页里按 `configSchema` 自动生成的配置表单（设置 → 插件 → 详情）。
 * - `inlineTokens`：把消息正文里的某种记号（如 `[[secret_xxxx]]`）渲染成标签 / 替换文字。
 * - `usageView`：用量统计里本插件分区（后端 `hooks.usage` 返回）的自定义视图。
 * - `messageActions`：每条回答下面操作栏里的按钮（如「朗读」）。
 * - `inlineTags`：正文里的命名空间标记（如拟真对话的 `<||…>` 换气泡 / 撤回），按前缀分派。
 * - `reactionSets`：消息下面可选的表情组（图标包）；默认表情集由框架自带。
 * - `turnChrome`：回答的外观偏好（隐藏内置操作栏、折叠过程卡片、输入提示文案）；
 *   只能影响框架自有元素，插件注入物（toolCards / fences / messageActions / 数据卡 / 审批）不受影响。
 * - `cardViews`：插件工作流写进对话的数据卡片（`ctx.addCard({ type })`）按 type 渲染。
 * - `toolCards`：某个工具的调用渲染成回答里的独立卡片（不收进过程卡片），运行中可交互（如 ask 的提问）。
 * - `inputExtension`：输入框扩展组件；往「+」面板加项用 `context.addAction`（见 plugin-input.ts）。
 *
 * **只做显示层变换**：数据库与发给模型的历史永远是模型 / 工具的原文，所以这里怎么渲染都不影响提示词缓存。
 * 配置值仍走命令 `yaya.plugin-config-set` 保存（schema 校验、secret 加密都在主进程）。
 * 组件都按需加载（返回 `import('./X.vue')`）。组件拿到的 props 见 `ToolViewProps` / `FenceViewProps` /
 * `PluginSettingsViewProps`。
 */
import type { Component } from 'vue'
import type { ToolCallItem } from '../types'
import type { InlineTagRule } from './chat-tags'
import type { PluginInfo } from '../services/plugins/types'
import type { SessionUsage, UsageSection } from '../services/usage'

export interface ToolViewProps {
  call: ToolCallItem
  /** 该工具所属插件 id 与裸工具名 */
  pluginId: string
  toolName: string
}

export interface FenceViewProps {
  lang: string
  source: string
  /** 流式输出中（代码块可能还没写完） */
  streaming: boolean
}

/**
 * 块级小部件（`PluginUi.blockViews`）拿到的 props：正文里的 `<g|ttt|…>` 这类标记
 * 会被替换成组件，渲染在**这条回答的末尾**（旁白文字都在它上方）。
 */
export interface BlockViewProps {
  /** 标记名（前缀后到第一个 `|`），如 `ttt` */
  name: string
  /** 名字之后的载荷原样（如 `X.O.X...|turn=O`） */
  source: string
  /** 流式输出中（标记可能还没写完） */
  streaming: boolean
  /** 这条回答所在的会话（小部件要回传用户操作时用，如棋盘落子） */
  sessionId: string
}

/**
 * 工具卡片（`toolCards`）拿到的 props：固定显示在回答正文里（过程卡片里仍保留这次调用的记录行）。
 * `live` = 本轮正在运行，卡片可据此决定能否交互（如提问卡片的提交按钮）。
 */
export interface ToolCardProps extends ToolViewProps {
  sessionId: string
  live: boolean
}

/** 插件详情页的自定义配置界面（替代按 schema 自动生成的表单） */
export interface PluginSettingsViewProps {
  pluginId: string
  info: PluginInfo
}

/** 用量统计里插件分区的视图 */
export interface UsageViewProps {
  pluginId: string
  sessionId: string
  section: UsageSection
  usage: SessionUsage
}

type Lazy = () => Promise<{ default: Component } | Component>

export interface InlineTokenContext {
  sessionId: string
  role: 'user' | 'assistant'
  /** 当前界面语言的翻译函数 */
  t: (key: string, fallback?: string) => string
}

/** 记号的显示：tone=chip 显示成带图标的小标签；tone=text 直接替换成文字；
 * tone=bare 不加任何底色（内联表情用），tone=plain 纯文本替换（无任何装饰）；
 * `img` 整段换成一张图（表情包），`html` 直接注入 HTML 片段（**只允许来自用户自己的
 * 规则模板**，其中夹带的匹配内容必须先由调用方转义） */
export interface InlineTokenView {
  text: string
  title?: string
  /** mdi 图标（只在 chip / bare 下显示） */
  icon?: string
  /** 图片（表情包）：给了就渲染成 `<img>`，`text` 当 alt */
  img?: string
  /** HTML 片段（HTML 规则的替换结果）：原样注入，`text` 仅作兜底 */
  html?: string
  tone?: 'chip' | 'text' | 'bare' | 'plain'
  /** 隐私 SDK scope：AI 快照 / 截图按它脱敏 */
  privacy?: string
}

export interface InlineTokenRule {
  /** 必须带 g 标志 */
  pattern: RegExp
  /** 返回 null = 这一处不处理，原样显示 */
  render: (match: RegExpExecArray, ctx: InlineTokenContext) => InlineTokenView | null
}

/**
 * `PluginUi.inlineTokens`：静态数组，或**函数**——函数形式在每次渲染时求值，
 * 于是可以读插件配置（配置驱动的替换规则，如 Regex 插件），并因此具备响应式。
 */
export type InlineTokenSource = InlineTokenRule[] | (() => InlineTokenRule[])

/** 数据卡片视图拿到的 props */
export interface CardViewProps {
  /** 卡片类型 / 标题 / 结构化数据 / 兜底 Markdown（见 WorkflowCardMeta） */
  type: string
  title?: string
  data?: unknown
  markdown?: string
  messageId: string
  sessionId: string
}

/** 回答操作栏按钮拿到的上下文 */
export interface MessageActionContext {
  sessionId: string
  /** 本轮第一个 assistant 节点 id（同一轮回答的稳定标识） */
  messageId: string
  role: 'assistant'
  /** 本轮回答的正文（Markdown 原文，不含思考 / 工具过程） */
  text: string
}

/** 回答下面操作栏里的一个按钮（插件启用时才显示） */
export interface MessageAction {
  /** 插件内唯一 */
  id: string
  icon: string
  /** 中文原文；`labelKey` 给了就走翻译 */
  label: string
  labelKey?: string
  /** 进行中（如正在朗读这一条）：换成 activeIcon / activeLabel，点击仍调 run，由插件决定停还是重来 */
  active?: (ctx: MessageActionContext) => boolean
  activeIcon?: string
  activeLabel?: string
  activeLabelKey?: string
  /** 返回 false = 这一条不显示（如回答没有正文） */
  visible?: (ctx: MessageActionContext) => boolean
  run: (ctx: MessageActionContext) => void | Promise<void>
}

/**
 * 正文里的命名空间标记（如拟真对话的 `<||…>`）：按**前缀**分派给插件。
 * 解析规则见 `chat-tags.ts`；同前缀多个插件声明时按 pluginId 字母序取第一个。
 */
export interface InlineTagDef extends InlineTagRule {
  /** 生效角色，默认 `['assistant']`（用户输入里的同名文本永远当普通文字） */
  roles?: ('user' | 'assistant')[]
}

/** 一个可选表情 */
export interface ReactionItem {
  /**
   * 唯一 key，同时是**存进 `meta.reactions` 的值**：默认表情集里它就是 emoji 本身（👍），
   * 图标包里是图标名（配合 `icon` / `src`）。
   */
  key: string
  /** 内联短码（AI 在正文里写 `:shortcode:` 就是它）；不给就用 `key` */
  shortcode?: string
  /** 图标包：`parseIcon` 语法（`gi:<name>` / `default/<name>` / `emoji/…`）。不给就直接显示 key 文本 */
  icon?: string
  /**
   * **图片表情**（Discord 式表情包）：`file/<绝对路径>` 走 cockpit-icon 协议，
   * 其余是 URL / data URL。给了 `src` 就优先用图片。
   */
  src?: string
  label?: string
  labelKey?: string
}

/** 一组表情（一个图标包 = 一个 set），出现在消息下的选择器里 */
export interface ReactionSet {
  /** 全局唯一：内置默认集是 `default`，插件建议用插件 id */
  id: string
  label?: string
  labelKey?: string
  items: ReactionItem[]
  /** 哪一侧的消息可以 react，缺省两侧都可以 */
  roles?: ('user' | 'assistant')[]
  /** false = 这组只用于回应选择器，正文里的 `:短码:` 不解析它（默认参与） */
  inline?: boolean
}

/** 框架自带的默认表情集（不看插件启用状态：历史消息的表情总要显示得出来） */
export const DEFAULT_REACTION_SET: ReactionSet = {
  id: 'default',
  label: '表情',
  labelKey: 'yaya.react.set_default',
  items: [
    { key: '👍', shortcode: 'thumbsup', label: '赞', labelKey: 'yaya.react.thumbsup' },
    { key: '👎', shortcode: 'thumbsdown', label: '踩', labelKey: 'yaya.react.thumbsdown' },
    { key: '❤️', shortcode: 'heart', label: '喜欢', labelKey: 'yaya.react.heart' },
    { key: '😂', shortcode: 'joy', label: '笑哭', labelKey: 'yaya.react.laugh' },
    { key: '😮', shortcode: 'surprised', label: '惊讶', labelKey: 'yaya.react.surprised' },
    { key: '😢', shortcode: 'cry', label: '难过', labelKey: 'yaya.react.sad' },
    { key: '🎉', shortcode: 'tada', label: '庆祝', labelKey: 'yaya.react.tada' },
    { key: '🙏', shortcode: 'pray', label: '谢谢', labelKey: 'yaya.react.thanks' }
  ]
}

/** `turnChrome` 能看到的上下文 */
export interface TurnChromeContext {
  sessionId: string
  /** 本轮第一个 assistant 节点 id */
  messageId: string
  /** 本轮正在运行（流式 / 工具执行 / 等待确认） */
  live: boolean
}

/**
 * 回答的外观偏好（拟真对话等插件）。**只能影响框架自有元素**：
 * 复制 / 重新生成 / 更多 / usage 这条操作栏、过程卡片的折叠态、运行中的输入提示。
 * 插件注入物（`toolCards` / `fences` / `messageActions` / 数据卡 / 工具审批）不在清单内，
 * 永远不被它影响——审批与提问卡必须在任何配置下可见可交互。
 */
export interface TurnChrome {
  /** 隐藏回答下方的内置操作栏（复制 / 重新生成 / 更多 / usage）。插件按钮走右键 / 长按菜单仍可用 */
  hideActions?: boolean
  /** 过程卡片（思考 / 工具调用）：open 正常 | collapsed 默认收起（可展开）| hidden 不渲染 */
  process?: 'open' | 'collapsed' | 'hidden'
  /** 运行中的「正在输入」提示文案（空 = 默认打字点） */
  typingLabel?: string
}

export interface PluginUi {
  /** 对应后端插件 id；动态插件可用 `kind:<mcp|skill>` 匹配同类全部插件 */
  pluginId: string
  /** 裸工具名 → 视图组件 */
  toolViews?: Record<string, Lazy>
  /** 代码块语言（小写）→ 组件 */
  fences?: Record<string, Lazy>
  /**
   * 对话内块级小部件：标记名（`<g|ttt|…>` 里的 `ttt`）→ 组件，渲染在这条回答的末尾，
   * 旁白文字在它上方。按插件启用状态门控（关掉就按原文显示标记）。
   */
  blockViews?: Record<string, Lazy>
  /**
   * 标记的「回声」文案：**用户消息**里出现该标记时替换成这句人话（如走子
   * `<g|ttt|move=4>` → 「你落子第 5 格」），避免气泡里露出原始标记或变成空气泡。
   * 没提供就直接剥掉标记。
   */
  blockEchoes?: Record<
    string,
    (payload: string, t: (key: string, fallback?: string) => string) => string
  >
  /** 设置 → 插件详情里的配置界面（没有就用 schema 自动生成的表单） */
  settingsView?: Lazy
  /** 插件详情页里配置下面的附加面板（如「测试搜索」），props: { pluginId, info } */
  settingsPanel?: Lazy
  /** Composer extension: receives PluginInputProps, registers triggers/hooks and owns its UI. */
  inputExtension?: Lazy
  /**
   * 消息正文里的记号（用户气泡与回答都会经过）。不按插件启用状态门控：历史消息里的记号
   * 在插件关掉后也要能看懂。只改显示，数据库与模型历史不变。
   * 可以给函数（每次渲染求值）→ 支持读插件配置做「配置驱动的替换规则」。
   */
  inlineTokens?: InlineTokenSource
  /** 用量统计里本插件分区的视图，props 见 UsageViewProps（后端 `hooks.usage` 给了分区才显示） */
  usageView?: Lazy
  /** 回答下面操作栏的按钮（复制 / 重新生成之后） */
  messageActions?: MessageAction[]
  /**
   * 正文里的命名空间标记（按前缀分派，见 `chat-tags.ts`）。默认只在 assistant 输出里解析。
   * 只改显示：数据库与发给模型的历史保留标记原文。
   */
  inlineTags?: InlineTagDef[]
  /**
   * 消息下面可选的表情组（图标包）。选择器只列**已启用**插件的组，
   * 已经落在历史消息里的表情即使插件关掉也照样显示（按 key 找不到就显示 key 本身）。
   */
  reactionSets?: ReactionSet[]
  /**
   * 回答的外观偏好（隐藏内置操作栏 / 折叠过程卡片 / 输入提示文案）。
   * 按 pluginId 字母序合并，后者覆盖前者；只影响框架自有元素，见 `TurnChrome`。
   */
  turnChrome?: (ctx: TurnChromeContext) => TurnChrome | null | undefined
  /** 数据卡片类型 → 视图组件（props 见 CardViewProps）；没有就显示卡片的 markdown */
  cardViews?: Record<string, Lazy>
  /**
   * 裸工具名 → 独立卡片视图（props 见 ToolCardProps）。这个工具的每次调用都在回答里显示成一张卡片，
   * 位置在发起调用的那一步之后；不按启用状态门控（历史对话里的卡片在插件关掉后也要能看懂）。
   */
  toolCards?: Record<string, Lazy>
}

export function definePluginUi(ui: PluginUi): PluginUi {
  return ui
}
