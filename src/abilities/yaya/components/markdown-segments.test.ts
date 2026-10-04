import assert from 'node:assert/strict'
import { it } from 'node:test'
import { renderMarkdown, renderSegments } from './markdown'

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
