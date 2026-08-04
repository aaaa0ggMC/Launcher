import type { CommandSpec } from '../../main/process/commands/types'
import { listWallpapers, applyWallpaper, listOutputs } from './service'

export default [
  {
    name: 'display.wallpapers',
    description: '列出壁纸 (--dir)',
    usage: 'display.wallpapers --dir ~/Pictures/Wallpapers',
    run: async (ctx) => listWallpapers(String(ctx.named.dir ?? ''))
  },
  {
    name: 'display.apply',
    description: '应用壁纸 (--path)',
    usage: 'display.apply --path /abs/to/wallpaper.jpg',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      if (!path) return { ok: false, error: '需要 --path' }
      return { ok: await applyWallpaper(path) }
    }
  },
  {
    name: 'display.outputs',
    description: '列出显示输出',
    usage: 'display.outputs',
    run: async () => listOutputs()
  }
] satisfies CommandSpec[]
