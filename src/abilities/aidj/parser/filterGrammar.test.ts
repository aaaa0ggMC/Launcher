import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseFilterCommand,
  parseFilterExpression,
  evaluateFilter,
  FilterParseError
} from './filterGrammar'
import { cachedVariantHaystack } from './chineseVariants'

/**
 * `evaluateFilter` receives a PRE-normalized haystack (commands.ts expands it to
 * both Chinese variants + lowercases when ignorecase is on). Mirror that here so
 * the plain-text tests exercise the same layer the real `/filter` run does.
 */
function norm(text: string): string {
  return cachedVariantHaystack(`test:${text}`, text)
}

/** Evaluate an expression against a normalized haystack + metadata (ignorecase on). */
function ev(expr: string, haystack: string, meta: Record<string, unknown> = {}): boolean {
  return evaluateFilter(parseFilterExpression(expr), { haystack: norm(haystack), meta }, true)
}

/** Evaluate with ignorecase OFF against the RAW haystack. */
function evRaw(expr: string, haystack: string, meta: Record<string, unknown> = {}): boolean {
  return evaluateFilter(parseFilterExpression(expr), { haystack, meta }, false)
}

describe('parseFilterCommand — flag parsing', () => {
  it('defaults: count=100, compare=title, ignorecase on', () => {
    const q = parseFilterCommand('周杰伦')
    assert.equal(q.count, 100)
    assert.equal(q.compare, 'title')
    assert.equal(q.ignoreCase, true)
    assert.deepEqual(q.expr, { type: 'match', text: '周杰伦' })
  })
  it('parses --count positive and negative (negative = all)', () => {
    assert.equal(parseFilterCommand('--count=50 x').count, 50)
    assert.equal(parseFilterCommand('--count=-1 x').count, -1)
  })
  it('parses --compare variants (case-insensitive)', () => {
    assert.equal(parseFilterCommand('--compare=lyrics x').compare, 'lyrics')
    assert.equal(parseFilterCommand('--compare=all x').compare, 'all')
    assert.equal(parseFilterCommand('--compare=TITLE x').compare, 'title')
  })
  it('parses --ignorecase off forms / default on', () => {
    assert.equal(parseFilterCommand('--ignorecase=false x').ignoreCase, false)
    assert.equal(parseFilterCommand('--ignorecase=0 x').ignoreCase, false)
    assert.equal(parseFilterCommand('--ignorecase=off x').ignoreCase, false)
    assert.equal(parseFilterCommand('--ignorecase=no x').ignoreCase, false)
    assert.equal(parseFilterCommand('--ignorecase x').ignoreCase, true)
    assert.equal(parseFilterCommand('--ignorecase=true x').ignoreCase, true)
  })
  it('multiple flags in any order are all applied', () => {
    const q = parseFilterCommand('--compare=all --count=10 --ignorecase=false foo')
    assert.deepEqual(
      { c: q.count, cmp: q.compare, ic: q.ignoreCase },
      { c: 10, cmp: 'all', ic: false }
    )
  })
  it('flags must precede the expression; anything after is part of the expr', () => {
    const q = parseFilterCommand('--count=5 a or b')
    assert.equal(q.count, 5)
    assert.equal(evaluateFilter(q.expr, { haystack: norm('b'), meta: {} }, true), true)
  })
})

describe('parseFilterCommand — error handling', () => {
  it('rejects unknown flags', () => {
    assert.throws(() => parseFilterCommand('--bogus x'), FilterParseError)
  })
  it('rejects --count=0 and non-numeric --count', () => {
    assert.throws(() => parseFilterCommand('--count=0 x'), FilterParseError)
    assert.throws(() => parseFilterCommand('--count=abc x'), FilterParseError)
  })
  it('rejects invalid --compare values', () => {
    assert.throws(() => parseFilterCommand('--compare=author x'), FilterParseError)
  })
  it('rejects a missing expression', () => {
    assert.throws(() => parseFilterCommand(''), FilterParseError)
    assert.throws(() => parseFilterCommand('--count=10   '), FilterParseError)
  })
})

