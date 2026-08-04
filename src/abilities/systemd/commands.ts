import type { CommandSpec } from '../../main/process/commands/types'
import { listSystemd, systemdAction } from './service'

export default [
  {
    name: 'systemd.list',
    description: '列出用户 systemd 服务',
    usage: 'systemd.list',
    run: async () => listSystemd()
  },
  {
    name: 'systemd.action',
    description: '启动/停止/重启服务 (--name --action)',
    usage: 'systemd.action --name myservice --action restart',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const action = String(ctx.named.action ?? '') as 'start' | 'stop' | 'restart'
      if (!name) return { ok: false, error: '需要 --name' }
      return await systemdAction(name, action)
    }
  }
] satisfies CommandSpec[]
