/**
 * Artist-diversity helpers for the DJ loop.
 *
 * Library keys are usually `"Artist[,Artist2] - Title"` (some are reversed, see
 * `configureArtistOrientation`). LLMs pick neighbouring lines
 * from a long list, so an alphabetical library (all 61 C418 tracks in one run)
 * makes them chain the same artist. These helpers (1) order the library so that
 * neighbours share a MOOD rather than an artist, and (2) cap / de-cluster
 * artists in a generated batch.
 */
import type { PlaylistEntry, SongMeta } from '../types'

export type LibraryOrder = 'emotion' | 'genre' | 'alpha'

function splitArtists(part: string): string[] {
  return part
    .split(/\s*[,，、&/]\s*|\s+(?:feat\.?|ft\.?)\s+/i)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Keys written "Title - Artist" (e.g. `七里香 - 周杰伦`) instead of the usual
 * "Artist - Title". Detected library-wide by `configureArtistOrientation`: the
 * right side recurs (≥ 4 times) while the left side is essentially unique.
 */
let reversed = new Set<string>()
let orientationSig = ''

/** Learn which keys are "Title - Artist" from the whole library (cheap; cached by size). */
export function configureArtistOrientation(keys: Iterable<string>): void {
  const all = [...keys]
  const sig = `${all.length}:${all[0] ?? ''}:${all[all.length - 1] ?? ''}`
  if (sig === orientationSig) return
  const left = new Map<string, number>()
  const right = new Map<string, number>()
  for (const k of all) {
    const i = k.indexOf(' - ')
    if (i <= 0) continue
    const a = k.slice(0, i).trim()
    const b = k.slice(i + 3).trim()
    left.set(a, (left.get(a) ?? 0) + 1)
    right.set(b, (right.get(b) ?? 0) + 1)
  }
  const next = new Set<string>()
  for (const k of all) {
    const i = k.indexOf(' - ')
    if (i <= 0) continue
    const a = k.slice(0, i).trim()
    const b = k.slice(i + 3).trim()
    if ((right.get(b) ?? 0) >= 4 && (left.get(a) ?? 0) <= 1) next.add(k)
  }
  reversed = next
  orientationSig = sig
}

/** Primary artists of a key, lower-cased (`"A,B - Title"` → `['a','b']`; reversed keys
 *  → the right side). Empty when unparseable. */
export function artistsOf(name: string): string[] {
  const i = name.indexOf(' - ')
  if (i <= 0) return []
  return splitArtists(reversed.has(name) ? name.slice(i + 3) : name.slice(0, i))
}

function asList(v: string | string[] | undefined): string[] {
  if (!v) return []
  return (Array.isArray(v) ? v : [v]).map((s) => String(s).trim().toLowerCase()).filter(Boolean)
}

/** Grouping key for the library section header + sort. */
export function moodKey(meta: SongMeta | undefined, order: LibraryOrder): string {
  if (!meta) return '~'
  const emotion = asList(meta.emotion)
  const genre = asList(meta.genre)
  if (order === 'genre') return [genre.join('/'), emotion.join('/')].join(' · ') || '~'
  return [emotion.join('/'), genre.join('/')].join(' · ') || '~'
}

/** Header shown above a group: the first-level bucket (primary emotion / genre). */
export function bucketOf(meta: SongMeta | undefined, order: LibraryOrder): string {
  if (!meta) return 'untagged'
  const list = order === 'genre' ? asList(meta.genre) : asList(meta.emotion)
  return list[0] || 'untagged'
}

/**
 * Reorder so no artist appears within `gap` positions of itself, as far as
 * possible, while keeping the relative order otherwise (stable greedy pick).
 */
export function spreadArtists<T>(items: T[], nameOf: (t: T) => string, gap = 3): T[] {
  const pending = [...items]
  const out: T[] = []
  const recent: string[][] = []
  while (pending.length) {
    const blocked = new Set(recent.flat())
    let idx = pending.findIndex((p) => !artistsOf(nameOf(p)).some((a) => blocked.has(a)))
    if (idx < 0) idx = 0
    const [pick] = pending.splice(idx, 1)
    out.push(pick)
    recent.push(artistsOf(nameOf(pick)))
    if (recent.length > gap) recent.shift()
  }
  return out
}

/**
 * Order library keys for the system prompt. `emotion` (default): grouped by the
 * full emotion set, then genre — neighbours resonate in mood; within a group the
 * artists are interleaved. `genre`: genre first. `alpha`: legacy alphabetical.
 */
export function orderLibrary(
  names: string[],
  metadata: Map<string, SongMeta>,
  order: LibraryOrder
): string[] {
  const sorted = [...names].sort()
  if (order === 'alpha') return sorted
  const keyed = sorted.map((n) => ({
    n,
    b: bucketOf(metadata.get(n), order),
    k: moodKey(metadata.get(n), order)
  }))
  keyed.sort((x, y) => (x.b === y.b ? (x.k < y.k ? -1 : x.k > y.k ? 1 : 0) : x.b < y.b ? -1 : 1))
  // Spread artists inside each first-level bucket so the mood ordering is kept
  // but the same artist doesn't sit in a contiguous block.
  const out: string[] = []
  let i = 0
  while (i < keyed.length) {
    let j = i
    while (j < keyed.length && keyed[j].b === keyed[i].b) j++
    out.push(
      ...spreadArtists(
        keyed.slice(i, j).map((x) => x.n),
        (n) => n
      )
    )
    i = j
  }
  return out
}

/**
 * Enforce at most `maxPerArtist` tracks per artist in a batch (0 = no cap), then
 * de-cluster so the same artist isn't played back-to-back. Returns the kept
 * tracks and the dropped overflow (not counted as played).
 */
export function enforceArtistCap(
  playlist: PlaylistEntry[],
  maxPerArtist: number
): { kept: PlaylistEntry[]; dropped: PlaylistEntry[] } {
  const kept: PlaylistEntry[] = []
  const dropped: PlaylistEntry[] = []
  const count = new Map<string, number>()
  for (const s of playlist) {
    const artists = artistsOf(s.name)
    if (maxPerArtist > 0 && artists.some((a) => (count.get(a) ?? 0) >= maxPerArtist)) {
      dropped.push(s)
      continue
    }
    for (const a of artists) count.set(a, (count.get(a) ?? 0) + 1)
    kept.push(s)
  }
  return { kept: spreadArtists(kept, (s) => s.name, 1), dropped }
}
