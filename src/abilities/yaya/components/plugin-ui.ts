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
 * - `inputExtension`：输入框扩展组件；往「+」面板加项用 `context.addAction`（见 plugin-input.ts）。
 *
 * **只做显示层变换**：数据库与发给模型的历史永远是模型 / 工具的原文，所以这里怎么渲染都不影响提示词缓存。
 * 配置值仍走命令 `yaya.plugin-config-set` 保存（schema 校验、secret 加密都在主进程）。
 * 组件都按需加载（返回 `import('./X.vue')`）。组件拿到的 props 见 `ToolViewProps` / `FenceViewProps` /
 * `PluginSettingsViewProps`。
 */
import type { Component } from 'vue'
import type { ToolCallItem } from '../types'
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

/** 记号的显示：tone=chip 显示成带图标的小标签；tone=text 直接替换成文字 */
export interface InlineTokenView {
  text: string
  title?: string
  /** mdi 图标（只在 chip 时显示） */
  icon?: string
  tone?: 'chip' | 'text'
  /** 隐私 SDK scope：AI 快照 / 截图按它脱敏 */
  privacy?: string
}

export interface InlineTokenRule {
  /** 必须带 g 标志 */
  pattern: RegExp
  /** 返回 null = 这一处不处理，原样显示 */
  render: (match: RegExpExecArray, ctx: InlineTokenContext) => InlineTokenView | null
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

export interface PluginUi {
  /** 对应后端插件 id；动态插件可用 `kind:<mcp|skill>` 匹配同类全部插件 */
  pluginId: string
  /** 裸工具名 → 视图组件 */
  toolViews?: Record<string, Lazy>
  /** 代码块语言（小写）→ 组件 */
  fences?: Record<string, Lazy>
  /** 设置 → 插件详情里的配置界面（没有就用 schema 自动生成的表单） */
  settingsView?: Lazy
  /** 插件详情页里配置下面的附加面板（如「测试搜索」），props: { pluginId, info } */
  settingsPanel?: Lazy
  /** Composer extension: receives PluginInputProps, registers triggers/hooks and owns its UI. */
  inputExtension?: Lazy
  /**
   * 消息正文里的记号（用户气泡与回答都会经过）。不按插件启用状态门控：历史消息里的记号
   * 在插件关掉后也要能看懂。只改显示，数据库与模型历史不变。
   */
  inlineTokens?: InlineTokenRule[]
  /** 用量统计里本插件分区的视图，props 见 UsageViewProps（后端 `hooks.usage` 给了分区才显示） */
  usageView?: Lazy
  /** 回答下面操作栏的按钮（复制 / 重新生成之后） */
  messageActions?: MessageAction[]
}

export function definePluginUi(ui: PluginUi): PluginUi {
  return ui
}
