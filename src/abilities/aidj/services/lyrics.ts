import { appendFile } from 'fs/promises'
import { basename, extname } from 'path'
import { msToLrcTime } from '../parser/lrcParser'
import { ensureAidjDir, getLyricsPath } from './config'

export { msToLrcTime }

/**
 * Convert Netease's YRC (karaoke) JSON format into an inline-timestamp LRC.
 * YRC is one JSON object per line — `{ "t": <lineStartMs>, "c": [{ "t": <wordStartMs>, "c": "字" }, ...] }`.
 */
export function yrcToInlineLrc(yrc: string): string {
  if (!yrc || typeof yrc !== 'string') return ''
  const out: string[] = []
  for (const raw of yrc.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let parsed: { t?: unknown; c?: unknown }
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const lineMs = Number(parsed.t)
    if (!Number.isFinite(lineMs) || !Array.isArray(parsed.c)) continue
    const words = parsed.c.filter(
      (w): w is { t?: unknown; c?: unknown } => w !== null && typeof w === 'object'
    )
    const text = words.map((w) => (typeof w.c === 'string' ? w.c : '')).join('')
    if (!text) continue
    let buf = `[${msToLrcTime(lineMs)}]`
    for (const w of words) {
      const wt = Number(w.t)
      const ch = typeof w.c === 'string' ? w.c : ''
      if (ch) buf += Number.isFinite(wt) ? `[${msToLrcTime(wt)}]${ch}` : ch
    }
    out.push(buf)
  }
  return out.join('\n')
}

/**
 * Local Netease `.yrc` files use bracket karaoke format:
 * `[lineStart,lineDur](wordStart,wordDur,vol)word (wordStart2,...)word2`
 */
export function localYrcToInlineLrc(yrc: string): string {
  if (!yrc || typeof yrc !== 'string') return ''
  const out: string[] = []
  for (const raw of yrc.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('{')) continue
    const m = line.match(/^\[(\d+),\d+\]([\s\S]*)$/)
    if (!m) continue
    const lineMs = Number(m[1])
    if (!Number.isFinite(lineMs)) continue
    const rest = m[2]
    let buf = `[${msToLrcTime(lineMs)}]`
    const re = /\((\d+),\d+,\d+\)/g
    const groups: { start: number; end: number; time: number }[] = []
    let wm: RegExpExecArray | null
    while ((wm = re.exec(rest))) {
      groups.push({ start: wm.index, end: wm.index + wm[0].length, time: Number(wm[1]) })
    }
    let hasWord = false
    for (let i = 0; i < groups.length; i++) {
      const end = i + 1 < groups.length ? groups[i + 1].start : undefined
      const text = rest.slice(groups[i].end, end)
      if (text) {
        hasWord = true
        buf += `[${msToLrcTime(groups[i].time)}]${text}`
      }
    }
    if (hasWord) out.push(buf)
  }
  return out.join('\n')
}

/**
 * Plain LRC (line timestamps only) from a local `.yrc`.
 */
export function localYrcToLrc(yrc: string): string {
  if (!yrc || typeof yrc !== 'string') return ''
  const out: string[] = []
  for (const raw of yrc.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('{')) continue
    const m = line.match(/^\[(\d+),\d+\]([\s\S]*)$/)
    if (!m) continue
    const text = m[2].replace(/\(\d+,\d+,\d+\)/g, '').trim()
    if (!text) continue
    out.push(`[${msToLrcTime(Number(m[1]))}]${text}`)
  }
  return out.join('\n')
}

export async function appendLyric(
  name: string,
  lyric: string,
  karaoke?: string | null
): Promise<void> {
  if (!lyric) return
  await ensureAidjDir()
  const line = JSON.stringify({ name, lyric, ...(karaoke ? { karaoke } : {}) }) + '\n'
  await appendFile(getLyricsPath(), line, 'utf-8')
}

/**
 * Resolve LRC text for a DBus-reported track title. Exact match first,
 * then punctuation stripped, then title anchor fallback, then substring match.
 */
export function resolveLyricForTrack(track: string, lyrics: Map<string, string>): string | null {
  if (!track) return null
  const t = track.trim()
  if (lyrics.has(t)) return lyrics.get(t) ?? null
  const cleaned = t.replace(/[（）()【】[\]]/g, ' ')
  const parts = cleaned.split(/\s+-\s+/).filter(Boolean)
  const title = parts.length > 1 ? parts[parts.length - 1].trim() : cleaned.trim()
  if (title && lyrics.has(title)) return lyrics.get(title) ?? null
  const compact = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  let best: string | null = null
  let bestLen = Infinity
  if (compact.length >= 3) {
    for (const [name, lrc] of lyrics) {
      const key = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
      if (key.includes(compact) && key.length < bestLen) {
        best = lrc
        bestLen = key.length
      }
    }
  }
  return best
}

/**
 * Resolve LRC text by on-disk track path or track title.
 */
export function resolveLyricForTrackPath(
  path: string | null,
  track: string,
  lyrics: Map<string, string>,
  opts?: { fuzzy?: boolean }
): string | null {
  if (path) {
    const ext = extname(path).toLowerCase()
    const isVideo = ext === '.mp4' || ext === '.mkv' || ext === '.webm' || ext === '.avi'
    const isBili = path.includes('/Bilibili/') || path.includes('\\Bilibili\\')

    const name = basename(path)
      .replace(/\.[^.]+$/, '')
      .trim()
    if (name && lyrics.has(name)) return lyrics.get(name) ?? null

    // For video files or Bilibili downloads, lyrics represent video subtitles.
    // If no subtitles were saved for this specific file, do NOT match unrelated audio songs!
    if (isVideo || isBili) {
      return null
    }

    const titleOnly = name.replace(/^.+?\s+-\s+/, '').trim()
    if (titleOnly && titleOnly !== name && lyrics.has(titleOnly)) {
      return lyrics.get(titleOnly) ?? null
    }
  }
  if (opts?.fuzzy === false) return null
  return resolveLyricForTrack(track, lyrics)
}

/**
 * Resolve on-disk file path from detail url and musicPaths map.
 */
export function resolveTrackPath(
  detail: { url?: string; track?: string },
  musicPaths: Map<string, string>
): string | null {
  const url = detail.url ?? ''
  if (url.startsWith('file://')) {
    let p = url.slice('file://'.length)
    if (p.startsWith('localhost/')) p = p.slice('localhost/'.length)
    p = p.split('?')[0]?.split('#')[0] ?? p
    try {
      return decodeURIComponent(p)
    } catch {
      return p
    }
  }
  if (!detail.track) return null
  if (musicPaths.has(detail.track)) return musicPaths.get(detail.track) ?? null
  const base = detail.track
    .replace(/\s+-\s+.+$/, '')
    .replace(/[（）()【】[\]]/g, ' ')
    .trim()
  if (base && base !== detail.track && musicPaths.has(base)) return musicPaths.get(base) ?? null
  return null
}
