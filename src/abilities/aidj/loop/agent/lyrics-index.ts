/**
 * Lyrics full-text index for the DJ kernel — the part a library-reading LLM
 * cannot do (lyrics are far too long to put in its prompt). Exact phrase
 * matching after normalization: lowercase, whitespace/punctuation removed,
 * simplified ⇄ traditional Chinese both accepted (query side expanded).
 */
import { extractPlainLyrics } from '../../parser/lrcParser'
import { textVariants } from '../../parser/chineseVariants'
import { resolveLyricForTrackPath } from '../../services/lyrics'

export interface LyricsIndex {
  /** Tracks that have lyrics. */
  size: number
  has: (key: string) => boolean
  /**
   * Match `phrases` (any-of, or all-of when `all`) against a track's lyrics.
   * Returns the first matching lyric line as a snippet, or null.
   */
  match: (key: string, phrases: string[], all?: boolean) => string | null
  /** First `maxLines` lyric lines (credits removed), or null. */
  excerpt: (key: string, maxLines: number) => string | null
}

const CREDIT =
  /^(作词|作詞|作曲|编曲|編曲|制作人|製作人|混音|母带|母帶|和声|和聲|吉他|贝斯|貝斯|鼓|弦乐|弦樂|录音|錄音|监制|監製|出品|lyrics?|composer|arranger|produced)\s*[:：]/i

function compact(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

interface Doc {
  lines: string[]
  compactLines: string[]
  joined: string
}

export function buildLyricsIndex(
  keys: Iterable<string>,
  paths: Map<string, string>,
  lyrics: Map<string, string>
): LyricsIndex {
  const docs = new Map<string, Doc>()
  for (const key of keys) {
    const lrc =
      lyrics.get(key) ??
      resolveLyricForTrackPath(paths.get(key) ?? null, key, lyrics, { fuzzy: false })
    if (!lrc) continue
    const lines = extractPlainLyrics(lrc)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('{') && !CREDIT.test(l))
    if (!lines.length) continue
    const compactLines = lines.map(compact)
    docs.set(key, { lines, compactLines, joined: compactLines.join('') })
  }
  const variantCache = new Map<string, string[]>()
  const variants = (p: string): string[] => {
    let v = variantCache.get(p)
    if (!v) {
      v = [...new Set(textVariants(p).map(compact))].filter(Boolean)
      variantCache.set(p, v)
    }
    return v
  }
  return {
    size: docs.size,
    has: (key) => docs.has(key),
    excerpt: (key, maxLines) => {
      const doc = docs.get(key)
      return doc ? doc.lines.slice(0, maxLines).join(' / ') : null
    },
    match: (key, phrases, all = false) => {
      const doc = docs.get(key)
      if (!doc || !phrases.length) return null
      let snippet: string | null = null
      for (const p of phrases) {
        const vs = variants(p)
        if (!vs.length) continue
        const hit = vs.some((v) => doc.joined.includes(v))
        if (!hit) {
          if (all) return null
          continue
        }
        if (snippet == null) {
          const i = doc.compactLines.findIndex((l) => vs.some((v) => l.includes(v)))
          snippet = i >= 0 ? doc.lines[i] : '(across lines)'
        }
        if (!all) return snippet
      }
      return snippet
    }
  }
}
