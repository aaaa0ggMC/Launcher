import type { CommandSpec } from '../../main/process/commands/types'
import { listAutostart, toggleAutostart } from './service'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('autostart')

export default [
  {
    name: 'autostart.list',
    description: '列出开机自启动项',
    usage: 'autostart.list',
    run: async () => {
      const result = await listAutostart()
      return result
    }
  },
  {
    name: 'autostart.toggle',
    description: '启用/禁用启动项 (--file --hidden true|false)',
    usage: 'autostart.toggle --file "Clash Verge.desktop" --hidden true',
    run: async (ctx) => {
      const file = String(ctx.named.file ?? '')
      const hidden = ctx.named.hidden === 'true' || ctx.named.hidden === true
      if (!file) {
        log.warn('autostart.toggle', { ok: false, error: 'missing file' })
        return { ok: false, error: '需要 --file' }
      }
      await toggleAutostart(file, hidden)
      const result = await listAutostart()
      return result
    }
  }
] satisfies CommandSpec[]
