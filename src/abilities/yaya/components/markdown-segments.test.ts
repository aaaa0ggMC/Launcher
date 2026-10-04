import assert from 'node:assert/strict'
import { it } from 'node:test'
import { renderMarkdown, renderSegments, splitBlocks } from './markdown'

const labels = { copy: 'Copy' }
it('plugin fences split top-level content while surrounding raw HTML stays escaped', () => {
  const text = '<script>alert(1)</script>\n\n```widget\nsource\n```\n\nAfter'
  const segments = renderSegments(text, new Set(['widget']), labels)
  assert.deepEqual(
    segments.map((s) => s.kind),
    ['html', 'fence', 'html']
  )
  assert.equal(segments[1].kind === 'fence' && segments[1].source, 'source\n')
  assert.ok(segments[0].kind === 'html' && segments[0].html.includes('&lt;script&gt;'))
})
it('tilde fences work and an incomplete longer fence remains open', () => {
  const tilde = renderSegments('~~~widget\nx\n~~~', new Set(['widget']), labels)[0]
  assert.ok(tilde.kind === 'fence' && tilde.closed)
  const partial = renderSegments('````widget\nx\n```', new Set(['widget']), labels)[0]
  assert.ok(partial.kind === 'fence' && !partial.closed)
})
it('unclaimed markdown keeps the normal renderer output', () => {
  const text = '# Heading\n\nRegular **text**'
  assert.deepEqual(renderSegments(text, new Set(['widget']), labels), [
    { kind: 'html', html: renderMarkdown(text, labels) }
  ])
})
it('splitBlocks keeps fences, math, loose lists and indented continuations together', () => {
  const text = [
    'Intro para',
    '',
    '```js',
    'a()',
    '',
    'b()',
    '```',
    '',
    '- one',
    '',
    '- two',
    '',
    '  continued',
    '',
    '$$',
    'x',
    '',
    'y',
    '$$',
    '',
    'End'
  ].join('\n')
  assert.deepEqual(splitBlocks(text), [
    'Intro para',
    '```js\na()\n\nb()\n```',
    '- one\n\n- two\n\n  continued',
    '$$\nx\n\ny\n$$',
    'End'
  ])
})
it('block-cached rendering equals rendering the joined blocks, also while streaming', () => {
  const full = '# T\n\npara **b**\n\n```py\nprint(1)\n```\n\n1. a\n2. b\n\nlast'
  for (let n = 1; n <= full.length; n += 7) {
    const part = full.slice(0, n)
    const expected = splitBlocks(part)
      .map((b) => renderMarkdown(b, labels))
      .join('')
    assert.equal(renderMarkdown(part, labels), expected)
  }
  // 插件代码块在中间块、未闭合的在末尾
  const segs = renderSegments(
    'a\n\n```widget\nx\n```\n\nb\n\n```widget\ny',
    new Set(['widget']),
    labels
  )
  assert.deepEqual(
    segs.map((s) => (s.kind === 'fence' ? `fence:${s.closed}` : 'html')),
    ['html', 'fence:true', 'html', 'fence:false']
  )
})
