/**
 * Built-in tools of the DJ loop kernel.
 *
 * Workflow they are designed for — the kernel reasons on TAGS, not on every song:
 *   tag_cloud → filter_library (bulk keep/drop by tags, repeat) → pick inside
 *   the pool (ask_library_agent / search_library / similar_to) → queue_tracks.
 * Every track in a result carries a short stable `id` (`#k3f9`); tools accept
 * IDs (exact) and fall back to fuzzy-matching full keys.
 */
import type { PlaylistEntry, SongMeta } from '../../types'
import { artistsOf, spreadArtists } from '../diversity'
import { renderTemplate } from '../prompts'
import { candidateTarget } from '../policy'
import { textVariants } from '../../parser/chineseVariants'
import { isIdRef } from './ids'
import { registerDjTool, type DjToolContext } from './tools'
import { agentModel, type AgentRole } from '../models'
import { readUsage } from '../usage'

// -- helpers ----------------------------------------------------------------

type Field = 'emotion' | 'genre' | 'language' | 'loudness'
const FIELDS: Field[] = ['emotion', 'genre', 'language', 'loudness']

function list(v: unknown): string[] {
  if (v == null || v === '') return []
  const arr = Array.isArray(v) ? v : String(v).split(/[,，、/]/)
  return arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
}

function tagsOf(m: SongMeta | undefined, field: Field): string[] {
  return list(m?.[field])
}

const UNKNOWN_LANGUAGE = new Set(['unknown', '未知', 'n/a', 'na', 'none', 'null', '-', '?'])

/**
 * Language tag missing / "unknown". Such tracks are NEVER removed by a language
 * filter (keep_language / drop_language / language / exclude_language): the tag
 * is absent, not a mismatch — the sub-agents judge them by title, review, lyrics.
 */
export function languageUnknown(m: SongMeta | undefined): boolean {
  const tags = tagsOf(m, 'language')
  return tags.length === 0 || tags.every((t) => UNKNOWN_LANGUAGE.has(t))
}

const LANGUAGE_RULE = 'tracks whose language is unknown are ALWAYS kept by language filters'

/** Loose tag match for free-form search: substring either way, or a shared
 *  6+ char prefix (melancholic ≈ melancholy). `filter_library` is exact. */
function tagMatch(tag: string, query: string): boolean {
  if (tag.includes(query) || query.includes(tag)) return true
  const n = Math.min(tag.length, query.length)
  return n >= 6 && tag.slice(0, 6) === query.slice(0, 6)
}

function anyMatch(tags: string[], queries: string[]): boolean {
  return queries.some((q) => tags.some((t) => tagMatch(t, q)))
}

export function brief(ctx: DjToolContext, name: string): Record<string, unknown> {
  const m = ctx.metadata.get(name)
  return {
    id: ctx.ids.idOf(name),
    key: name,
    emotion: tagsOf(m, 'emotion'),
    genre: tagsOf(m, 'genre'),
    language: m?.language ?? null
  }
}

/** `#k3f9` → exact; anything else → fuzzy key match. */
function resolveRef(ctx: DjToolContext, ref: string): string | null {
  return isIdRef(ref) ? ctx.ids.keyOf(ref) : ctx.resolveKey(ref)
}

function refs(v: unknown): string[] {
  return (Array.isArray(v) ? v : v == null ? [] : [v]).map(String).filter(Boolean)
}

/** Every unplayed, not-yet-queued track (ignores the pool). */
function unplayed(ctx: DjToolContext): string[] {
  const staged = new Set(ctx.staged.map((s) => s.name))
  return [...ctx.metadata.keys()].filter(
    (k) => ctx.musicPaths.has(k) && !ctx.played.has(k) && !staged.has(k)
  )
}

/** Candidates for this batch: unplayed ∩ pool. */
function available(ctx: DjToolContext): string[] {
  const all = unplayed(ctx)
  const pool = ctx.pool
  return pool ? all.filter((k) => pool.has(k)) : all
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** At most `perArtist` per artist, artists interleaved. */
function diverse(keys: string[], perArtist: number, limit: number): string[] {
  const count = new Map<string, number>()
  const out: string[] = []
  for (const k of keys) {
    const as = artistsOf(k)
    if (perArtist > 0 && as.some((a) => (count.get(a) ?? 0) >= perArtist)) continue
    for (const a of as) count.set(a, (count.get(a) ?? 0) + 1)
    out.push(k)
    if (out.length >= limit) break
  }
  return spreadArtists(out, (k) => k, 2)
}

export function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def
}

