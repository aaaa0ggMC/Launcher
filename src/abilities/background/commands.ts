import type { CommandSpec } from '../../main/process/commands/types'
import type { BtTaskInfo } from '../../shared/types'
import {
  listTasks,
  getTaskOutput,
  clearTaskOutput,
  writeTaskInput,
  signalTask,
  stopTask,
  killTask,
  removeTask,
  clearFinishedTasks,
  startProcessTask,
  startJobByName,
  type StartProcessOptions
} from '../../main/process/background-tasks'
import './jobs'
import { makeLogger } from '../../main/process/logger'
import { writeTextFile } from '../../main/process/util'

const log = makeLogger('background')

/**
 * Background task framework commands. Unlike most abilities these are thin
 * wrappers over the framework service (src/main/process/background-tasks.ts) —
 * the primary API is programmatic (any ability can call startProcessTask /
 * startJobTask directly), the commands exist for the global UI panel + CLI.
 */
export default [
  {
    name: 'background.list',
    description: '列出所有后台任务',
    usage: 'background.list',
    run: async (): Promise<BtTaskInfo[]> => listTasks()
  },
  {
    name: 'background.output',
    description: '读取后台任务的缓冲输出 (--id)',
    usage: 'background.output --id bt-xxx',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      if (!id) {
        log.warn('background.output missing id')
        return { ok: false, error: '需要 --id' }
      }
      return { ok: true, id, messages: getTaskOutput(id) }
    }
  },
  {
    name: 'background.export',
    description: '导出后台任务的缓冲输出到文件 (--id --path)',
    usage: 'background.export --id bt-xxx --path /abs/output.log',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const path = String(ctx.named.path ?? '')
      if (!id || !path) {
        log.warn('background.export invalid args', { id, path })
        return { ok: false, error: '需要 --id 与 --path' }
      }
      const messages = getTaskOutput(id)
      const body = messages
        .map((m) => m.line ?? (m.data !== undefined ? JSON.stringify(m.data) : ''))
        .join('\n')
      const res = await writeTextFile(path, body)
      if (res.ok) log.info('background.export ok', { id, path, lines: messages.length })
      else log.error('background.export failed', { id, path, error: res.error })
      return { ...res, id, lines: messages.length }
    }
  },
  {
    name: 'background.clear-output',
    description: '清空后台任务的缓冲输出 (--id)',
    usage: 'background.clear-output --id bt-xxx',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const ok = clearTaskOutput(id)
      if (!ok) return { ok: false, error: `任务不存在: ${id}` }
      return { ok: true }
    }
  },
  {
    name: 'background.start',
    description:
      '启动一个进程后台任务 (--name --command <json argv | space-separated> [--cwd] [--description])',
    usage: 'background.start --name "ncm api" --command ["node","app.js"] --cwd ~/Apps/Music',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const command = ctx.named.command
      if (!name || !command) {
        log.warn('background.start invalid args', { name, command })
        return { ok: false, error: '需要 --name 与 --command' }
      }
      // Accept either a JSON argv array (UI) or a space-separated string (CLI).
      let argv: string[] = []
      if (Array.isArray(command)) {
        argv = command.map((c) => String(c))
      } else {
        const raw = String(command).trim()
        if (raw.startsWith('[')) {
          try {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) argv = parsed.map((c) => String(c))
          } catch {
            // fall through to space-split below
          }
        }
        if (!argv.length) argv = raw.split(/\s+/)
      }
      if (!argv.length) {
        log.warn('background.start empty command')
        return { ok: false, error: 'command 不能为空' }
      }
      const opts: StartProcessOptions = {
        name,
        description: ctx.named.description ? String(ctx.named.description) : undefined,
        argv,
        cwd: ctx.named.cwd ? String(ctx.named.cwd) : undefined
      }
      const task = startProcessTask(opts)
      log.info('background.start ok', { id: task.id, argv })
      return { ok: true, task }
    }
  },
  {
    name: 'background.input',
    description: '向后台任务写入 stdin (--id --data)',
    usage: 'background.input --id bt-xxx --data "y\\n"',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const data = String(ctx.named.data ?? '')
      const ok = writeTaskInput(id, data)
      if (!ok) return { ok: false, error: `任务不可输入: ${id}` }
      return { ok: true }
    }
  },
  {
    name: 'background.signal',
    description: '向后台任务发送信号 (--id --signal SIGINT)',
    usage: 'background.signal --id bt-xxx --signal SIGINT',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const signal = String(ctx.named.signal ?? 'SIGINT')
      const ok = signalTask(id, signal as NodeJS.Signals)
      if (!ok) return { ok: false, error: `无法向任务发送信号: ${id}` }
      return { ok: true, signal }
    }
  },
  {
    name: 'background.job',
    description: '启动一个注册的后台作业 (--name <handler> --args <json>), 如 download',
    usage:
      'background.job --name download --args {"name":"x","url":"https://...","out":"~/Downloads/x"}',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      if (!name) {
        log.warn('background.job missing name')
        return { ok: false, error: '需要 --name (注册的作业处理器名)' }
      }
      let args: Record<string, unknown> = {}
      if (typeof ctx.named.args === 'string' && ctx.named.args.trim()) {
        try {
          const parsed = JSON.parse(ctx.named.args)
          if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
        } catch (e) {
          log.warn('background.job bad args', { error: e instanceof Error ? e.message : String(e) })
          return { ok: false, error: '--args 不是合法 JSON' }
        }
      } else if (ctx.named.args && typeof ctx.named.args === 'object') {
        args = ctx.named.args as Record<string, unknown>
      }
      const task = await startJobByName(name, args)
      if (!task) return { ok: false, error: `未知作业处理器: ${name}` }
      log.info('background.job ok', { name, id: task.id })
      return { ok: true, task }
    }
  },
  {
    name: 'background.stop',
    description: '停止后台任务 (--id, 进程: SIGTERM→SIGKILL; 任务: 取消)',
    usage: 'background.stop --id bt-xxx',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const ok = await stopTask(id)
      if (!ok) return { ok: false, error: `任务不存在或未运行: ${id}` }
      log.info('background.stop', { id })
      return { ok: true }
    }
  },
  {
    name: 'background.kill',
    description: '强制结束后台进程任务 (--id, SIGKILL)',
    usage: 'background.kill --id bt-xxx',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const ok = killTask(id)
      if (!ok) return { ok: false, error: `无法强制结束任务: ${id}` }
      log.info('background.kill', { id })
      return { ok: true }
    }
  },
  {
    name: 'background.remove',
    description: '从列表移除已结束的后台任务 (--id)',
    usage: 'background.remove --id bt-xxx',
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      const ok = removeTask(id)
      if (!ok) return { ok: false, error: `任务不可移除: ${id}` }
      log.debug('background.remove', { id })
      return { ok: true }
    }
  },
  {
    name: 'background.clear-finished',
    description: '一键移除所有已停止/已结束的后台任务',
    usage: 'background.clear-finished',
    run: async () => {
      const n = clearFinishedTasks()
      log.info('background.clear-finished', { removed: n })
      return { ok: true, removed: n }
    }
  }
] satisfies CommandSpec[]
