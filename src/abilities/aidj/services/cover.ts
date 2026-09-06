import { readFile } from 'fs/promises'
import { join, extname, dirname } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const _coverCache = new Map<string, string>()

/** Common same-directory cover filenames checked BEFORE the embedded-cover path */
const COVER_FILENAMES = [
  'cover.jpg',
  'cover.png',
  'cover.jpeg',
  'folder.jpg',
  'folder.png',
  'front.jpg',
  'front.png'
]

export async function getCoverArt(filepath: string): Promise<string | null> {
  if (_coverCache.has(filepath)) return _coverCache.get(filepath) ?? null

  // 1. Same-directory cover file (cheap, no ffmpeg/ffprobe dependency)
  try {
    const dir = dirname(filepath)
    for (const name of COVER_FILENAMES) {
      try {
        const buf = await readFile(join(dir, name))
        const ext = extname(name).slice(1)
        const url = `data:image/${ext === 'jpg' || ext === 'jpeg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`
        _coverCache.set(filepath, url)
        return url
      } catch {
        /* not this filename — keep looking */
      }
    }
  } catch {
    /* unreadable dir — fall through to embedded */
  }

  // 2. Embedded cover (ID3/FLAC tags) via ffprobe/ffmpeg
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_streams',
      filepath
    ])
    const data = JSON.parse(stdout)
    const coverStream = (data.streams ?? []).find(
      (s: Record<string, unknown>) => (s as Record<string, unknown>).codec_type === 'video'
    )
    if (!coverStream) {
      _coverCache.set(filepath, '')
      return null
    }
    const { stdout: raw } = await execFileAsync(
      'ffmpeg',
      ['-i', filepath, '-an', '-vcodec', 'png', '-f', 'image2pipe', '-vframes', '1', 'pipe:1'],
      { maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' } as { encoding: 'buffer' }
    )
    const b64 = (raw as unknown as Buffer).toString('base64')
    const url = `data:image/png;base64,${b64}`
    _coverCache.set(filepath, url)
    return url
  } catch {
    _coverCache.set(filepath, '')
    return null
  }
}