/** Tag cloud of `keys`: per field `tag(count)`, most common first. */
function cloud(ctx: DjToolContext, keys: string[], top: number): Record<string, unknown> {
  const counts = new Map<Field, Map<string, number>>(FIELDS.map((f) => [f, new Map()]))
  for (const k of keys) {
    const m = ctx.metadata.get(k)
    for (const f of FIELDS) {
      const c = counts.get(f)!
      for (const t of new Set(tagsOf(m, f))) c.set(t, (c.get(t) ?? 0) + 1)
    }
  }
  const out: Record<string, unknown> = { tracks: keys.length }
  const more: Record<string, number> = {}
  for (const f of FIELDS) {
    const sorted = [...counts.get(f)!].sort((a, b) => b[1] - a[1])
    out[f] = sorted
      .slice(0, top)
      .map(([t, n]) => `${t}(${n})`)
      .join(', ')
    if (sorted.length > top) more[f] = sorted.length - top
  }
  if (Object.keys(more).length) out.more_tags_not_shown = more
  return out
}

/** Lowercase, whitespace / punctuation / symbols removed. */
function compactText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function haystack(name: string, m: SongMeta | undefined): string {
  return `${name} ${m?.review ?? ''}`.toLowerCase()
}

// -- loose filters (search_library / ask_library_agent scope) ----------------

interface Filter {
  emotion: string[]
  genre: string[]
  language: string[]
  text: string[]
  exclude_artists: string[]
  exclude_emotion: string[]
  exclude_genre: string[]
  exclude_language: string[]
  exclude_text: string[]
}

function readFilter(args: Record<string, unknown>): Filter {
  return {
    emotion: list(args.emotion),
    genre: list(args.genre),
    language: list(args.language),
    text: list(args.text),
    exclude_artists: list(args.exclude_artists),
    exclude_emotion: list(args.exclude_emotion),
    exclude_genre: list(args.exclude_genre),
    exclude_language: list(args.exclude_language),
    exclude_text: list(args.exclude_text)
  }
}

function matches(name: string, m: SongMeta | undefined, f: Filter): boolean {
  if (f.emotion.length && !anyMatch(tagsOf(m, 'emotion'), f.emotion)) return false
  if (f.genre.length && !anyMatch(tagsOf(m, 'genre'), f.genre)) return false
  const langKnown = !languageUnknown(m)
  if (langKnown && f.language.length && !anyMatch(tagsOf(m, 'language'), f.language)) return false
  if (f.text.length && !f.text.some((t) => haystack(name, m).includes(t))) return false
  if (f.exclude_artists.length) {
    const as = artistsOf(name)
    if (as.some((a) => f.exclude_artists.some((x) => a.includes(x)))) return false
  }
  if (f.exclude_emotion.length && anyMatch(tagsOf(m, 'emotion'), f.exclude_emotion)) return false
  if (f.exclude_genre.length && anyMatch(tagsOf(m, 'genre'), f.exclude_genre)) return false
  if (
    langKnown &&
    f.exclude_language.length &&
    anyMatch(tagsOf(m, 'language'), f.exclude_language)
  ) {
    return false
  }
  if (f.exclude_text.length && f.exclude_text.some((t) => haystack(name, m).includes(t))) {
    return false
  }
  return true
}

const arr = (description: string): Record<string, unknown> => ({
  type: 'array',
  items: { type: 'string' },
  description
})

const FILTER_PROPS = {
  emotion: arr('Emotion tags, any-of (e.g. ["melancholic","dreamy"])'),
  genre: arr('Genre tags, any-of'),
  language: arr(`Languages, any-of (${LANGUAGE_RULE})`),
  text: arr('Free-text keywords matched against key and review, any-of'),
  exclude_artists: arr('Artists to skip'),
  exclude_emotion: arr('Drop tracks carrying ANY of these emotion tags'),
  exclude_genre: arr('Drop these genres'),
  exclude_language: arr(`Drop these languages (${LANGUAGE_RULE})`),
  exclude_text: arr('Drop tracks whose key or review contains any of these keywords')
}

// -- tools ------------------------------------------------------------------

registerDjTool({
  name: 'tag_cloud',
  description:
    'Tag cloud (emotion / genre / language / loudness with track counts, most common first) of the current candidate pool — or of every unplayed track with of="all". Start here, then narrow with filter_library.',
  parameters: {
    type: 'object',
    properties: {
      of: { type: 'string', enum: ['pool', 'all'], description: 'Default "pool"' },
      top: { type: 'integer', description: 'Max tags per field (default 80)' }
    }
  },
  run: (args, ctx) => {
    const keys = args.of === 'all' ? unplayed(ctx) : available(ctx)
    return {
      pool_filtered: ctx.pool != null,
      ...cloud(ctx, keys, clampInt(args.top, 80, 5, 400)),
      language_unknown: keys.filter((k) => languageUnknown(ctx.metadata.get(k))).length,
      note: `"unknown" language = tag missing, not a language; ${LANGUAGE_RULE}`
    }
  }
})

