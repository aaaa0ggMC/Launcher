import { isAbsolute, join } from 'path'
import { mkdir } from 'fs/promises'
import type { AppEntry } from './types'
import type { CommandSpec } from '../../main/process/commands/types'
import {
  listAllApps,
  getEntry,
  updateEntry,
  deleteEntry,
  addSearchRoot,
  removeSearchRoot,
  getAppsConfig,
  writeRegistry
} from './registry'
import { rescanRoot } from './scanner'
import { launchEntry, launchAction } from './launcher'
import { makeLogger } from '../../main/process/logger'
import './cli'

const log = makeLogger('apps')

/** Stream output when the entry opts into the live transformer display. */
function launchOpts(entry: AppEntry): { monitor: boolean } {
  return { monitor: Boolean(entry.transformer && entry.transformer_display) }
}

export default [
  {
    name: 'apps.list',
    description: '列出所有搜索目录下的应用',
    usage: 'apps.list',
    run: async () => {
      const r = await listAllApps()
      return r
    }
  },
  {
    name: 'apps.get',
    description: '读取单个条目 (--root --id)',
    usage: 'apps.get --root ~/Apps --id bili-viewer',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const id = String(ctx.named.id ?? '')
      const entry = await getEntry(root, id)
      return entry
    }
  },
  {
    name: 'apps.config',
    description: '读取 Apps 能力配置 (搜索目录等)',
    usage: 'apps.config',
    run: async () => {
      const r = await getAppsConfig()
      return r
    }
  },
  {
    name: 'apps.update',
    description: '更新/创建条目 (--root --id --patch <json>)',
    usage: 'apps.update --root ~/Apps --id bili-viewer --patch {"name":"x"}',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const id = String(ctx.named.id ?? '')
      const patch = ctx.named.patch
      if (!root || !id) {
        log.warn('apps.update invalid args', { root, id })
        return { ok: false, error: '需要 --root 与 --id' }
      }
      const p = typeof patch === 'string' ? JSON.parse(patch) : ((patch ?? {}) as Partial<AppEntry>)
      const r = await updateEntry(root, id, p)
      return r
    }
  },
  {
    name: 'apps.delete',
    description: '删除条目 (--root --id)',
    usage: 'apps.delete --root ~/Apps --id start-rdp',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const id = String(ctx.named.id ?? '')
      if (!root || !id) {
        log.warn('apps.delete invalid args', { root, id })
        return { ok: false, error: '需要 --root 与 --id' }
      }
      await deleteEntry(root, id)
      return { ok: true }
    }
  },
  {
    name: 'apps.add-root',
    description: '添加搜索目录 (--path)',
    usage: 'apps.add-root --path /home/aaaa0ggmc/Apps',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      const r = await addSearchRoot(path)
      return r
    }
  },
  {
    name: 'apps.remove-root',
    description: '移除搜索目录 (--path)',
    usage: 'apps.remove-root --path /home/aaaa0ggmc/Apps',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      const r = await removeSearchRoot(path)
      return r
    }
  },
  {
    name: 'apps.create',
    description: '创建新条目 (--root --id --patch <json> [--mkdir true])',
    usage:
      'apps.create --root ~/Apps --id myapp --patch {"name":"My App","exec":{"type":"custom","command":["run.sh"]}}',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const id = String(ctx.named.id ?? '')
      const patch = ctx.named.patch
      if (!root || !id) {
        log.warn('apps.create invalid args', { root, id })
        return { ok: false, error: '需要 --root 与 --id' }
      }
      const p = typeof patch === 'string' ? JSON.parse(patch) : ((patch ?? {}) as Partial<AppEntry>)
      // Optionally scaffold the project directory inside the search root.
      if (ctx.named.mkdir === true && p.path) {
        const target = isAbsolute(p.path) ? p.path : join(root, p.path)
        await mkdir(target, { recursive: true })
      }
      const r = await updateEntry(root, id, p)
      return r
    }
  },
  {
    name: 'apps.rescan',
    description: '重扫目录生成草稿 (--root)',
    usage: 'apps.rescan --root /home/aaaa0ggmc/Apps',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const reg = await rescanRoot(root)
      await writeRegistry(root, reg)
      return reg
    }
  },
  {
    name: 'launch.run',
    description: '启动应用 (--root --id)',
    usage: 'launch.run --root ~/Apps --id bili-viewer',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const id = String(ctx.named.id ?? '')
      const entry = await getEntry(root, id)
      if (!entry) {
        log.warn('launch.run entry not found', { root, id })
        return { ok: false, error: `未找到条目: ${id}` }
      }
      const r = await launchEntry(entry, launchOpts(entry))
      return r
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
      if (!entry) {
        log.warn('launch.action entry not found', { root, id, actionId })
        return { ok: false, error: `未找到条目: ${id}` }
      }
      const action = entry.actions?.[actionId]
      if (!action) {
        log.warn('launch.action action not found', { root, id, actionId })
        return { ok: false, error: `未找到操作: ${id}.${actionId}` }
      }
      const r = await launchAction(entry, action, launchOpts(entry))
      return r
    }
  }
] satisfies CommandSpec[]
