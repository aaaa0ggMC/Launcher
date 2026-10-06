import { stat } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { basename, extname } from 'path'
import type { SongFileInfo } from '../types'

const execFileAsync = promisify(execFile)

/** Tags worth surfacing, in display order. Everything else is dropped. */
const TAG_KEYS = [
  'title',
  'artist',
  'album',
  'album_artist',
  'date',
  'genre',
  'track',
  'composer',
  'comment'
]

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Pure: turn `ffprobe -show_format -show_streams` JSON into SongFileInfo fields. */
export function parseProbe(
  data: unknown
): Pick<
  SongFileInfo,
  'duration' | 'bitRate' | 'format' | 'codec' | 'sampleRate' | 'channels' | 'tags'
> {
  const d = (data ?? {}) as {
    format?: Record<string, unknown>
    streams?: Record<string, unknown>[]
  }
  const fmt = d.format ?? {}
  const audio = (d.streams ?? []).find((s) => s?.codec_type === 'audio') ?? {}
  // Tags live on the container for mp3/flac, on the stream for ogg/opus; keys
  // differ in case between formats (TITLE vs title).
  const tags: Record<string, string> = {}
  for (const src of [audio.tags, fmt.tags]) {
    if (!src || typeof src !== 'object') continue
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      const key = k.toLowerCase()
      if (!TAG_KEYS.includes(key) || tags[key] || typeof v !== 'string' || !v.trim()) continue
      tags[key] = v.trim()
    }
  }
  const ordered: Record<string, string> = {}
  for (const k of TAG_KEYS) if (tags[k]) ordered[k] = tags[k]
  return {
    duration: num(fmt.duration) ?? num(audio.duration),
    bitRate: num(fmt.bit_rate) ?? num(audio.bit_rate),
    format: typeof fmt.format_name === 'string' ? fmt.format_name : null,
    codec: typeof audio.codec_name === 'string' ? audio.codec_name : null,
    sampleRate: num(audio.sample_rate),
    channels: num(audio.channels),
    tags: ordered
  }
}

/** Read one file's info. Never throws: missing ffprobe just leaves fields null. */
export async function getSongFileInfo(path: string): Promise<SongFileInfo> {
  const name = basename(path, extname(path))
  const st = await stat(path).catch(() => null)
  let probed: ReturnType<typeof parseProbe> = parseProbe(null)
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path],
      { maxBuffer: 4 * 1024 * 1024 }
    )
    probed = parseProbe(JSON.parse(stdout))
  } catch {
    /* ffprobe missing or unreadable file — keep the nulls */
  }
  return { name, path, size: st ? st.size : null, ...probed }
}