registerDjTool({
  name: 'filter_library',
  description:
    'Bulk-narrow the candidate pool by tags — use EXACT tags from tag_cloud (case-insensitive). keep_* keeps tracks having ANY of those tags; drop_* removes tracks having ANY of them. Filters stack on the current pool; reset=true starts again from every unplayed track. A filter that would empty the pool is refused. Returns the new size and its tag cloud.',
  parameters: {
    type: 'object',
    properties: {
      reset: { type: 'boolean', description: 'Start from every unplayed track first' },
      keep_emotion: arr('Keep only tracks with any of these emotion tags'),
      drop_emotion: arr('Remove tracks with any of these emotion tags'),
      keep_genre: arr('Keep only these genres'),
      drop_genre: arr('Remove these genres'),
      keep_language: arr(`Keep only these languages (${LANGUAGE_RULE})`),
      drop_language: arr(`Remove these languages (${LANGUAGE_RULE})`),
      keep_loudness: arr('Keep only these loudness levels'),
      drop_loudness: arr('Remove these loudness levels'),
      drop_text: arr('Remove tracks whose key/review contains any keyword'),
      drop_artists: arr('Remove these artists'),
      keep_lyrics: arr(
        'Keep only tracks whose LYRICS contain any of these phrases (exact, simplified/traditional both match; tracks without lyrics are removed)'
      ),
      drop_lyrics: arr('Remove tracks whose lyrics contain any of these phrases'),
      top: { type: 'integer', description: 'Tags per field in the returned cloud (default 40)' }
    }
  },
  run: (args, ctx) => {
    const base = args.reset === true || !ctx.pool ? unplayed(ctx) : available(ctx)
    const vocab = new Map<Field, Set<string>>(FIELDS.map((f) => [f, new Set()]))
    for (const k of base) {
      for (const f of FIELDS) for (const t of tagsOf(ctx.metadata.get(k), f)) vocab.get(f)!.add(t)
    }
    const unknown: string[] = []
    const ignored: string[] = []
    const spec = FIELDS.map((f) => {
      let keep = list(args[`keep_${f}`])
      let drop = list(args[`drop_${f}`])
      if (f === 'language') {
        // "unknown" is not a language: it can be neither kept-only nor dropped.
        for (const t of [...keep, ...drop])
          if (UNKNOWN_LANGUAGE.has(t)) ignored.push(`language:${t}`)
        keep = keep.filter((t) => !UNKNOWN_LANGUAGE.has(t))
        drop = drop.filter((t) => !UNKNOWN_LANGUAGE.has(t))
      }
      for (const t of [...keep, ...drop]) if (!vocab.get(f)!.has(t)) unknown.push(`${f}:${t}`)
      return { f, keep: new Set(keep), drop: new Set(drop) }
    })
    const langFiltered = spec.some((x) => x.f === 'language' && (x.keep.size || x.drop.size))
    let keptUnknownLanguage = 0
    const dropText = list(args.drop_text)
    const dropArtists = list(args.drop_artists)
    const keepLyrics = refs(args.keep_lyrics)
    const dropLyrics = refs(args.drop_lyrics)
    const lyr = keepLyrics.length || dropLyrics.length ? ctx.lyrics() : null
    const next = base.filter((k) => {
      if (lyr && keepLyrics.length && lyr.match(k, keepLyrics) == null) return false
      if (lyr && dropLyrics.length && lyr.match(k, dropLyrics) != null) return false
      const m = ctx.metadata.get(k)
      for (const { f, keep, drop } of spec) {
        if (!keep.size && !drop.size) continue
        if (f === 'language' && languageUnknown(m)) continue
        const tags = tagsOf(m, f)
        if (keep.size && !tags.some((t) => keep.has(t))) return false
        if (drop.size && tags.some((t) => drop.has(t))) return false
      }
      if (dropText.length && dropText.some((t) => haystack(k, m).includes(t))) return false
      if (dropArtists.length && artistsOf(k).some((a) => dropArtists.some((x) => a.includes(x)))) {
        return false
      }
      return true
    })
    if (langFiltered) {
      keptUnknownLanguage = next.filter((k) => languageUnknown(ctx.metadata.get(k))).length
    }
    if (next.length === 0) {
      return {
        error: 'filter would empty the pool — not applied',
        pool_size: base.length,
        unknown_tags: unknown
      }
    }
    ctx.pool = new Set(next)
    return {
      before: base.length,
      after: next.length,
      unknown_tags: unknown,
      ...(ignored.length ? { ignored, ignored_reason: LANGUAGE_RULE } : {}),
      ...(langFiltered
        ? {
            kept_unknown_language: keptUnknownLanguage,
            note: `${LANGUAGE_RULE} — they stay in the pool for the sub-agents to judge by title, review and lyrics`
          }
        : {}),
      cloud: cloud(ctx, next, clampInt(args.top, 40, 5, 400))
    }
  }
})

