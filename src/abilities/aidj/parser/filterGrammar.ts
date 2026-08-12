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
 *   term  := "quoted segment" | 'quoted segment' | bareword
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

export interface FilterQuery {
  /** Result cap. 0 = default 100; negative = all matches. */
  count: number
  compare: 'title' | 'lyrics' | 'all'
  /** Default ON — English case-insensitive + Chinese ST fuzzy (shared cache). */
  ignoreCase: boolean
  expr: FilterNode
}

export class FilterParseError extends Error {}

/** Tokenize the expression: parens, quoted segments, bare words. */
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
    return { type: 'match', text: t }
  }

  const node = parseOr()
  if (peek() !== undefined) throw new FilterParseError(`无法解析的输入: ${peek()}`)
  return node
}

/** Evaluate a parsed node against a haystack. `ignoreCase=false` disables the
 *  term lowercasing — the haystack must already be the raw (un-normalized) text. */
export function evaluateFilter(node: FilterNode, haystack: string, ignoreCase = true): boolean {
  switch (node.type) {
    case 'and':
      return (
        evaluateFilter(node.left, haystack, ignoreCase) &&
        evaluateFilter(node.right, haystack, ignoreCase)
      )
    case 'or':
      return (
        evaluateFilter(node.left, haystack, ignoreCase) ||
        evaluateFilter(node.right, haystack, ignoreCase)
      )
    case 'not':
      return !evaluateFilter(node.operand, haystack, ignoreCase)
    case 'match':
      return haystack.includes(ignoreCase ? node.text.toLowerCase() : node.text)
  }
}
