/**
 * Unified LRC & Karaoke parser for AIDJ (in-app lyrics page and floating desktop lyrics window).
 *
 * Supports:
 * - Standard line timestamps `[mm:ss.xx]`
 * - Per-word sub-timestamps `[00:12.00]Word[00:12.30]Word2` (karaoke inline tags)
 * - Leading repeated timestamps `[02:53][02:28][01:08]Chorus line`
 * - Offset tag `[offset:500]` (+/- ms shift)
 * - Empty boundary lines (instrumental interludes)
 */

export interface LyricChunk {
  /** Text fragment of a karaoke word or full line text */
  text: string
  /** Milliseconds at which this chunk becomes active (line-relative, raw LRC time with offset) */
  time: number
}

export interface LyricLine {
  /** Timestamp in milliseconds when the line starts */
  time: number
  /** Full text of the line (trimmed) */
  text: string
  /** Sub-timestamps for word-level karaoke fills (length > 1 indicates real karaoke) */
  chunks: LyricChunk[]
}

/**
 * Format milliseconds into standard LRC timestamp `mm:ss.xx` (2-digit minute padding).
 */
export function msToLrcTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const s = Math.floor(total / 1000)
  const m = Math.floor(s / 60)
  const frac = Math.floor((total % 1000) / 10)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(frac).padStart(2, '0')}`
}

/**
 * Parse an LRC timestamp match into milliseconds.
 */
export function parseLrcTimeTag(m: RegExpMatchArray): number {
  const frac = Number(m[3] ?? '0')
  return Number(m[1]) * 60000 + Number(m[2]) * 1000 + (frac < 100 ? frac * 10 : frac)
}

/**
 * Parse an LRC document into time-sorted lines with per-word karaoke chunks.
 */
export function parseLrc(lrc: string): LyricLine[] {
  if (!lrc || typeof lrc !== 'string') return []
  const lines: LyricLine[] = []
  let offset = 0

  for (const raw of lrc.split('\n')) {
    const line = raw.trim()
    if (!line) continue

    const off = line.match(/\[offset:([+-]?\d+)\]/)
    if (off) {
      offset = Number(off[1])
      continue
    }

    if (!line.match(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/)) continue

    const parts = line.split(/(\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\])/g)
    const chunks: LyricChunk[] = []
    const leadingTimes: number[] = []
    let pendingTime = 0
    let pendingText = ''

    const flush = (): void => {
      if (pendingText) {
        chunks.push({ text: pendingText, time: pendingTime + offset })
      }
      pendingText = ''
    }

    for (const part of parts) {
      const m = part.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]$/)
      if (m) {
        flush()
        const t = parseLrcTimeTag(m)
        if (!chunks.length) leadingTimes.push(t + offset)
        pendingTime = t
      } else {
        pendingText += part
      }
    }
    flush()

    // Multi-tag repeated chorus lines: `[02:53][02:28][01:08]Chorus`
    if (chunks.length === 1 && leadingTimes.length > 1) {
      for (const t of leadingTimes) {
        lines.push({
          time: t,
          text: chunks[0].text.trim(),
          chunks: [{ text: chunks[0].text, time: t }]
        })
      }
      continue
    }

    if (!chunks.length) {
      // Empty line with timestamp (instrumental gap / pause)
      lines.push({ time: pendingTime + offset, text: '', chunks: [] })
    } else {
      lines.push({
        time: chunks[0].time,
        text: chunks
          .map((c) => c.text)
          .join('')
          .trim(),
        chunks
      })
    }
  }

  return lines.sort((a, b) => a.time - b.time)
}

/**
 * Extract plain text lyrics by stripping all timestamp and offset metadata tags.
 */
export function extractPlainLyrics(lrc: string): string {
  if (!lrc || typeof lrc !== 'string') return ''
  return lrc
    .split('\n')
    .filter((line) => !line.trim().startsWith('[offset:'))
    .join('\n')
    .replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
    .trim()
}
