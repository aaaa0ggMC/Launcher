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
it('unclosed fence at the end (streaming) is open and runs to the end of the text', () => {
  const segs = renderSegments('Intro\n\n```mermaid\ngraph TD\nA-->B', new Set(['mermaid']), labels)
  const last = segs[segs.length - 1]
  assert.ok(last.kind === 'fence' && !last.closed)
  assert.equal(last.kind === 'fence' && last.source, 'graph TD\nA-->B')
  // 只写了开头一行
  const opening = renderSegments('```mermaid', new Set(['mermaid']), labels)[0]
  assert.ok(opening.kind === 'fence' && !opening.closed && opening.source === '')
})
it('nested fences are not claimed: inside a longer outer fence, a list item or a blockquote', () => {
  const langs = new Set(['mermaid'])
  const outer = renderSegments('````markdown\n```mermaid\nA\n```\n````', langs, labels)
  assert.deepEqual(
    outer.map((s) => s.kind),
    ['html']
  )
  const list = renderSegments('- item\n\n  ```mermaid\n  A\n  ```', langs, labels)
  assert.ok(list.every((s) => s.kind === 'html'))
  const quote = renderSegments('> ```mermaid\n> A\n> ```', langs, labels)
  assert.ok(quote.every((s) => s.kind === 'html'))
})
it('adjacent claimed fences and an empty fence', () => {
  const segs = renderSegments(
    '```svg\n<svg/>\n```\n```mermaid\nA\n```\n\n```svg\n```',
    new Set(['svg', 'mermaid']),
    labels
  )
  assert.deepEqual(
    segs.map((s) => (s.kind === 'fence' ? `${s.lang}:${s.closed}:${s.source}` : s.kind)),
    ['svg:true:<svg/>\n', 'mermaid:true:A\n', 'svg:true:']
  )
})
