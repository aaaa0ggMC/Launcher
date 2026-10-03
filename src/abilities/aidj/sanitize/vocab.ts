/**
 * Tag vocabulary for metadata sanitizing — pure functions (no IO).
 *
 * A vocabulary has, per field, the clean `canonical` tags and a `map` from every
 * old tag (normalized) to canonical tags (`[]` = drop the old tag). Songs whose
 * tags all map cleanly are fixed in code; only the rest go to the SanitizeAgent.
 * "unknown" language is always allowed (better than a guess).
 */
import type { SongMeta } from '../types'

export const SANITIZE_FIELDS = ['emotion', 'genre', 'language', 'loudness'] as const
export type SanitizeField = (typeof SANITIZE_FIELDS)[number]

/** Fields holding one value (the others hold 1–3 tags). */
export const SINGLE_VALUE: ReadonlySet<SanitizeField> = new Set(['language', 'loudness'])

export interface FieldVocab {
  /** Allowed tags, in display form. */
  canonical: string[]
  /** normalized old tag → canonical tags ([] = drop). */
  map: Record<string, string[]>
}

export interface TagVocab {
  /** Changes whenever the vocabulary changes (cache key of sanitize results). */
  version: number
  createdAt: number
  requirement: string
  fields: Partial<Record<SanitizeField, FieldVocab>>
}

export interface CloudEntry {
  tag: string
  count: number
}

const UNKNOWN_TOKENS = new Set(['unknown', '未知', 'n/a', 'na', 'none', 'null', '-', '?'])

export function norm(tag: string): string {
  return String(tag).trim().toLowerCase().replace(/\s+/g, ' ')
}

export function isUnknownTag(tag: string): boolean {
  return UNKNOWN_TOKENS.has(norm(tag))
}

export function valuesOf(meta: SongMeta | undefined, field: SanitizeField): string[] {
  const v = meta?.[field]
  const arr = Array.isArray(v) ? v : v == null || v === '' ? [] : [v]
  return arr.map((x) => String(x).trim()).filter(Boolean)
}