registerDjTool({
  name: 'search_lyrics',
  description:
    'Full-text search of song LYRICS (what the library agent cannot see). Phrases match exactly after normalization (case, spaces, punctuation ignored; simplified/traditional Chinese both match). Use short phrases or key words — e.g. ["森林","辽阔"] with require="all" rather than one long sentence. Returns the matching lyric line per track.',
  parameters: {
    type: 'object',
    properties: {
      phrases: arr('Phrases / words to look for'),
      require: { type: 'string', enum: ['any', 'all'], description: 'Default "any"' },
      scope: { type: 'string', enum: ['pool', 'all'], description: 'Default "pool"' },
      limit: { type: 'integer', description: 'Max results (default 30, max 80)' }
    },
    required: ['phrases']
  },
  run: (args, ctx) => {
    const phrases = refs(args.phrases)
    if (!phrases.length) return { error: 'phrases is empty' }
    const lyr = ctx.lyrics()
    const keys = args.scope === 'all' ? unplayed(ctx) : available(ctx)
    const all = args.require === 'all'
    const hits: { k: string; line: string }[] = []
    let withLyrics = 0
    for (const k of keys) {
      if (!lyr.has(k)) continue
      withLyrics++
      const line = lyr.match(k, phrases, all)
      if (line != null) hits.push({ k, line })
    }
    const limit = clampInt(args.limit, 30, 1, 80)
    const order = diverse(shuffle(hits.map((h) => h.k)), 2, limit)
    const line = new Map(hits.map((h) => [h.k, h.line]))
    return {
      total_matches: hits.length,
      searched: withLyrics,
      without_lyrics: keys.length - withLyrics,
      results: order.map((k) => ({ ...brief(ctx, k), lyric: line.get(k) }))
    }
  }
})

registerDjTool({
  name: 'search_library',
  description:
    'Find candidate tracks inside the pool by tags / keywords (loose matching). Filters combine with AND; values inside one filter are any-of. Results are artist-diverse and shuffled.',
  parameters: {
    type: 'object',
    properties: {
      ...FILTER_PROPS,
      limit: { type: 'integer', description: 'Max results (default 25, max 60)' },
      per_artist: { type: 'integer', description: 'Max results per artist (default 2, 0 = no cap)' }
    }
  },
  run: (args, ctx) => {
    const f = readFilter(args)
    const limit = clampInt(args.limit, 25, 1, 60)
    const per = clampInt(args.per_artist, 2, 0, 50)
    const hits = shuffle(available(ctx).filter((k) => matches(k, ctx.metadata.get(k), f)))
    return {
      total_matches: hits.length,
      results: diverse(hits, per, limit).map((k) => brief(ctx, k))
    }
  }
})

registerDjTool({
  name: 'similar_to',
  description:
    'Tracks in the pool that resonate with a reference track — ranked by shared emotion (weighted most), genre and language. Other artists only unless include_same_artist is true.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Track ID (#xxxx) or full key of the reference track' },
      limit: { type: 'integer', description: 'Max results (default 20, max 50)' },
      include_same_artist: { type: 'boolean' }
    },
    required: ['id']
  },
  run: (args, ctx) => {
    const key = resolveRef(ctx, String(args.id ?? args.key ?? ''))
    if (!key) return { error: `unknown track: ${String(args.id ?? args.key)}` }
    const ref = ctx.metadata.get(key)
    const re = tagsOf(ref, 'emotion')
    const rg = tagsOf(ref, 'genre')
    const rl = tagsOf(ref, 'language')
    const refArtists = new Set(artistsOf(key))
    const jac = (a: string[], b: string[]): number => {
      if (!a.length || !b.length) return 0
      const hit = a.filter((x) => b.some((y) => tagMatch(x, y))).length
      return hit / (a.length + b.length - hit)
    }
    const scored = available(ctx)
      .filter((k) => k !== key)
      .filter(
        (k) => args.include_same_artist === true || !artistsOf(k).some((a) => refArtists.has(a))
      )
      .map((k) => {
        const m = ctx.metadata.get(k)
        const s =
          2 * jac(re, tagsOf(m, 'emotion')) +
          jac(rg, tagsOf(m, 'genre')) +
          (rl.length && anyMatch(tagsOf(m, 'language'), rl) ? 0.4 : 0)
        return { k, s: s + Math.random() * 0.05 }
      })
      .filter((x) => x.s > 0.1)
      .sort((a, b) => b.s - a.s)
    const score = new Map(scored.map((x) => [x.k, x.s]))
    return {
      reference: brief(ctx, key),
      results: diverse(
        scored.map((x) => x.k),
        1,
        clampInt(args.limit, 20, 1, 50)
      ).map((k) => ({ ...brief(ctx, k), score: Number((score.get(k) ?? 0).toFixed(2)) }))
    }
  }
})

