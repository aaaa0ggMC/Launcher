import type { CommandSpec } from './types'
import { listAutostart, toggleAutostart } from '../autostart'

export default [
  {
    name: 'autostart.list',
    description: '列出开机自启动项',
    usage: 'autostart.list',
    run: async () => listAutostart()
  },
  {
    name: 'autostart.toggle',
    description: '启用/禁用启动项 (--file --hidden true|false)',
    usage: 'autostart.toggle --file "Clash Verge.desktop" --hidden true',
    run: async (ctx) => {
      const file = String(ctx.named.file ?? '')
      const hidden = ctx.named.hidden === 'true' || ctx.named.hidden === true
      if (!file) return { ok: false, error: '需要 --file' }
      await toggleAutostart(file, hidden)
      return await listAutostart()
    }
  }
] satisfies CommandSpec[]