/** Tag cloud per field: normalized tag (display = most common spelling) + count. */
export function buildClouds(
  metas: Iterable<SongMeta | undefined>,
  fields: readonly SanitizeField[] = SANITIZE_FIELDS
): Record<SanitizeField, CloudEntry[]> {
  const counts = new Map<SanitizeField, Map<string, { n: number; spell: Map<string, number> }>>()
  for (const f of fields) counts.set(f, new Map())
  for (const m of metas) {
    for (const f of fields) {
      const c = counts.get(f)!
      for (const v of new Set(valuesOf(m, f))) {
        const k = norm(v)
        const e = c.get(k) ?? { n: 0, spell: new Map() }
        e.n++
        e.spell.set(v, (e.spell.get(v) ?? 0) + 1)
        c.set(k, e)
      }
    }
  }
  const out = {} as Record<SanitizeField, CloudEntry[]>
  for (const f of fields) {
    out[f] = [...counts.get(f)!.values()]
      .map((e) => ({
        tag: [...e.spell].sort((a, b) => b[1] - a[1])[0][0],
        count: e.n
      }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }
  return out
}

/** The canonical spelling of `tag` in a field vocabulary, or null. */
export function canonicalOf(fv: FieldVocab, tag: string): string | null {
  const n = norm(tag)
  return fv.canonical.find((c) => norm(c) === n) ?? null
}

/** The unknown tag of a language vocabulary (added if the AI forgot it). */
export function unknownTagOf(fv: FieldVocab): string {
  return fv.canonical.find((c) => isUnknownTag(c)) ?? 'Unknown'
}

/**
 * Validate / repair an AI-proposed field vocabulary against the cloud:
 * dedupe canonical tags, drop map targets that are not canonical, map every
 * canonical tag to itself, make sure language has an unknown tag. Old tags the
 * AI left out stay unmapped (those songs go to the SanitizeAgent).
 */
export function repairFieldVocab(
  field: SanitizeField,
  raw: { canonical?: unknown; map?: unknown },
  cloud: CloudEntry[]
): { vocab: FieldVocab; unmapped: string[]; badTargets: string[] } {
  const seen = new Set<string>()
  const canonical: string[] = []
  for (const c of Array.isArray(raw.canonical) ? raw.canonical : []) {
    const s = String(c).trim()
    if (s && !seen.has(norm(s))) {
      seen.add(norm(s))
      canonical.push(s)
    }
  }
  if (field === 'language' && !canonical.some((c) => isUnknownTag(c))) canonical.push('Unknown')
  const fv: FieldVocab = { canonical, map: {} }
  const badTargets: string[] = []
  const rawMap = (raw.map && typeof raw.map === 'object' ? raw.map : {}) as Record<string, unknown>
  for (const [old, targets] of Object.entries(rawMap)) {
    const list = Array.isArray(targets) ? targets : targets == null ? [] : [targets]
    const ok: string[] = []
    for (const t of list) {
      const c = canonicalOf(fv, String(t))
      if (c) {
        if (!ok.includes(c)) ok.push(c)
      } else if (String(t).trim()) badTargets.push(`${old} → ${String(t)}`)
    }
    fv.map[norm(old)] = SINGLE_VALUE.has(field) ? ok.slice(0, 1) : ok
  }
  for (const c of canonical) if (!(norm(c) in fv.map)) fv.map[norm(c)] = [c]
  if (field === 'language') {
    const unk = unknownTagOf(fv)
    for (const t of UNKNOWN_TOKENS) if (!(t in fv.map)) fv.map[t] = [unk]
  }
  const unmapped = cloud.map((e) => e.tag).filter((t) => !(norm(t) in fv.map))
  return { vocab: fv, unmapped, badTargets }
}

export interface ApplyResult {
  meta: SongMeta
  /** Fields that could not be fixed in code (→ SanitizeAgent). */
  needs: string[]
}

/**
 * Map a song's tags through the vocabulary. `needs` lists why the song still
 * needs the SanitizeAgent: unmapped tags, a field left empty, or (when
 * `fillUnknownLanguage`) an unknown language worth another look.
 */
export function applyVocab(
  meta: SongMeta | undefined,
  vocab: TagVocab,
  opts: { fillUnknownLanguage?: boolean } = {}
): ApplyResult {
  const out: SongMeta = { ...(meta ?? {}) }
  const needs: string[] = []
  for (const f of SANITIZE_FIELDS) {
    const fv = vocab.fields[f]
    if (!fv) continue
    const values = valuesOf(meta, f)
    const mapped: string[] = []
    let unmapped = false
    for (const v of values) {
      const hit = fv.map[norm(v)]
      if (hit) {
        for (const c of hit) if (!mapped.includes(c)) mapped.push(c)
      } else {
        unmapped = true
        needs.push(`${f}:${v}`)
      }
    }
    if (f === 'language') {
      const unk = unknownTagOf(fv)
      const lang = mapped.find((m) => !isUnknownTag(m)) ?? (mapped.length ? unk : null)
      out.language = lang ?? unk
      if (!unmapped && (lang == null || isUnknownTag(lang)) && opts.fillUnknownLanguage) {
        needs.push('language:unknown')
      }
    } else if (SINGLE_VALUE.has(f)) {
      if (mapped.length) out.loudness = mapped[0]
      else if (!unmapped) needs.push(`${f}:(empty)`)
    } else {
      const list = mapped.slice(0, 3)
      ;(out as Record<string, unknown>)[f] = list.length === 1 ? list[0] : list
      if (!list.length && !unmapped) needs.push(`${f}:(empty)`)
    }
  }
  return { meta: out, needs }
}

/**
 * Check SanitizeAgent output for one song: keep only canonical tags (old tags
 * that map are accepted too). Returns the cleaned fields and what was invalid.
 */
export function validateAgentFields(
  raw: Record<string, unknown>,
  vocab: TagVocab,
  fields: readonly SanitizeField[]
): { meta: Partial<SongMeta>; invalid: string[] } {
  const meta: Partial<SongMeta> = {}
  const invalid: string[] = []
  for (const f of fields) {
    const fv = vocab.fields[f]
    if (!fv || !(f in raw)) continue
    const v = raw[f]
    const list = (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim())
    const ok: string[] = []
    for (const t of list.filter(Boolean)) {
      const c = canonicalOf(fv, t) ?? fv.map[norm(t)]?.[0] ?? null
      if (c) {
        if (!ok.includes(c)) ok.push(c)
      } else invalid.push(`${f}:${t}`)
    }
    if (!ok.length) continue
    if (SINGLE_VALUE.has(f)) (meta as Record<string, unknown>)[f] = ok[0]
    else (meta as Record<string, unknown>)[f] = ok.length === 1 ? ok[0] : ok.slice(0, 3)
  }
  return { meta, invalid }
}

/** Short instruction for metadata extraction (forward): the allowed tags. */
export function vocabPromptHint(vocab: TagVocab | null): string {
  if (!vocab) return ''
  const lines: string[] = []
  for (const f of SANITIZE_FIELDS) {
    const fv = vocab.fields[f]
    if (fv?.canonical.length) lines.push(`- "${f}": choose ONLY from [${fv.canonical.join(', ')}]`)
  }
  if (!lines.length) return ''
  return `\n\nCONTROLLED VOCABULARY (mandatory — these replace the free-form examples above):\n${lines.join('\n')}\nIf the language cannot be determined from the information given, use the unknown value — never guess.`
}
