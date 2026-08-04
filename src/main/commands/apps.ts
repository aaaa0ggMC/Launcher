import { isAbsolute, join } from 'path'
import { mkdir } from 'fs/promises'
import type { AppEntry } from '../../shared/types'
import type { CommandSpec } from './types'
import {
  listAllApps,
  getEntry,
  updateEntry,
  deleteEntry,
  addSearchRoot,
  removeSearchRoot,
  getAppsConfig,
  writeRegistry
} from '../registry'
import { rescanRoot } from '../scanner'

export default [
  {
    name: 'apps.list',
    description: '列出所有搜索目录下的应用',
    usage: 'apps.list',
    run: async () => listAllApps()
  },
  {
    name: 'apps.get',
    description: '读取单个条目 (--root --id)',
    usage: 'apps.get --root ~/Apps --id bili-viewer',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const id = String(ctx.named.id ?? '')
      return await getEntry(root, id)
    }
  },
  {
    name: 'apps.config',
    description: '读取 Apps 能力配置 (搜索目录等)',
    usage: 'apps.config',
    run: async () => getAppsConfig()
  },
  {
    name: 'apps.update',
    description: '更新/创建条目 (--root --id --patch <json>)',
    usage: 'apps.update --root ~/Apps --id bili-viewer --patch {"name":"x"}',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const id = String(ctx.named.id ?? '')
      const patch = ctx.named.patch
      if (!root || !id) return { ok: false, error: '需要 --root 与 --id' }
      const p = typeof patch === 'string' ? JSON.parse(patch) : ((patch ?? {}) as Partial<AppEntry>)
      return await updateEntry(root, id, p)
    }
  },
  {
    name: 'apps.delete',
    description: '删除条目 (--root --id)',
    usage: 'apps.delete --root ~/Apps --id start-rdp',
    run: async (ctx) => {
      const root = String(ctx.named.root ?? '')
      const id = String(ctx.named.id ?? '')
      if (!root || !id) return { ok: false, error: '需要 --root 与 --id' }
      await deleteEntry(root, id)
      return { ok: true }
    }
  },
  {
    name: 'apps.add-root',
    description: '添加搜索目录 (--path)',
    usage: 'apps.add-root --path /home/aaaa0ggmc/Apps',
    run: async (ctx) => addSearchRoot(String(ctx.named.path ?? ''))
  },
  {
    name: 'apps.remove-root',
    description: '移除搜索目录 (--path)',
    usage: 'apps.remove-root --path /home/aaaa0ggmc/Apps',
    run: async (ctx) => removeSearchRoot(String(ctx.named.path ?? ''))
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
      if (!root || !id) return { ok: false, error: '需要 --root 与 --id' }
      const p = typeof patch === 'string' ? JSON.parse(patch) : ((patch ?? {}) as Partial<AppEntry>)
      // Optionally scaffold the project directory inside the search root.
      if (ctx.named.mkdir === true && p.path) {
        const target = isAbsolute(p.path) ? p.path : join(root, p.path)
        await mkdir(target, { recursive: true })
      }
      return await updateEntry(root, id, p)
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
  }
] satisfies CommandSpec[]
