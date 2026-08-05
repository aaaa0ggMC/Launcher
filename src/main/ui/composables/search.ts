/**
 * Unified search helper — the one scoring mechanism every search box uses.
 *
 * Semantics (intentional, shared by all search surfaces):
 *  - The query is split on whitespace into independent tokens.
 *  - AND combination: every token must hit at least one field, otherwise the
 *    item is excluded (e.g. "系统 A" requires both 「系统」 and 「A」).
 *  - Weighted ranking: tokens score higher against more important fields
 *    (name > alias > description > category/other). Same weight on the same
 *    token doesn't double-count.
 *  - Returns the total score (0 = no match). Callers sort desc by it.
 */

export interface SearchField {
  /** lowercase haystack text */
  text: string
  /** relative importance, higher wins the sort */
  weight: number
}

/** Split a raw query into lowercase tokens. */
export function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * Score an item against a query. 0 = no match; otherwise the summed best weight
 * per token. `fields` may be empty for items with no searchable text.
 */
export function scoreFields(query: string, fields: SearchField[]): number {
  const tokens = tokenize(query)
  if (!tokens.length) return 1
  let total = 0
  for (const tok of tokens) {
    let best = 0
    for (const f of fields) {
      if (f.text.includes(tok) && f.weight > best) best = f.weight
    }
    if (!best) return 0 // this token matched nothing → whole item excluded
    total += best
  }
  return total
}

/**
 * Filter + rank an array by a query. `toFields` builds the per-item search
 * fields; items with score 0 are dropped, the rest are sorted desc.
 */
export function filterByQuery<T>(
  items: T[],
  query: string,
  toFields: (item: T) => SearchField[]
): T[] {
  const scored: { item: T; score: number }[] = []
  for (const item of items) {
    const score = scoreFields(query, toFields(item))
    if (score > 0) scored.push({ item, score })
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.item)
}

/** Build a ranked fields list for the common name / alias / description shape. */
export function fields(
  name: string,
  alias: string,
  description: string,
  ...extra: SearchField[]
): SearchField[] {
  const list: SearchField[] = []
  if (name) list.push({ text: name.toLowerCase(), weight: 3 })
  if (alias) list.push({ text: alias.toLowerCase(), weight: 2 })
  if (description) list.push({ text: description.toLowerCase(), weight: 1 })
  return list.concat(extra)
}
