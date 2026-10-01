/** Library search for AIDJ: graded matching (exact / substring / tokens / fuzzy). */

export interface LibrarySearchHit {
  name: string
  score: number
  matched: 'exact' | 'substring' | 'tokens' | 'fuzzy'
}

export interface LibrarySearchOptions {
  /** Max hits returned (default 20). */
  limit?: number
  /** Extra searchable text for a name (e.g. metadata artist/album). */
  extra?: (name: string) => string
}

const DEFAULT_LIMIT = 20
/** Score bands per tier. Fuzzy lands below SUBSTRING_MIN by construction. */
const EXACT_SCORE = 100
const SUBSTRING_MIN = 90
const TOKENS_MIN = 80
const FUZZY_MIN = 70
/** Penalty for hits found only in the `extra` text, not the name itself. */
const EXTRA_PENALTY = 10

const SEPARATOR_RE = /[\s\-_·・,，、;；.。'"「」『』()[\]（）]+/

/** NFKC + lowercase + collapsed whitespace, so fullwidth/case variants compare equal. */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Split normalized text into unique tokens (order preserved). */
export function splitTokens(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of text.split(SEPARATOR_RE)) {
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/** Plain Levenshtein distance (two rolling rows). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j)
  let curr: number[] = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1] : Math.min(prev[j - 1], prev[j], curr[j - 1]) + 1
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]
}

/** Whole-string similarity in [0, 100]. */
function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 0
  return Math.round((1 - levenshtein(a, b) / maxLen) * 100)
}

/**
 * Partial similarity: best match of the query against an equal-length window of
 * the candidate, a whole candidate token, or the candidate itself.
 */
function partialSimilarity(query: string, candidate: string): number {
  if (!query || !candidate) return 0
  let best = similarity(query, candidate)
  const qLen = query.length
  for (let i = 0; i + qLen <= candidate.length; i++) {
    const sim = similarity(query, candidate.slice(i, i + qLen))
    if (sim > best) best = sim
    if (best === 100) break
  }
  if (best < 100) {
    for (const tok of candidate.split(SEPARATOR_RE)) {
      if (!tok) continue
      const sim = similarity(query, tok)
      if (sim > best) best = sim
      if (best === 100) break
    }
  }
  return best
}

/** Reward earlier / more dominant matches, mapped into a band of width `span`. */
function bandScore(
  base: number,
  span: number,
  position: number,
  length: number,
  cover: number
): number {
  const posFactor = length > 0 ? 1 - Math.min(1, position / length) : 1
  const factor = 0.5 * posFactor + 0.5 * Math.min(1, cover)
  return Math.min(base + span, base + Math.floor(factor * span))
}

interface Scored {
  name: string
  score: number
  matched: LibrarySearchHit['matched']
}

function scoreCandidate(
  normQuery: string,
  name: string,
  normName: string,
  haystack: string,
  out: Scored[]
): void {
  if (normName === normQuery) {
    out.push({ name, score: EXACT_SCORE, matched: 'exact' })
    return
  }
  const idx = haystack.indexOf(normQuery)
  if (idx >= 0) {
    const score = bandScore(
      SUBSTRING_MIN,
      9,
      idx,
      haystack.length,
      normQuery.length / haystack.length
    )
    out.push({ name, score, matched: 'substring' })
    return
  }
  const queryTokens = splitTokens(normQuery)
  if (queryTokens.length === 0) return
  let firstIdx = -1
  let covered = 0
  const allFound = queryTokens.every((tok) => {
    const at = haystack.indexOf(tok)
    if (at < 0) return false
    if (firstIdx < 0 || at < firstIdx) firstIdx = at
    covered += tok.length
    return true
  })
  if (allFound) {
    const score = bandScore(TOKENS_MIN, 9, firstIdx, haystack.length, covered / haystack.length)
    out.push({ name, score, matched: 'tokens' })
  }
}

/**
 * Search `names` for `query` with graded matching. Fuzzy matching only runs when
 * no exact/substring/tokens hit exists, so it acts purely as a fallback.
 */
export function searchLibrary(
  query: string,
  names: string[],
  opts?: LibrarySearchOptions
): LibrarySearchHit[] {
  const normQuery = normalizeText(query)
  if (!normQuery || !names.length) return []
  const limit = Math.max(1, Math.floor(opts?.limit ?? DEFAULT_LIMIT))

  const hits: Scored[] = []
  const fuzzy: Scored[] = []
  for (const name of names) {
    const normName = normalizeText(name)
    if (!normName) continue
    const extra = opts?.extra?.(name) ?? ''
    const haystack = extra.trim() ? `${normName} ${normalizeText(extra)}` : normName
    const before = hits.length
    scoreCandidate(normQuery, name, normName, normName, hits)
    if (hits.length === before && haystack !== normName) {
      // 只命中附加文本（元数据）的排在命中歌名的后面
      scoreCandidate(normQuery, name, normName, haystack, hits)
      if (hits.length > before) hits[before].score -= EXTRA_PENALTY
    }
    if (hits.length === before) fuzzy.push({ name, score: 0, matched: 'fuzzy' })
  }

  const pool = hits.length > 0 ? hits : fuzzy
  if (hits.length === 0) {
    for (const entry of fuzzy) {
      const normName = normalizeText(entry.name)
      const extra = opts?.extra?.(entry.name) ?? ''
      const haystack = extra.trim() ? `${normName} ${normalizeText(extra)}` : normName
      entry.score = partialSimilarity(normQuery, haystack)
    }
  }

  return pool
    .filter((h) => h.score >= FUZZY_MIN)
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length)
    .slice(0, limit)
    .map(({ name, score, matched }) => ({ name, score, matched }))
}
