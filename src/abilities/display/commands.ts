import type { CommandSpec } from '../../main/process/commands/types'
import { listWallpapers, applyWallpaper, listOutputs } from './service'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('display')

export default [
  {
    name: 'display.wallpapers',
    description: '列出壁纸 (--dir)',
    usage: 'display.wallpapers --dir ~/Pictures/Wallpapers',
    run: async (ctx) => {
      const dir = String(ctx.named.dir ?? '')
      const result = await listWallpapers(dir)
      return result
    }
  },
  {
    name: 'display.apply',
    description: '应用壁纸 (--path)',
    usage: 'display.apply --path /abs/to/wallpaper.jpg',
    run: async (ctx) => {
      const path = String(ctx.named.path ?? '')
      if (!path) {
        log.warn('display.apply', { ok: false, error: 'missing path' })
        return { ok: false, error: '需要 --path' }
      }
      const ok = await applyWallpaper(path)
      return { ok }
    }
  },
  {
    name: 'display.outputs',
    description: '列出显示输出',
    usage: 'display.outputs',
    run: async () => {
      const result = await listOutputs()
      return result
    }
  }
] satisfies CommandSpec[]

export const platforms = ['linux']
