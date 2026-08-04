import type { CommandSpec } from '../../main/process/commands/types'
import { listSystemd, systemdAction } from './service'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('systemd')

export default [
  {
    name: 'systemd.list',
    description: '列出用户 systemd 服务',
    usage: 'systemd.list',
    run: async () => {
      const result = await listSystemd()
      log.info('systemd.list', { ok: true, count: result.length })
      return result
    }
  },
  {
    name: 'systemd.action',
    description: '启动/停止/重启服务 (--name --action)',
    usage: 'systemd.action --name myservice --action restart',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const action = String(ctx.named.action ?? '') as 'start' | 'stop' | 'restart'
      if (!name) {
        log.warn('systemd.action', { ok: false, error: 'missing name' })
        return { ok: false, error: '需要 --name' }
      }
      try {
        const result = await systemdAction(name, action)
        log.info('systemd.action', { ok: true, name, action })
        return result
      } catch (e) {
        log.error('systemd.action', {
          ok: false,
          name,
          action,
          error: e instanceof Error ? e.message : String(e)
        })
        throw e
      }
    }
  }
] satisfies CommandSpec[]