registerDjTool({
  name: 'search_titles',
  description:
    'Find tracks by title and/or artist (the track key "Artist - Title"). Case, spaces and punctuation are ignored; simplified/traditional Chinese both match. Searches every track (played ones are flagged), not only the pool — use it to find anchors and artists.',
  parameters: {
    type: 'object',
    properties: {
      query: arr('Title / artist words, any-of (e.g. ["周杰伦"] or ["辽阔的森林"])'),
      limit: { type: 'integer', description: 'Max results (default 30, max 100)' }
    },
    required: ['query']
  },
  run: (args, ctx) => {
    const qs = refs(args.query)
      .map((q) => [...new Set(textVariants(q).map(compactText))].filter(Boolean))
      .filter((v) => v.length)
    if (!qs.length) return { error: 'query is empty' }
    const scored: { k: string; s: number }[] = []
    for (const k of ctx.metadata.keys()) {
      if (!ctx.musicPaths.has(k)) continue
      const key = compactText(k)
      const artists = artistsOf(k).map(compactText)
      let best = 0
      for (const vs of qs) {
        for (const v of vs) {
          if (artists.includes(v)) best = Math.max(best, 3)
          else if (key === v) best = Math.max(best, 3)
          else if (key.includes(v)) best = Math.max(best, 2)
        }
      }
      if (best) scored.push({ k, s: best })
    }
    scored.sort((a, b) => b.s - a.s || (a.k < b.k ? -1 : 1))
    const limit = clampInt(args.limit, 30, 1, 100)
    return {
      total_matches: scored.length,
      results: scored.slice(0, limit).map(({ k }) => ({
        ...brief(ctx, k),
        ...(ctx.played.has(k) ? { played: true } : {})
      }))
    }
  }
})

registerDjTool({
  name: 'get_songs',
  description:
    'Full info of specific tracks (max 15): tags, loudness, review; include_lyrics=true adds a lyric excerpt.',
  parameters: {
    type: 'object',
    properties: {
      ids: arr('Track IDs (#xxxx); full keys also accepted'),
      include_lyrics: { type: 'boolean' }
    },
    required: ['ids']
  },
  run: (args, ctx) => {
    const lyr = args.include_lyrics === true ? ctx.lyrics() : null
    return refs(args.ids ?? args.keys)
      .slice(0, 15)
      .map((q) => {
        const k = resolveRef(ctx, q)
        if (!k) return { query: q, error: 'not in library' }
        const m = ctx.metadata.get(k)
        return {
          ...brief(ctx, k),
          loudness: m?.loudness ?? null,
          review: m?.review ?? null,
          played: ctx.played.has(k),
          ...(lyr ? { lyrics: lyr.excerpt(k, 16) } : {})
        }
      })
  }
})

registerDjTool({
  name: 'session_memory',
  description:
    'Tracks THIS DJ session already played or queued (oldest first, with tags) — the no-repeat memory. ' +
    "It is NOT the user's real listening history: use recent_listens for what they actually listened to.",
  parameters: {
    type: 'object',
    properties: { n: { type: 'integer', description: 'How many (default 15, max 100)' } }
  },
  run: (args, ctx) => ctx.recent.slice(-clampInt(args.n, 15, 1, 100)).map((k) => brief(ctx, k))
})

function stageCount(ctx: DjToolContext): Record<string, unknown> {
  return {
    queued: ctx.staged.map(
      (s) => `${ctx.ids.idOf(s.name)} ${s.name}${ctx.pinned.includes(s.name) ? ' (pinned)' : ''}`
    ),
    queued_total: ctx.staged.length,
    still_needed: Math.max(0, candidateTarget(ctx.policy) - ctx.staged.length)
  }
}

/** Pinned tracks first (in pin order), the rest keep their order. */
function sortPinned(ctx: DjToolContext): void {
  const rank = (name: string): number => {
    const i = ctx.pinned.indexOf(name)
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  const sorted = ctx.staged
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank(a.s.name) - rank(b.s.name) || a.i - b.i)
    .map((x) => x.s)
  ctx.staged.splice(0, ctx.staged.length, ...sorted)
}

