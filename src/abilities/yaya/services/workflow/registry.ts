/**
 * 工作流注册表。内置工作流在 `builtin.ts` 注册；其他模块（将来的插件 / MCP 编排）
 * 同样调用 `registerWorkflow` 即可出现在设置与输入框的工作流选择里。
 */
import { t } from '../../../../main/process/i18n'
import type { WorkflowInfo } from '../../types'
import type { WorkflowDefinition } from './types'

export const DEFAULT_WORKFLOW_ID = 'agent'

const workflows = new Map<string, WorkflowDefinition>()

export function registerWorkflow(def: WorkflowDefinition): void {
  if (workflows.has(def.id)) throw new Error(`duplicate yaya workflow: ${def.id}`)
  workflows.set(def.id, def)
}

/** 未知 id 回落默认工作流（配置里留着已删除的工作流也不会坏） */
export function resolveWorkflow(id: string | undefined | null): WorkflowDefinition {
  return (
    (id ? workflows.get(id) : undefined) ??
    workflows.get(DEFAULT_WORKFLOW_ID) ??
    [...workflows.values()][0]
  )
}

export function workflowLabel(def: WorkflowDefinition): string {
  return t(def.labelKey, def.label)
}

export function listWorkflowInfo(): WorkflowInfo[] {
  return [...workflows.values()].map((w) => ({
    id: w.id,
    label: workflowLabel(w),
    description: t(w.descriptionKey, w.description),
    usesTools: w.usesTools
  }))
}
