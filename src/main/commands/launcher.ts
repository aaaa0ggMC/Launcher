import type { AppEntry } from '../../shared/types'
import type { CommandSpec } from './types'
import { getEntry } from '../registry'
import { launchEntry, launchAction } from '../launcher'

/** Stream output when the entry opts into the live transformer display. */
function launchOpts(entry: AppEntry): { monitor: boolean } {
  return { monitor: Boolean(entry.transformer && entry.transformer_display) }
}

export default [
  {
    name: 'launch.run',
    description: '启动应用 (--root --id)',
    usage: 'launch.run --root ~/Apps --id bili-viewer',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const id = String(ctx.named.id ?? '')
      const entry = await getEntry(root, id)
      if (!entry) return { ok: false, error: `未找到条目: ${id}` }
      return await launchEntry(entry, launchOpts(entry))
    }
  },
  {
    name: 'launch.action',
    description: '运行应用的附加操作 (--root --id --action)',
    usage: 'launch.action --root ~/Apps --id new-api --action stop',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const id = String(ctx.named.id ?? '')
      const actionId = String(ctx.named.action ?? '')
      const entry = await getEntry(root, id)
      if (!entry) return { ok: false, error: `未找到条目: ${id}` }
      const action = entry.actions?.[actionId]
      if (!action) return { ok: false, error: `未找到操作: ${id}.${actionId}` }
      return await launchAction(entry, action, launchOpts(entry))
    }
  }
] satisfies CommandSpec[]
