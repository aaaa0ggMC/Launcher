import { Converter } from 'opencc-js'

/**
 * Simplified ⇄ Traditional Chinese fuzzy matching for the `/filter` command.
 *
 * Song names and lyrics often mix variants (the music file may be simplified
 * 「周杰伦」while the lyric text is traditional 「周杰倫」). Instead of requiring
 * the query to match the exact variant, every haystack is expanded into BOTH
 * variants before the substring match runs — so a simplified query hits
 * traditional text and vice versa, with no conversion on the query side.
 */

const toCn = Converter({ from: 'tw', to: 'cn' })
const toTw = Converter({ from: 'cn', to: 'tw' })

function variantOf(text: string): string {
  return `${toCn(text)}\n${toTw(text)}`.toLowerCase()
}

const cache = new Map<string, { len: number; value: string }>()

/**
 * Cache capacity (number of entries). Sized by the caller to fit the whole
 * library (see `aidj.filter`): a capacity that fits all songs means the cache
 * survives one full scan and every later filter run hits it. When the library
 * is too large to fit the budget, the caller sets capacity to 0 and caching is
 * disabled entirely — a cache that gets cleared mid-run (build + clear thrash)
 * would waste CPU re-converting everything AND hold memory for nothing.
 */
let capacity = 20000

/** Set the cache capacity. 0 disables caching. Clears when it must shrink. */
export function setVariantCacheCapacity(entries: number): void {
  capacity = Math.max(0, Math.floor(entries))
  if (cache.size > capacity) cache.clear()
}

/** Cached, lowercased, both-variant haystack for `text` (keyed by `name`). */
export function cachedVariantHaystack(name: string, text: string): string {
  if (capacity === 0) return variantOf(text)
  const cur = cache.get(name)
  if (cur && cur.len === text.length) return cur.value
  const value = variantOf(text)
  if (cache.size >= capacity) cache.clear()
  cache.set(name, { len: text.length, value })
  return value
}
