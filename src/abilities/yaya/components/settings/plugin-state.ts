/**
 * 插件 / 工具的启用与审批状态：全部读写在 config 的 pluginEnabled / disabledTools /
 * toolApproval 三个字段上，优先级与主进程 registry 保持一致：
 *   显式覆盖 > 全局「自动允许工具调用」(autoApproveTools) > 提供方默认
 *
 * config 是外壳持有的同一个 reactive 对象，按约定由子组件直接改字段、外壳统一保存。
 */
import type { PluginInfo, PluginToolInfo } from '../../services/plugins/types'
import type { ToolApprovalMode, YayaConfig } from '../../types'

/** 生效审批（含提供方默认的 dynamic） */
export type EffectiveApproval = 'ask' | 'auto' | 'dynamic'
/** 审批三档：'default' = 跟随提供方默认 */
export type ApprovalChoice = 'default' | ToolApprovalMode

/** 该插件的启用状态：显式覆盖优先，缺省 = 插件自己的 defaultEnabled */
export function isPluginEnabled(config: YayaConfig, plugin: PluginInfo): boolean {
  return config.pluginEnabled?.[plugin.id] ?? plugin.defaultEnabled
}

/** 写插件启用开关；与 defaultEnabled 相同时删键（恢复缺省值） */
export function setPluginEnabled(config: YayaConfig, plugin: PluginInfo, on: boolean): void {
  const next: Record<string, boolean> = { ...(config.pluginEnabled ?? {}) }
  if (on === plugin.defaultEnabled) delete next[plugin.id]
  else next[plugin.id] = on
  config.pluginEnabled = next
}

/** 插件图标的兜底值（插件自己没给 icon 时按 kind 给） */
export function pluginFallbackIcon(plugin: PluginInfo): string {
  if (plugin.kind === 'mcp') return 'mdi-connection'
  if (plugin.kind === 'skill') return 'mdi-file-document-outline'
  return 'mdi-puzzle-outline'
}

// ---------------------------------------------------------------------------
// 单个工具
// ---------------------------------------------------------------------------

/** 这个工具的显式审批覆盖（无 = 跟随提供方默认） */
export function approvalOverride(
  config: YayaConfig,
  tool: PluginToolInfo
): ToolApprovalMode | undefined {
  return config.toolApproval?.[tool.wireName]
}

/**
 * 生效的审批方式，优先级与主进程 `toolNeedsApproval` 一致：
 * 显式设置 > 全局「自动允许工具调用」> 提供方默认
 */
export function effectiveApproval(config: YayaConfig, tool: PluginToolInfo): EffectiveApproval {
  const override = approvalOverride(config, tool)
  if (override) return override
  if (config.autoApproveTools) return 'auto'
  return tool.defaultApproval
}

/** 生效值来自全局开关、而不是本工具自己的设置（chip 标注「全局」） */
export function approvalFromGlobal(config: YayaConfig, tool: PluginToolInfo): boolean {
  return (
    !approvalOverride(config, tool) && config.autoApproveTools && tool.defaultApproval !== 'auto'
  )
}

/** 生效状态 chip 的颜色：需确认 = warning；按命令确认 = info；自动执行不着色 */
export function approvalChipColor(eff: EffectiveApproval): string | undefined {
  if (eff === 'ask') return 'warning'
  if (eff === 'dynamic') return 'info'
  return undefined
}

/** 写单工具的审批覆盖；'default' = 删键回到提供方默认 */
export function setToolApproval(config: YayaConfig, tool: PluginToolInfo, value: string): void {
  const next: Record<string, ToolApprovalMode> = { ...(config.toolApproval ?? {}) }
  if (value === 'ask' || value === 'auto') next[tool.wireName] = value
  else delete next[tool.wireName]
  config.toolApproval = next
}

/** 写单工具的启用开关（本地对象同步改，界面立刻反映） */
export function setToolEnabled(config: YayaConfig, tool: PluginToolInfo, on: boolean): void {
  tool.enabled = on
  const disabled = new Set(config.disabledTools ?? [])
  if (on) disabled.delete(tool.wireName)
  else disabled.add(tool.wireName)
  config.disabledTools = [...disabled]
}
