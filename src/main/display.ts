import { readdir } from 'fs/promises'
import { join, extname } from 'path'
import type { DisplayOutput, WallpaperFile } from '../shared/types'
import { run } from './util'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'])

export async function listWallpapers(dir: string): Promise<WallpaperFile[]> {
  const files = await readdir(dir).catch(() => [])
  const out: WallpaperFile[] = []
  for (const name of files) {
    if (!IMAGE_EXTS.has(extname(name).toLowerCase())) continue
    out.push({ name, path: join(dir, name) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export async function applyWallpaper(path: string): Promise<boolean> {
  const out = await run('plasma-apply-wallpaperimage', [path]).catch(() => '')
  return !out.toLowerCase().includes('error')
}

export async function listOutputs(): Promise<DisplayOutput[]> {
  const out = await run('kscreen-doctor', ['-o']).catch(() => '')
  const outputs: DisplayOutput[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^Output:\s*\d+\s+(\S+)\s+\((enabled|disabled)\)/)
    if (!m) continue
    outputs.push({
      name: m[1],
      description: m[1],
      connected: m[2] === 'enabled',
      enabled: m[2] === 'enabled'
    })
  }
  return outputs
}
