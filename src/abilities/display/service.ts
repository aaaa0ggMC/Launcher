import { readdir } from 'fs/promises'
import { join, extname } from 'path'
import type { DisplayOutput, WallpaperFile } from './types'
import { run } from '../../main/process/util'
import { makeLogger } from '../../main/process/logger'

const log = makeLogger('display')

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

export async function listWallpapers(dir: string): Promise<WallpaperFile[]> {
  const files = await readdir(dir).catch(() => [])
  const out: WallpaperFile[] = []
  for (const name of files) {
    if (!IMAGE_EXTS.has(extname(name).toLowerCase())) continue
    out.push({ name, path: join(dir, name) })
  }
  log.info('wallpaper list result', {
    dir,
    count: out.length,
    skippedNonImage: files.length - out.length
  })
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function applyWallpaper(path: string): Promise<boolean> {
  const out = await run('plasma-apply-wallpaperimage', [path]).catch(() => '')
  const ok = !out.toLowerCase().includes('error')
  log.info('apply wallpaper result', { path, ok, commandOutput: out })
  return ok
}

export async function listOutputs(): Promise<DisplayOutput[]> {
  const out = await run('kscreen-doctor', ['-o']).catch(() => '')
  const lines = out.split('\n')
  const outputs: DisplayOutput[] = []
  let unparsed = 0
  for (const line of lines) {
    const m = line.match(/^Output:\s*\d+\s+(\S+)\s+\((enabled|disabled)\)/)
    if (!m) {
      if (line.trim()) unparsed++
      continue
    }
    outputs.push({
      name: m[1],
      description: m[1],
      connected: m[2] === 'enabled',
      enabled: m[2] === 'enabled'
    })
  }
  log.info('output list result', { count: outputs.length, rawLineCount: lines.length, unparsed })
  return outputs
}
