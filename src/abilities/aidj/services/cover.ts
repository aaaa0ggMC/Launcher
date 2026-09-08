import { readFile } from 'fs/promises'
import { join, extname, dirname, basename } from 'path'
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

export function invalidateCoverCache(filepath?: string): void {
  if (filepath) _coverCache.delete(filepath)
  else _coverCache.clear()
}

export async function getCoverArt(filepath: string): Promise<string | null> {
  if (_coverCache.has(filepath)) return _coverCache.get(filepath) ?? null

  const dir = dirname(filepath)
  const ext = extname(filepath)
  const baseName = basename(filepath, ext)

  const candidateNames = [
    `${baseName}.jpg`,
    `${baseName}.png`,
    `${baseName}.jpeg`,
    `${baseName}.webp`,
    ...COVER_FILENAMES
  ]

  // 1. Same-directory cover file (cheap, no ffmpeg/ffprobe dependency)
  try {
    for (const name of candidateNames) {
      try {
        const buf = await readFile(join(dir, name))
        const fileExt = extname(name).slice(1).toLowerCase()
        const mime =
          fileExt === 'jpg' || fileExt === 'jpeg'
            ? 'jpeg'
            : fileExt === 'png'
              ? 'png'
              : fileExt === 'webp'
                ? 'webp'
                : 'jpeg'
        const url = `data:image/${mime};base64,${buf.toString('base64')}`
        _coverCache.set(filepath, url)
        return url
      } catch {
        /* not this filename — keep looking */
      }
    }
  } catch {
    /* unreadable dir — fall through to embedded */
  }

  // 2. Embedded cover (ID3/FLAC tags) or video frame via ffprobe/ffmpeg
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

    const isVideo = ['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext.toLowerCase())
    let raw: Buffer | null = null

    if (isVideo) {
      // Seek past the typical black opening / logo frame (e.g. 2s)
      try {
        const res = await execFileAsync(
          'ffmpeg',
          [
            '-ss',
            '00:00:02',
            '-i',
            filepath,
            '-an',
            '-vcodec',
            'png',
            '-f',
            'image2pipe',
            '-vframes',
            '1',
            'pipe:1'
          ],
          { maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' } as { encoding: 'buffer' }
        )
        raw = res.stdout as unknown as Buffer
      } catch {
        // Shorter video or seek error fallback to frame 0
      }
    }

    if (!raw) {
      const res = await execFileAsync(
        'ffmpeg',
        ['-i', filepath, '-an', '-vcodec', 'png', '-f', 'image2pipe', '-vframes', '1', 'pipe:1'],
        { maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' } as { encoding: 'buffer' }
      )
      raw = res.stdout as unknown as Buffer
    }

    const b64 = raw.toString('base64')
    const url = `data:image/png;base64,${b64}`
    _coverCache.set(filepath, url)
    return url
  } catch {
    _coverCache.set(filepath, '')
    return null
  }
}
