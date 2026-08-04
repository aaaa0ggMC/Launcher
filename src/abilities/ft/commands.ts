import type { CommandSpec } from '../../main/process/commands/types'
import { listFtPresets, loadFtPreset } from './presets'

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
  }
] satisfies CommandSpec[]