describe('plain text matching', () => {
  it('substring match against title', () => {
    assert.equal(ev('周杰伦', '周杰伦 - 安静'), true)
    assert.equal(ev('周杰伦', '林俊杰 - 江南'), false)
  })
  it('case-insensitive by default', () => {
    assert.equal(ev('weeknd', 'The Weeknd - Blinding Lights'), true)
    assert.equal(ev('weeknd', 'Taylor Swift - The Man'), false)
  })
  it('--ignorecase=false → raw exact substring', () => {
    assert.equal(evRaw('"the weeknd"', 'The Weeknd - X'), false)
    assert.equal(evRaw('"the weeknd"', 'the weeknd - X'), true)
  })
  it('Chinese ST variant fuzzy: 简 query hits 繁 haystack and vice versa', () => {
    assert.equal(ev('周杰伦', '周杰倫 - 安靜'), true)
    assert.equal(ev('周杰倫', '周杰伦 - 安静'), true)
    assert.equal(ev('周杰伦', '周杰伦 - 安静'), true)
  })
  it('quoted segments match multi-word phrases', () => {
    assert.equal(ev('"The Weeknd"', 'Love Me Harder - The Weeknd'), true)
    assert.equal(ev('"周杰伦 林俊杰"', '周杰伦 林俊杰 - 双杰'), true)
    assert.equal(ev('"周杰伦 林俊杰"', '周杰伦 x 林俊杰'), false)
  })
  it('a bareword containing brackets is a literal term, not a field', () => {
    assert.equal(ev('foo[bar]', 'foo[bar] stuff'), true)
    assert.equal(ev('foo[bar]', 'foobar'), false)
  })
})

describe('boolean operators & precedence', () => {
  it('and binds tighter than or (a or b and c === a or (b and c))', () => {
    assert.equal(ev('a or b and c', 'b'), false)
    assert.equal(ev('a or b and c', 'b and c both'), true)
    assert.equal(ev('a or b and c', 'c'), false)
  })
  it('parens override precedence', () => {
    assert.equal(ev('(a or b) and c', 'a only'), false)
    assert.equal(ev('(a or b) and c', 'a and c'), true)
  })
  it('not', () => {
    assert.equal(ev('not 周杰伦', '林俊杰 - 江南'), true)
    assert.equal(ev('not 周杰伦', '周杰伦 - 安静'), false)
    assert.equal(ev('not (a or b)', 'b'), false)
    assert.equal(ev('not (a or b)', 'c'), true)
  })
  it('keywords are case-insensitive', () => {
    assert.equal(ev('a AND b OR NOT c', 'a b'), true)
    assert.equal(ev('A oR B', 'b'), true)
  })
  it('juxtaposed terms without and/or are a parse error', () => {
    assert.throws(() => parseFilterExpression('a b'), FilterParseError)
    assert.throws(() => parseFilterExpression('[emotion:孤独] 周杰伦'), FilterParseError)
  })
  it('stray parens / dangling operators are parse errors', () => {
    assert.throws(() => parseFilterExpression('(a'), FilterParseError)
    assert.throws(() => parseFilterExpression('a)'), FilterParseError)
    assert.throws(() => parseFilterExpression('and a'), FilterParseError)
    assert.throws(() => parseFilterExpression('a and'), FilterParseError)
    assert.throws(() => parseFilterExpression('a or'), FilterParseError)
    assert.throws(() => parseFilterExpression('not'), FilterParseError)
  })
  it('unterminated quote is a parse error', () => {
    assert.throws(() => parseFilterExpression('"unclosed'), FilterParseError)
  })
})

