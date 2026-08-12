import { cachedVariantHaystack } from './chineseVariants'

/**
 * `/filter` expression grammar — small boolean-expression parser.
 *
 * Syntax (written in the chat input, no quotes around the whole expression):
 *
 *   /filter [--count=<N>] [--compare=title|lyrics|all] [--ignorecase=true|false] <expr>
 *
 *   --count       absent → 100 results; negative → every match; positive → capped
 *   --compare     title (song name, default) | lyrics (.lrc text) | all
 *   --ignorecase  default ON: English case-insensitive + Chinese simplified ⇄
 *                 traditional fuzzy (shared variant cache). OFF = raw exact
 *                 substring match, no cache.
 *   expr  := or
 *   or    := and ( 'or' and )*
 *   and   := unary ( 'and' unary )*
 *   unary := 'not' unary | '(' expr ')' | term
 *   term  := "quoted segment" | 'quoted segment' | bareword | field
 *   field := '[' <metadata-field> ':' <value> ']'
 *
 * Keywords are case-insensitive (`AND`/`OR`/`NOT`). With `--ignorecase` on
 * (default) a `term` is a case-insensitive substring match against the compare
 * haystack. Example:
 *
 *   /filter --compare=title ("The Weeknd" and "Justin Bieber") or ("Taylor")
 *
 * matches songs whose title contains ("the weeknd" AND "justin bieber")
 * OR contains "taylor".
 *
 * A `field` term matches a song's SYNCED METADATA (not title/lyrics) by the
 * same substring rule, and combines freely with the boolean operators:
 *
 *   /filter [emotion:孤独]                       — songs tagged with 孤独
 *   /filter [language:粤语] and ("周杰伦")         — 粤语 songs titled 周杰伦…
 *   /filter not [genre:古典]                     — everything not tagged 古典
 *
 * The value may contain spaces (the `[`…`]` bounds the whole token, so no
 * inner quotes are needed): `[emotion:very sad]`. The first `:` splits
 * field/value. Supported fields are the synced `SongMeta` keys.
 *
 * Chinese is matched variant-agnostically: the haystack is expanded to BOTH
 * simplified and traditional forms (`chineseVariants.ts`), so 「周杰伦」hits
 * 「周杰倫」lyrics and vice versa.
 *
 * Kept deliberately small (no `&`/`|`/`!` symbols, no precedence traps) — the
 * parens + keywords form reads naturally and maps 1:1 to the AST below.
 */

export type FilterNode =
  | { type: 'and'; left: FilterNode; right: FilterNode }
  | { type: 'or'; left: FilterNode; right: FilterNode }
  | { type: 'not'; operand: FilterNode }
  | { type: 'match'; text: string }
  | { type: 'field'; field: string; value: string }

/** Metadata fields usable in `[field:value]` terms (SongMeta keys). */
export const FILTER_FIELDS = ['language', 'emotion', 'genre', 'loudness', 'review'] as const
export type FilterField = (typeof FILTER_FIELDS)[number]

export interface FilterQuery {
  /** Result cap. 0 = default 100; negative = all matches. */
  count: number
  compare: 'title' | 'lyrics' | 'all'
  /** Default ON — English case-insensitive + Chinese ST fuzzy (shared cache). */
  ignoreCase: boolean
  expr: FilterNode
}

/** Per-song evaluation context passed to `evaluateFilter`. */
export interface FilterContext {
  /** The compare-selected haystack (`match` terms test against this). */
  haystack: string
  /** The song's metadata (`[field:value]` terms read from this). */
  meta: Record<string, unknown>
}

export class FilterParseError extends Error {}

/** Tokenize the expression: parens, quoted segments, bare words, `[field:value]`. */
function tokenize(src: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (c === '(' || c === ')') {
      tokens.push(c)
      i++
      continue
    }
    if (c === '[') {
      const close = src.indexOf(']', i + 1)
      if (close < 0) throw new FilterParseError('未闭合的 [，应形如 [字段:值]')
      tokens.push(src.slice(i, close + 1))
      i = close + 1
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let buf = ''
      while (j < src.length && src[j] !== c) {
        buf += src[j]
        j++
      }
      if (src[j] !== c) throw new FilterParseError('未闭合的引号')
      tokens.push(buf)
      i = j + 1
      continue
    }
    let j = i
    let buf = ''
    while (
      j < src.length &&
      !/\s/.test(src[j]) &&
      src[j] !== '(' &&
      src[j] !== ')' &&
      src[j] !== '"' &&
      src[j] !== "'"
    ) {
      buf += src[j]
      j++
    }
    tokens.push(buf)
    i = j
  }
  return tokens
}

const kw = (t: string | undefined, k: string): boolean => t?.toLowerCase() === k

/** Parse `--count` / `--compare` / `--ignorecase` flags off the front of the
 *  command body. `--count` absent → 100; negative → every match; positive →
 *  that many. `--compare` absent → title. `--ignorecase` default ON. */
