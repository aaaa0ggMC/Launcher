import { startJobTask } from '../../main/process/background-tasks'
import { withToolSignal } from './execution-context'
import type { ToolDefinition, ToolResult, ToolTask } from './types'
export type { ToolTask } from './types'

interface Entry {
  task: ToolTask
  controller: AbortController
  completion: Promise<ToolResult>
  bytes: number
}
const entries = new Map<string, Entry>()
const latest = new Map<string, string>()
const MAX_CACHE = 192 * 1024 * 1024
function prune(): void {
  let bytes = [...entries.values()].reduce((n, item) => n + item.bytes, 0)
  for (const [id, entry] of entries) {
    if (bytes <= MAX_CACHE && entries.size <= 12) break
    if (entry.task.status === 'running') continue
    entries.delete(id)
    bytes -= entry.bytes
    if (latest.get(entry.task.tool) === id) latest.delete(entry.task.tool)
  }
}
export function createToolTask(
  tool: ToolDefinition,
  run: (signal: AbortSignal) => Promise<ToolResult>
): ToolTask {
  if ([...entries.values()].filter((entry) => entry.task.status === 'running').length >= 2) {
    throw new Error('最多同时运行两个文件转换任务 / At most two file jobs can run at once')
  }
  const controller = new AbortController()
  const control = startJobTask({
    name: tool.title,
    description: '本地工具箱 / Local Toolbox',
    onCancel: () => controller.abort()
  })
  const task: ToolTask = { id: control.id, tool: tool.id, status: 'running' }
  const entry: Entry = { task, controller, bytes: 0, completion: Promise.resolve({ ok: false }) }
  entries.set(task.id, entry)
  latest.set(tool.id, task.id)
  control.pushLine('本地处理中 / Processing locally')
  entry.completion = withToolSignal(controller.signal, async () => {
    let result: ToolResult
    try {
      result = await run(controller.signal)
    } catch {
      result = { ok: false, error: '文件转换失败 / File conversion failed' }
    }
    if (controller.signal.aborted) {
      result = { ok: false, error: '任务已取消 / Job cancelled' }
      task.status = 'cancelled'
      control.finish('cancelled')
    } else {
      task.status = 'done'
      control.pushLine(
        result.ok
          ? '处理完成，请返回工具页查看结果 / Complete; open the tool to see results'
          : '处理失败，请返回工具页查看详情 / Failed; open the tool for details'
      )
      control.finish(result.ok ? 'exited' : 'error')
    }
    // Content is never put in public background output, logs or persistent storage.
    task.result = result
    entry.bytes = JSON.stringify(result).length
    prune()
    return result
  })
  prune()
  return { id: task.id, tool: task.tool, status: task.status }
}
export function getToolTask(id: string): ToolTask | undefined {
  return entries.get(id)?.task
}
export function getLatestToolTask(tool: string): ToolTask | undefined {
  return getToolTask(latest.get(tool) ?? '')
}
export async function waitToolTask(id: string): Promise<ToolResult> {
  const entry = entries.get(id)
  return entry ? entry.completion : { ok: false, error: '任务不存在 / Job not found' }
}
export function stopToolTasks(): void {
  for (const entry of entries.values())
    if (entry.task.status === 'running') entry.controller.abort()
}
export function cancelToolTask(id: string): boolean {
  const entry = entries.get(id)
  if (!entry || entry.task.status !== 'running') return false
  entry.controller.abort()
  return true
}