/** Shared by queue_tracks and random_pick: validate and stage tracks. */
function queueRefs(
  ctx: DjToolContext,
  list: string[],
  pin: boolean
): { accepted: string[]; rejected: { ref: string; reason: string }[] } & Record<string, unknown> {
  const accepted: string[] = []
  const rejected: { ref: string; reason: string }[] = []
  if (ctx.noMusic) {
    return {
      accepted,
      rejected: list.map((ref) => ({
        ref,
        reason: 'no_music was called — this turn queues nothing'
      })),
      ...stageCount(ctx)
    }
  }
  const cap = ctx.capArtists ? ctx.policy.max_per_artist : 0
  for (const q of list) {
    const k = resolveRef(ctx, q)
    if (!k) {
      rejected.push({ ref: q, reason: 'not in library' })
      continue
    }
    const label = `${ctx.ids.idOf(k)} ${k}`
    if (ctx.played.has(k) && !pin) {
      rejected.push({ ref: label, reason: 'already played' })
      continue
    }
    if (ctx.staged.some((s) => s.name === k)) {
      if (pin && !ctx.pinned.includes(k)) {
        ctx.pinned.push(k)
        accepted.push(`${label} (now pinned)`)
      } else rejected.push({ ref: label, reason: 'already queued' })
      continue
    }
    if (cap > 0 && !pin) {
      const over = artistsOf(k).find(
        (a) => ctx.staged.filter((s) => artistsOf(s.name).includes(a)).length >= cap
      )
      if (over) {
        rejected.push({ ref: label, reason: `artist cap (${cap}) reached for ${over}` })
        continue
      }
    }
    const path = ctx.musicPaths.get(k)
    if (!path) {
      rejected.push({ ref: label, reason: 'file missing' })
      continue
    }
    const entry: PlaylistEntry = { name: k, path }
    ctx.staged.push(entry)
    if (pin) ctx.pinned.push(k)
    accepted.push(label)
  }
  sortPinned(ctx)
  return { accepted, rejected, ...stageCount(ctx) }
}

registerDjTool({
  name: 'queue_tracks',
  description:
    'Add tracks to this batch by ID (#xxxx from tool results). pin_first=true pins them to OPEN the batch (the seed / the song the user asked to start from; a pinned track may be one played before). Returns accepted / rejected (with reason) and how many are still needed.',
  core: true, // 没有它循环就没法入队，设置里锁定为开
  parameters: {
    type: 'object',
    properties: {
      ids: arr('Track IDs (#xxxx); full keys also accepted'),
      pin_first: { type: 'boolean' }
    },
    required: ['ids']
  },
  run: (args, ctx) => queueRefs(ctx, refs(args.ids ?? args.keys), args.pin_first === true)
})

registerDjTool({
  name: 'unqueue_tracks',
  description: 'Remove tracks from this batch by ID.',
  parameters: {
    type: 'object',
    properties: { ids: arr('Track IDs (#xxxx); full keys also accepted') },
    required: ['ids']
  },
  run: (args, ctx) => {
    const drop = new Set(refs(args.ids ?? args.keys).map((q) => resolveRef(ctx, q) ?? q))
    const before = ctx.staged.length
    const kept = ctx.staged.filter((s) => !drop.has(s.name))
    ctx.staged.splice(0, ctx.staged.length, ...kept)
    ctx.pinned.splice(0, ctx.pinned.length, ...ctx.pinned.filter((k) => !drop.has(k)))
    return { removed: before - kept.length, ...stageCount(ctx) }
  }
})

registerDjTool({
  name: 'random_pick',
  description:
    'Random tracks from the CURRENT candidate pool (what filter_library left; played / queued tracks excluded) — for serendipity or a quick filler. Optional loose filters narrow further; per_artist caps duplicates; avoid_recent_artists skips artists of the recent sequence. queue=true stages the picks directly (same rules as queue_tracks).',
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'integer', description: 'How many (default 5, max 40)' },
      ...FILTER_PROPS,
      per_artist: { type: 'integer', description: 'Max picks per artist (default 1, 0 = no cap)' },
      avoid_recent_artists: {
        type: 'boolean',
        description: 'Skip artists heard in the recent sequence (default true)'
      },
      queue: { type: 'boolean', description: 'Also queue the picks (default false)' }
    }
  },
  run: (args, ctx) => {
    const count = clampInt(args.count, 5, 1, 40)
    const per = clampInt(args.per_artist, 1, 0, 50)
    const f = readFilter(args)
    let keys = available(ctx).filter((k) => matches(k, ctx.metadata.get(k), f))
    if (args.avoid_recent_artists !== false) {
      const window = ctx.policy.recent_window > 0 ? ctx.recent.slice(-ctx.policy.recent_window) : []
      const recent = new Set(window.flatMap((k) => artistsOf(k)))
      const fresh = keys.filter((k) => !artistsOf(k).some((a) => recent.has(a)))
      // Only when that still leaves something to pick from.
      if (fresh.length) keys = fresh
    }
    const picked = diverse(shuffle([...keys]), per, count)
    const out: Record<string, unknown> = {
      pool_size: keys.length,
      picked: picked.map((k) => brief(ctx, k))
    }
    if (args.queue === true) out.queued = queueRefs(ctx, picked, false)
    return out
  }
})

