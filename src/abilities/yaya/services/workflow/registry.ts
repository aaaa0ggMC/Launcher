/**
 * 工作流注册表。
 *
 * - 内置工作流在 `builtin.ts` 用 `registerWorkflow` 注册；
 * - 插件经 `YayaPlugin.workflows()` 注入自己的工作流（如 storyteller 的「故事模式」）：
 *   **只有插件对这个助手启用时才可选、才会运行**。会话 / 助手选了一个已不可用的插件工作流
 *   （插件被关、被卸载），运行时回落到助手的默认工作流，再不行回落 `agent`。
 */
import { t } from '../../../../main/process/i18n'
import type { WorkflowInfo, YayaConfig } from '../../types'
import { isPluginEnabled, listPlugins } from '../plugins/registry'
import type { WorkflowDefinition } from './types'

export const DEFAULT_WORKFLOW_ID = 'agent'

const builtin = new Map<string, WorkflowDefinition>()

export function registerWorkflow(def: WorkflowDefinition): void {
  if (builtin.has(def.id)) throw new Error(`duplicate yaya workflow: ${def.id}`)
  builtin.set(def.id, def)
}

/** 插件注入的工作流（不看启用状态）；同 id 与内置 / 先出现的冲突时丢弃后来的 */
function pluginWorkflows(): WorkflowDefinition[] {
  const out: WorkflowDefinition[] = []
  const seen = new Set(builtin.keys())
  for (const plugin of listPlugins()) {
    let defs: WorkflowDefinition[] = []
    try {
      defs = plugin.workflows?.() ?? []
    } catch {
      defs = []
    }
    for (const def of defs) {
      if (!def?.id || seen.has(def.id)) continue
      seen.add(def.id)
      out.push({ ...def, pluginId: plugin.id })
    }
  }
  return out
}

/** 这份（助手生效）配置下可选的工作流：内置 + 已启用插件的 */
export function availableWorkflows(config?: YayaConfig): WorkflowDefinition[] {
  const plugins = new Map(listPlugins().map((p) => [p.id, p]))
  return [
    ...builtin.values(),
    ...pluginWorkflows().filter((w) => {
      const plugin = plugins.get(w.pluginId!)
      return !!plugin && (!config || isPluginEnabled(plugin, config))
    })
  ]
}

/**
 * 按 id 取工作流。给了 config 时只在可用的里面找：找不到（未知 id / 插件被关）→
 * config.defaultWorkflow（助手的默认，同样要可用）→ `fallbacks`（如全局默认）→ agent → 第一个。
 */
export function resolveWorkflow(
  id: string | undefined | null,
  config?: YayaConfig,
  ...fallbacks: (string | undefined | null)[]
): WorkflowDefinition {
  const list = availableWorkflows(config)
  const find = (x: string | undefined | null): WorkflowDefinition | undefined =>
    x ? list.find((w) => w.id === x) : undefined
  for (const x of [id, config?.defaultWorkflow, ...fallbacks, DEFAULT_WORKFLOW_ID]) {
    const hit = find(x)
    if (hit) return hit
  }
  return list[0]
}

export function workflowLabel(def: WorkflowDefinition): string {
  return t(def.labelKey, def.label)
}

export function listWorkflowInfo(config?: YayaConfig): WorkflowInfo[] {
  const plugins = new Map(listPlugins().map((p) => [p.id, p]))
  return availableWorkflows(config).map((w) => {
    const plugin = w.pluginId ? plugins.get(w.pluginId) : undefined
    return {
      id: w.id,
      label: workflowLabel(w),
      description: t(w.descriptionKey, w.description),
      usesTools: w.usesTools,
      ...(w.icon ? { icon: w.icon } : {}),
      ...(plugin
        ? {
            pluginId: plugin.id,
            pluginLabel: plugin.labelKey ? t(plugin.labelKey, plugin.label) : plugin.label
          }
        : {})
    }
  })
}
