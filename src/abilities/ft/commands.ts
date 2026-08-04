import type { CommandSpec } from '../../main/process/commands/types'
import { listFtPresets, loadFtPreset, loadFtFile, exportFtFile } from './presets'

export default [
  {
    name: 'ft.presets',
    description: '列出傅里叶预设',
    usage: 'ft.presets',
    run: async () => listFtPresets()
  },
  {
    name: 'ft.load',
    description: '加载傅里叶预设 (--name <circle|square|heart|...>)',
    usage: 'ft.load --name heart',
    run: async (ctx) => {
      const name = String(ctx.named.name ?? '')
      const preset = loadFtPreset(name)
      if (!preset) return { ok: false, error: `未知预设: ${name}` }
      return preset
    }
  },
  {
    name: 'ft.load-file',
    description: '从 JSON 文件加载矢量 (--path)',
    usage: 'ft.load-file --path /abs/vectors.json',
    run: async (ctx) => loadFtFile(String(ctx.named.path ?? ''))
  },
  {
    name: 'ft.export',
    description: '导出矢量到 JSON 文件 (--path --data <json>)',
    usage: 'ft.export --path /abs/vectors.json --data {"vectors":[]}',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      const data = ctx.named.data
      if (!path) return { ok: false, error: '需要 --path' }
      return await exportFtFile(path, typeof data === 'string' ? JSON.parse(data) : data)
    }
  }
] satisfies CommandSpec[]