registerDjTool({
  name: 'no_music',
  description:
    'The user does not want music right now — they want to talk, ask a question, or said no / stop music. Call it, queue NOTHING, and answer them directly in your final reply (in their language, as the DJ). In the continuous radio, auto-refill pauses until their next message.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Short reason, e.g. "user wants to chat"' }
    }
  },
  run: (args, ctx) => {
    ctx.noMusic = true
    // Anything staged earlier this turn is dropped too.
    ctx.staged.splice(0, ctx.staged.length)
    ctx.pinned.splice(0, ctx.pinned.length)
    return {
      ok: true,
      reason: String(args.reason ?? ''),
      next: 'Do not queue tracks. Use web_search if you need facts, then reply to the user directly.'
    }
  }
})

registerDjTool({
  name: 'use_playbook',
  description:
    'Get the full steps of a playbook (范式) from the catalogue in your instructions. Call it first when a playbook fits the request.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id']
  },
  run: (args, ctx) => {
    const p = ctx.playbooks.find((x) => x.id === String(args.id ?? ''))
    if (!p)
      return {
        error: `unknown playbook: ${String(args.id)}`,
        available: ctx.playbooks.map((x) => x.id)
      }
    return { id: p.id, title: p.title, steps: p.steps }
  }
})

// -- sub-agents ---------------------------------------------------------------

const ID_IN_LINE = /#[0-9a-z]{4}\b/i

/** One sub-agent call: library slice in the system prompt (stable prefix, cache-friendly),
 *  brief as the user message; returns in-scope track keys parsed from the reply. */