export function parseFilterCommand(src: string): FilterQuery {
  let rest = src.trim()
  let count = 100
  let compare: FilterQuery['compare'] = 'title'
  let ignoreCase = true
  const flagRe = /^--([\w-]+)(?:=([^\s]*))?/
  while (true) {
    const m = rest.match(flagRe)
    if (!m) break
    const key = m[1]
    const val = m[2] ?? ''
    if (key === 'count') {
      const n = Number(val)
      if (!Number.isFinite(n) || n === 0)
        throw new FilterParseError('--count 需要非零整数（负数 = 全部输出）')
      count = n
    } else if (key === 'compare') {
      const v = val.toLowerCase()
      if (v !== 'title' && v !== 'lyrics' && v !== 'all')
        throw new FilterParseError('--compare 只能为 title / lyrics / all')
      compare = v
    } else if (key === 'ignorecase' || key === 'ignore-case') {
      ignoreCase = val === '' || !['0', 'false', 'off', 'no'].includes(val.toLowerCase())
    } else {
      throw new FilterParseError(`未知参数 --${key}`)
    }
    rest = rest.slice(m[0].length).trim()
  }
  if (!rest) throw new FilterParseError('缺少过滤表达式')
  return { count, compare, ignoreCase, expr: parseFilterExpression(rest) }
}

/** Recursive-descent parse of the boolean expression. */
export function parseFilterExpression(src: string): FilterNode {
  const tokens = tokenize(src)
  let pos = 0
  const peek = (): string | undefined => tokens[pos]
  const next = (): string | undefined => tokens[pos++]

  function parseOr(): FilterNode {
    let left = parseAnd()
    while (kw(peek(), 'or')) {
      next()
      left = { type: 'or', left, right: parseAnd() }
    }
    return left
  }

  function parseAnd(): FilterNode {
    let left = parseUnary()
    while (kw(peek(), 'and')) {
      next()
      left = { type: 'and', left, right: parseUnary() }
    }
    return left
  }

  function parseUnary(): FilterNode {
    if (kw(peek(), 'not')) {
      next()
      return { type: 'not', operand: parseUnary() }
    }
    return parsePrimary()
  }

  function parsePrimary(): FilterNode {
    const t = next()
    if (t === undefined) throw new FilterParseError('表达式意外结束')
    if (t === '(') {
      const inner = parseOr()
      if (next() !== ')') throw new FilterParseError('缺少右括号 )')
      return inner
    }
    if (t === ')') throw new FilterParseError('多余的右括号 )')
    if (kw(t, 'and') || kw(t, 'or') || kw(t, 'not'))
      throw new FilterParseError(`运算符 "${t}" 缺少操作数`)
    const fieldMatch = /^\[(.+)\]$/.exec(t)
    if (fieldMatch) {
      const inner = fieldMatch[1]
      const colon = inner.indexOf(':')
      if (colon < 0) throw new FilterParseError('字段项格式应为 [字段:值]，缺少冒号')
      const field = inner.slice(0, colon).trim()
      const value = inner.slice(colon + 1).trim()
      if (!field) throw new FilterParseError('字段项缺少字段名（如 [emotion:孤独]）')
      if (!value) throw new FilterParseError(`字段项 [${field}] 缺少值（如 [${field}:xxx]）`)
      if (!(FILTER_FIELDS as readonly string[]).includes(field)) {
        throw new FilterParseError(`未知字段 "${field}" — 可用: ${FILTER_FIELDS.join(' / ')}`)
      }
      return { type: 'field', field, value }
    }
    return { type: 'match', text: t }
  }

  const node = parseOr()
  if (peek() !== undefined) throw new FilterParseError(`无法解析的输入: ${peek()}`)
  return node
}

/** Normalize a metadata value to one searchable string. Arrays are joined with
 *  a newline so each element stays independently matchable. */
function fieldValueText(value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value))
    return value.filter((v): v is string => typeof v === 'string').join('\n')
  return String(value)
}

/** Match a `[field:value]` term against one song's metadata. Same substring +
 *  (ignoreCase) variant-agnostic semantics as a plain `match` term. Songs with
 *  no metadata for the field never match. */
function matchField(
  node: { field: string; value: string },
  meta: Record<string, unknown>,
  ignoreCase: boolean
): boolean {
  const raw = fieldValueText(meta[node.field])
  if (!raw) return false
  const needle = ignoreCase ? node.value.toLowerCase() : node.value
  if (!needle) return false
  const hay = ignoreCase ? cachedVariantHaystack(`meta:${node.field}:${raw}`, raw) : raw
  return hay.includes(needle)
}

/** Evaluate a parsed node against a context. `ignoreCase=false` disables term
 *  lowercasing — the haystack must already be the raw (un-normalized) text. */
export function evaluateFilter(node: FilterNode, ctx: FilterContext, ignoreCase = true): boolean {
  switch (node.type) {
    case 'and':
      return (
        evaluateFilter(node.left, ctx, ignoreCase) && evaluateFilter(node.right, ctx, ignoreCase)
      )
    case 'or':
      return (
        evaluateFilter(node.left, ctx, ignoreCase) || evaluateFilter(node.right, ctx, ignoreCase)
      )
    case 'not':
      return !evaluateFilter(node.operand, ctx, ignoreCase)
    case 'match':
      return ctx.haystack.includes(ignoreCase ? node.text.toLowerCase() : node.text)
    case 'field':
      return matchField(node, ctx.meta, ignoreCase)
  }
}
