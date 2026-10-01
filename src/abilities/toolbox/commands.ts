import { app } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { CommandSpec } from '../../main/process/commands/types'
import { shield, SCOPE_EXEC, SCOPE_CONTROL, isAgentOrigin } from '../../main/process/privacy'
import { tools, toolById } from './registry'
import { P } from './privacy'
import {
  createToolTask,
  getToolTask,
  getLatestToolTask,
  waitToolTask,
  stopToolTasks,
  cancelToolTask
} from './task-store'
import { stopToolProcesses } from './execution-context'
import type { ToolArgs, ToolResult, ToolCategory, ToolModule } from './types'

const handlers: Record<ToolCategory, () => Promise<Pick<ToolModule, 'execute'>>> = {
  developer: () => import('./tools/developer/service'),
  text: () => import('./tools/text/service'),
  image: () => import('./tools/image/service'),
  files: () => import('./tools/files/service'),
  time: () => import('./tools/time/service'),
  leisure: () => import('./tools/leisure/service')
}
app?.on?.('will-quit', () => {
  stopToolTasks()
  stopToolProcesses()
})
const MAX_PAYLOAD = 180 * 1024 * 1024

export async function executeTool(id: string, args: ToolArgs): Promise<ToolResult> {
  const tool = toolById.get(id)
  if (!tool) return { ok: false, error: '未知工具 / Unknown tool' }
  try {
    if (JSON.stringify(args).length > MAX_PAYLOAD) throw new Error('输入超过工具箱大小上限')
    const defaults = Object.fromEntries(
      tool.fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])
    )
    const normalized = { ...defaults, ...args }
    for (const field of tool.fields) {
      const value = normalized[field.key]
      if ((field.type === 'file' || field.type === 'files') && typeof value === 'string' && value) {
        try {
          normalized[field.key] = JSON.parse(value)
        } catch {
          throw new Error(`Invalid file JSON: ${field.key}`)
        }
      }
      if (field.type === 'boolean' && typeof value === 'string') {
        if (!['true', 'false'].includes(value)) throw new Error(`Invalid boolean: ${field.key}`)
        normalized[field.key] = value === 'true'
      }
      if (field.type === 'number' && value !== undefined && value !== '') {
        const numeric = Number(value)
        if (
          !Number.isFinite(numeric) ||
          (field.min !== undefined && numeric < field.min) ||
          (field.max !== undefined && numeric > field.max)
        )
          throw new Error(`Invalid number: ${field.key}`)
        normalized[field.key] = numeric
      }
    }
    const handler = await handlers[tool.category]()
    const result = await handler.execute(id, normalized)
    if (JSON.stringify(result).length > MAX_PAYLOAD) throw new Error('输出超过工具箱大小上限')
    return result
  } catch (error) {
    // Do not log user input, filesystem paths, credentials, or parser excerpts.
    return { ok: false, error: error instanceof Error ? error.message : '工具处理失败' }
  }
}

export default [
  {
    name: 'toolbox.list',
    description: '列出本地工具箱工具与输入字段',
    run: () => tools
  },
  ...tools.map((tool): CommandSpec => ({
    name: `toolbox.${tool.id}`,
    logArgs: false,
    description: `${tool.title} — ${tool.titleEn}`,
    usage: `toolbox.${tool.id} ${tool.fields.map((f) => `--${f.key} <value>`).join(' ')}`,
    privacy: { reads: [P.content], ...(tool.agentDenied ? { agent: 'deny' as const } : {}) },
    run: async ({ named }) => {
      const result =
        tool.category === 'files'
          ? await waitToolTask(createToolTask(tool, () => executeTool(tool.id, named)).id)
          : await executeTool(tool.id, named)
      return { ok: result.ok, payload: shield(P.content, result) }
    }
  })),
  {
    name: 'toolbox.start',
    privacy: { reads: [] },
    description: '在后台运行本地文件工具',
    logArgs: false,
    run: ({ named }) => {
      const tool = toolById.get(String(named.tool ?? ''))
      if (!tool || tool.category !== 'files') return { ok: false, error: '未知文件工具' }
      if (tool.agentDenied && isAgentOrigin())
        return { ok: false, error: '此工具仅允许用户本人运行' }
      let args: unknown = named.args
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          return { ok: false, error: '无效 JSON 参数' }
        }
      }
      if (!args || typeof args !== 'object' || Array.isArray(args))
        return { ok: false, error: '无效工具参数' }
      try {
        return {
          ok: true,
          task: createToolTask(tool, () => executeTool(tool.id, args as ToolArgs))
        }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : '无法开始任务' }
      }
    }
  },
  {
    name: 'toolbox.task',
    description: '读取文件工具任务和结果（仅内存）',
    logArgs: false,
    privacy: { reads: [P.content] },
    run: ({ named }) => {
      const task = named.id
        ? getToolTask(String(named.id))
        : getLatestToolTask(String(named.tool ?? ''))
      return { ok: true, payload: shield(P.content, task ?? null) }
    }
  },
  {
    name: 'toolbox.cancel',
    description: '取消工具箱文件任务',
    logArgs: false,
    privacy: { requires: [SCOPE_CONTROL] },
    run: ({ named }) => ({ ok: cancelToolTask(String(named.id ?? '')) })
  },
  {
    name: 'toolbox.export',
    logArgs: false,
    description: '将工具结果保存到用户选择的文件',
    privacy: { requires: [SCOPE_EXEC] },
    run: async ({ named }) => {
      const path = String(named.path ?? '')
      if (!path) return { ok: false, error: '缺少保存路径' }
      const base64 = String(named.base64 ?? '')
      const text = String(named.text ?? '')
      if (base64.length > MAX_PAYLOAD || text.length > MAX_PAYLOAD) {
        return { ok: false, error: '文件超过大小上限' }
      }
      try {
        if (named.base64 !== undefined && !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
          return { ok: false, error: '无效的 Base64' }
        }
        await writeFile(path, named.base64 !== undefined ? Buffer.from(base64, 'base64') : text)
        return { ok: true }
      } catch {
        return { ok: false, error: '无法保存文件，请检查目录与权限' }
      }
    }
  }
] satisfies CommandSpec[]