async function pickWithLlm(
  ctx: DjToolContext,
  role: AgentRole,
  instructions: string,
  userBrief: string,
  scope: Scope,
  limit: number
): Promise<string[]> {
  // The library slice is the cacheable prefix: it must not change while tracks get
  // queued / played, so exclusions go at the END of the user message instead.
  const system = `${instructions}\n\n### LIBRARY\n${ctx.formatLibrary(scope.slice)}`
  const allowed = new Set(scope.allowed)
  const excluded = scope.slice.filter((k) => !allowed.has(k)).map((k) => ctx.ids.idOf(k))
  const user = excluded.length
    ? `${userBrief}\n\nDo NOT pick these (already played, already queued or seeds): ${excluded.join(' ')}`
    : userBrief
  const res = await ctx.client.chat.completions.create(
    {
      model: agentModel(ctx.config, role),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    },
    { timeout: ctx.policy.fetch_timeout_sec * 1000, signal: ctx.signal }
  )
  ctx.addUsage(role, readUsage(res.usage))
  const text = (res.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '')
  const inScope = allowed
  const out: string[] = []
  for (const line of text.split('\n')) {
    const idm = ID_IN_LINE.exec(line)
    let k: string | null = idm ? ctx.ids.keyOf(idm[0]) : null
    if (!k) {
      const clean = line
        .replace(/^[\s\-*\d.)]+/, '')
        .replace(/["'`]/g, '')
        .trim()
      if (clean.length < 2 || clean.startsWith('# ')) continue
      k = ctx.resolveKey(clean)
    }
    if (k && inScope.has(k) && !out.includes(k)) out.push(k)
    if (out.length >= limit) break
  }
  return out
}

interface Scope {
  /** What the sub-agent reads — stable (played / queued tracks stay in), so its
   *  prompt prefix is cache-friendly across calls and batches. */
  slice: string[]
  /** What it may return (unplayed, not queued, not seeds). */
  allowed: string[]
}

/** "pool" (default) | "all" | { ids: [...] } | loose filter object. */
function scopeOf(ctx: DjToolContext, scope: unknown, exclude: string[] = []): Scope {
  const library = [...ctx.metadata.keys()].filter((k) => ctx.musicPaths.has(k))
  const base = ctx.pool ? [...ctx.pool] : library
  let slice: string[]
  if (scope === 'all') slice = library
  else if (scope && typeof scope === 'object') {
    const o = scope as Record<string, unknown>
    if (Array.isArray(o.ids)) {
      slice = [
        ...new Set(
          refs(o.ids)
            .map((r) => resolveRef(ctx, r))
            .filter((k): k is string => !!k)
        )
      ]
    } else {
      const f = readFilter(o)
      slice = base.filter((k) => matches(k, ctx.metadata.get(k), f))
    }
  } else slice = base
  const staged = new Set(ctx.staged.map((x) => x.name))
  const skip = new Set(exclude)
  const allowed = slice.filter((k) => !ctx.played.has(k) && !staged.has(k) && !skip.has(k))
  return { slice, allowed }
}

const SCOPE_SCHEMA = {
  description: '"pool" (default), "all", {"ids": [...]} for an explicit list, or a filter object',
  anyOf: [
    { type: 'string', enum: ['pool', 'all'] },
    {
      type: 'object',
      properties: { ids: arr('Explicit track IDs'), ...FILTER_PROPS }
    }
  ]
}

registerDjTool({
  name: 'ask_library_agent',
  description:
    'LibAgent: an LLM librarian reads the tracks in scope (IDs, tags, reviews) and returns the best candidates for your brief — e.g. choose among an artist\'s search hits, or pick by "feel" inside the pool. Still queue the results yourself.',
  parameters: {
    type: 'object',
    properties: {
      brief: {
        type: 'string',
        description: 'What you are looking for: mood, texture, energy, context, what to avoid'
      },
      scope: SCOPE_SCHEMA,
      limit: { type: 'integer', description: 'Max candidates (default 20, max 40)' }
    },
    required: ['brief']
  },
  enabled: (policy) => policy.library_agent,
  requires: 'library_agent',
  run: async (args, ctx) => {
    const scope = scopeOf(ctx, args.scope)
    if (scope.allowed.length === 0) {
      return { error: 'scope has no tracks — widen it or reset the pool' }
    }
    const limit = clampInt(args.limit, 20, 1, 40)
    const user = renderTemplate(ctx.prompts.library_agent_brief, {
      brief: String(args.brief ?? ''),
      limit,
      maxPerArtist: ctx.policy.max_per_artist || limit
    })
    const out = await pickWithLlm(ctx, 'lib', ctx.prompts.library_agent, user, scope, limit)
    return { scope_size: scope.allowed.length, results: out.map((k) => brief(ctx, k)) }
  }
})

/** Seed description for the DreamAgent / RankAgent: tags, review, lyric excerpt. */
export function describeTrack(ctx: DjToolContext, k: string, lyricLines = 8): string {
  const m = ctx.metadata.get(k)
  const lyric = ctx.lyrics().excerpt(k, lyricLines)
  return [
    ctx.ids.idOf(k),
    k,
    tagsOf(m, 'emotion').join('/') || '-',
    tagsOf(m, 'genre').join('/') || '-',
    m?.language ?? '-',
    m?.review ?? '-',
    lyric ?? '-'
  ].join(' | ')
}

registerDjTool({
  name: 'dream_from_seeds',
  description:
    'DreamAgent: given seed track(s), an LLM imagines the world they open (imagery, feeling, texture) and picks tracks from the scope that extend it — some close, some drifting further. Seeds are described to it with tags, review and lyric excerpt. Still queue the results yourself.',
  parameters: {
    type: 'object',
    properties: {
      seeds: arr('Seed track IDs (1–3)'),
      direction: {
        type: 'string',
        description: 'Where to take it: imagery, mood arc, what to avoid'
      },
      scope: SCOPE_SCHEMA,
      limit: { type: 'integer', description: 'Max candidates (default 20, max 40)' }
    },
    required: ['seeds']
  },
  enabled: (policy) => policy.library_agent,
  run: async (args, ctx) => {
    const seeds = refs(args.seeds)
      .slice(0, 3)
      .map((r) => resolveRef(ctx, r))
      .filter((k): k is string => !!k)
    if (!seeds.length) return { error: 'no valid seed ids' }
    const scope = scopeOf(ctx, args.scope, seeds)
    if (scope.allowed.length === 0) {
      return { error: 'scope has no tracks — widen it or reset the pool' }
    }
    const limit = clampInt(args.limit, 20, 1, 40)
    const user = renderTemplate(ctx.prompts.dream_agent_brief, {
      seeds: seeds.map((k) => `- ${describeTrack(ctx, k)}`).join('\n'),
      brief: String(args.direction ?? '(follow the seeds)'),
      limit,
      maxPerArtist: ctx.policy.max_per_artist || limit
    })
    const out = await pickWithLlm(ctx, 'dream', ctx.prompts.dream_agent, user, scope, limit)
    return { scope_size: scope.allowed.length, results: out.map((k) => brief(ctx, k)) }
  }
})
