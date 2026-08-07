import type { CommandSpec } from '../../main/process/commands/types'
import { listFtPresets, loadFtPreset, loadFtFile, exportFtFile } from './presets'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('ft')

export default [
  {
    name: 'ft.presets',
    description: '列出傅里叶预设',
    usage: 'ft.presets',
    run: async () => {
      const presets = listFtPresets()
      return presets
    }
  },
  {
    name: 'ft.load',
    description: '加载傅里叶预设 (--name <circle|square|heart|...> [--mode 2d|3d])',
    usage: 'ft.load --name heart',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const mode = ctx.named.mode === '3d' ? '3d' : '2d'
      const preset = loadFtPreset(name, mode)
      if (!preset) {
        log.warn('ft.load failed', { name, error: `未知预设: ${name}` })
        return { ok: false, error: `未知预设: ${name}` }
      }
      return preset
    }
  },
  {
    name: 'ft.load-file',
    description: '从 JSON 文件加载矢量 (--path)',
    usage: 'ft.load-file --path /abs/vectors.json',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      const result = await loadFtFile(path)
      if (result.ok) log.info('ft.load-file', { path, count: result.vectors?.length ?? 0 })
      else log.error('ft.load-file failed', { path, error: result.error })
      return result
    }
  },
  {
    name: 'ft.export',
    description: '导出矢量到 JSON 文件 (--path --data <json>)',
    usage: 'ft.export --path /abs/vectors.json --data {"vectors":[]}',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      const data = ctx.named.data
      if (!path) {
        log.warn('ft.export failed', { error: '需要 --path' })
        return { ok: false, error: '需要 --path' }
      }
      const result = await exportFtFile(path, typeof data === 'string' ? JSON.parse(data) : data)
      if (!result.ok) log.error('ft.export failed', { path, error: result.error })
      return result
    }
  }
] satisfies CommandSpec[]
