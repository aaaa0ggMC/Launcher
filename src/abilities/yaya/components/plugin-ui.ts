/**
 * YAYA 插件 SDK —— 渲染端契约。
 *
 * 插件可选地在 `src/abilities/yaya/plugins/<id>/ui.ts` 默认导出 `definePluginUi({...})`：
 * - `toolViews`：某个工具结果的自定义展示（替换工具调用卡片里默认的「结果」字段视图；参数区不变）；
 * - `fences`：接管回答里某种语言的代码块（如 ```mermaid），渲染成组件。
 *
 * **只做显示层变换**：数据库与发给模型的历史永远是模型 / 工具的原文，所以这里怎么渲染都不影响提示词缓存。
 * 组件都按需加载（返回 `import('./X.vue')`）。组件拿到的 props 见 `ToolViewProps` / `FenceViewProps`。
 */
import type { Component } from 'vue'
import type { ToolCallItem } from '../types'

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

type Lazy = () => Promise<{ default: Component } | Component>

export interface PluginUi {
  /** 对应后端插件 id；动态插件可用 `kind:<mcp|skill>` 匹配同类全部插件 */
  pluginId: string
  /** 裸工具名 → 视图组件 */
  toolViews?: Record<string, Lazy>
  /** 代码块语言（小写）→ 组件 */
  fences?: Record<string, Lazy>
}

export function definePluginUi(ui: PluginUi): PluginUi {
  return ui
}
