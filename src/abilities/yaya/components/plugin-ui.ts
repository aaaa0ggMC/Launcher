/**
 * YAYA 插件 SDK —— 渲染端契约。
 *
 * 插件可选地在 `src/abilities/yaya/plugins/<id>/ui.ts` 默认导出 `definePluginUi({...})`：
 * - `toolViews`：某个工具结果的自定义展示（替换工具调用卡片里默认的「结果」字段视图；参数区不变）；
 * - `fences`：接管回答里某种语言的代码块（如 ```mermaid），渲染成组件；
 * - `settingsView`：替换插件详情页里按 `configSchema` 自动生成的配置表单（设置 → 插件 → 详情）。
 *
 * **只做显示层变换**：数据库与发给模型的历史永远是模型 / 工具的原文，所以这里怎么渲染都不影响提示词缓存。
 * 配置值仍走命令 `yaya.plugin-config-set` 保存（schema 校验、secret 加密都在主进程）。
 * 组件都按需加载（返回 `import('./X.vue')`）。组件拿到的 props 见 `ToolViewProps` / `FenceViewProps` /
 * `PluginSettingsViewProps`。
 */
import type { Component } from 'vue'
import type { ToolCallItem } from '../types'
import type { PluginInfo } from '../services/plugins/types'

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

type Lazy = () => Promise<{ default: Component } | Component>

export interface PluginUi {
  /** 对应后端插件 id；动态插件可用 `kind:<mcp|skill>` 匹配同类全部插件 */
  pluginId: string
  /** 裸工具名 → 视图组件 */
  toolViews?: Record<string, Lazy>
  /** 代码块语言（小写）→ 组件 */
  fences?: Record<string, Lazy>
  /** 设置 → 插件详情里的配置界面（没有就用 schema 自动生成的表单） */
  settingsView?: Lazy
  /** Composer extension: receives PluginInputProps, registers triggers/hooks and owns its UI. */
  inputExtension?: Lazy
}

export function definePluginUi(ui: PluginUi): PluginUi {
  return ui
}