describe('[field:value] metadata terms', () => {
  it('matches a string field', () => {
    assert.equal(ev('[language:粤语]', '', { language: '粤语' }), true)
    assert.equal(ev('[language:粤语]', '', { language: '国语' }), false)
  })
  it('matches any element of an array field', () => {
    assert.equal(ev('[emotion:孤独]', '', { emotion: ['孤独', '伤感'] }), true)
    assert.equal(ev('[emotion:摇滚]', '', { emotion: ['孤独', '伤感'] }), false)
  })
  it('matches a comma-joined string field', () => {
    assert.equal(ev('[genre:流行]', '', { genre: '流行,抒情' }), true)
  })
  it('a song with no metadata for the field never matches', () => {
    assert.equal(ev('[emotion:孤独]', '', {}), false)
    assert.equal(ev('[emotion:孤独]', '', { language: '粤语' }), false)
  })
  it('value may contain spaces — no inner quotes needed', () => {
    assert.equal(ev('[emotion:very sad]', '', { emotion: 'very sad' }), true)
    assert.equal(ev('[emotion:very sad]', '', { emotion: 'very happy' }), false)
  })
  it('case-insensitive field matching by default', () => {
    assert.equal(ev('[genre:rnb]', '', { genre: 'RNB' }), true)
  })
  it('--ignorecase=false → raw field matching', () => {
    assert.equal(evRaw('[genre:rnb]', '', { genre: 'RNB' }), false)
    assert.equal(evRaw('[genre:rnb]', '', { genre: 'rnb' }), true)
  })
  it('Chinese ST fuzzy applies to metadata values too', () => {
    assert.equal(ev('[language:粤语]', '', { language: '粵語' }), true)
    assert.equal(ev('[emotion:孤獨]', '', { emotion: '孤独' }), true)
  })
  it('the first colon splits field/value; later colons stay in the value', () => {
    assert.equal(ev('[review:注意:这是标点]', '', { review: '注意:这是标点 的歌曲' }), true)
    assert.equal(ev('[review:注意:这是标点]', '', { review: '别的' }), false)
  })
  it('combines with and / or / parens', () => {
    assert.equal(
      ev('([emotion:孤独] or [emotion:伤感]) and [language:粤语]', '', {
        emotion: ['伤感'],
        language: '粤语'
      }),
      true
    )
    assert.equal(
      ev('([emotion:孤独] or [emotion:伤感]) and [language:粤语]', '', {
        emotion: ['伤感'],
        language: '国语'
      }),
      false
    )
  })
  it('not [field]', () => {
    assert.equal(ev('not [genre:古典]', '', { genre: '流行' }), true)
    assert.equal(ev('not [genre:古典]', '', { genre: '古典' }), false)
    // no metadata → matchField false → not flips to true
    assert.equal(ev('not [genre:古典]', '', {}), true)
  })
  it('field terms match metadata regardless of the compare haystack', () => {
    assert.equal(
      ev('[emotion:孤独]', 'a title that has nothing to do with it', { emotion: ['孤独'] }),
      true
    )
  })
  it('mixed field + text terms in one expression', () => {
    assert.equal(ev('[language:粤语] and (周杰伦)', '周杰伦 - 七里香', { language: '粤语' }), true)
    assert.equal(ev('[language:粤语] and (周杰伦)', '陈奕迅 - 浮夸', { language: '粤语' }), false)
  })
  it('works through the full /filter command parser', () => {
    const q = parseFilterCommand('--compare=all [language:粤语] and ("周杰伦")')
    assert.equal(
      evaluateFilter(
        q.expr,
        { haystack: norm('周杰伦 - 七里香\n(lyrics…)'), meta: { language: '粤语' } },
        true
      ),
      true
    )
    assert.equal(
      evaluateFilter(
        q.expr,
        { haystack: norm('陈奕迅 - 浮夸\n(lyrics…)'), meta: { language: '粤语' } },
        true
      ),
      false
    )
  })
})

describe('[field:value] syntax errors', () => {
  it('unknown field', () => {
    assert.throws(() => parseFilterExpression('[artist:周杰伦]'), /未知字段/)
  })
  it('missing value (incl. whitespace-only)', () => {
    assert.throws(() => parseFilterExpression('[emotion:]'), /缺少值/)
    assert.throws(() => parseFilterExpression('[emotion: ]'), /缺少值/)
  })
  it('missing colon', () => {
    assert.throws(() => parseFilterExpression('[emotion]'), /缺少冒号/)
  })
  it('unclosed bracket', () => {
    assert.throws(() => parseFilterExpression('[emotion:孤独'), /未闭合的/)
  })
  it('empty field name', () => {
    assert.throws(() => parseFilterExpression('[:孤独]'), /缺少字段名/)
  })
})
