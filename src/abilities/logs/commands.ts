import type { CommandSpec } from '../../main/process/commands/types'
import type { LogLevel } from './types'
import { queryLogs, exportLogs, logAt, makeLogger } from '../../main/process/logger'

const log = makeLogger('logs')

export default [
  {
    name: 'logs.query',
    description:
      '查询当前会话日志 (--level --before --limit [--scope] [--exclude-scopes a,b] [--exclude-self])',
    usage: 'logs.query --level warn --limit 200 --exclude-self',
    run: async (ctx) => {
      const level = (ctx.named.level as LogLevel | undefined) ?? undefined
      const before = ctx.named.before !== undefined ? Number(ctx.named.before) : undefined
      const limit = ctx.named.limit !== undefined ? Number(ctx.named.limit) : undefined
      const scope = (ctx.named.scope as string | undefined) ?? undefined
      const excludeScopes =
        typeof ctx.named['exclude-scopes'] === 'string'
          ? ctx.named['exclude-scopes']
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined
      const excludeSelf =
        ctx.named['exclude-self'] === 'true' ||
        ctx.named['exclude-self'] === true ||
        ctx.named.excludeSelf === true
      return queryLogs({ level, before, limit, scope, excludeScopes, excludeSelf })
    }
  },
  {
    name: 'logs.export',
    description: '导出当前会话日志到文件 (--path [--level])',
    usage: 'logs.export --path /abs/session.log --level info',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      const level = (ctx.named.level as LogLevel | undefined) ?? undefined
      if (!path) {
        log.warn('logs.export failed', { error: '需要 --path' })
        return { ok: false, error: '需要 --path' }
      }
      const result = await exportLogs(path, { level })
      if (result.ok) log.info('logs.export', { path, count: result.count })
      else log.error('logs.export failed', { path, count: result.count, error: result.error })
      return result
    }
  },
  {
    name: 'logs.post',
    description: '提交一条日志 (--level --scope --message [--data <json>])',
    usage: 'logs.post --level error --scope renderer --message "boom"',
    run: async (ctx) => {
      const level = (ctx.named.level as LogLevel | undefined) ?? 'info'
      const scope = String(ctx.named.scope ?? 'renderer')
      const message = String(ctx.named.message ?? '')
      const data = ctx.named.data !== undefined ? JSON.parse(String(ctx.named.data)) : undefined
      logAt(level, scope, message, data)
      return { ok: true }
    }
  }
] satisfies CommandSpec[]
