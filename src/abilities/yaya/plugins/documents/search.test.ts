import { it } from 'node:test'
import assert from 'node:assert/strict'
import { buildIndex, outline, readLines, searchIndex, tokenize } from './search'

it('分词：英文单词 + 中文二元组', () => {
  assert.deepEqual(tokenize('Linux 内核调度'), ['linux', '内核', '核调', '调度'])
  assert.deepEqual(tokenize('a 字'), ['字'])
})

function doc(): string {
  const lines: string[] = []
  for (let i = 1; i <= 300; i++) lines.push(`filler line ${i} lorem ipsum`)
  lines[149] = 'The CFS scheduler uses a red-black tree keyed by vruntime.'
  lines[150] = '完全公平调度器使用红黑树。'
  lines[279] = 'Appendix: scheduler tunables'
  return lines.join('\n')
}

it('检索：命中段落排前，行号是原文行号，重叠块去重', () => {
  const idx = buildIndex(doc())
  const hits = searchIndex(idx, 'red-black tree vruntime', 3)
  assert.ok(hits.length >= 1)
  assert.ok(hits[0].startLine <= 150 && hits[0].endLine >= 150)
  assert.match(hits[0].text, /vruntime/)
  for (let i = 1; i < hits.length; i++)
    assert.ok(hits[i].startLine > hits[0].endLine || hits[i].endLine < hits[0].startLine)
})

it('检索：中文查询（含单字）', () => {
  const idx = buildIndex(doc())
  assert.ok(searchIndex(idx, '红黑树')[0].startLine <= 151)
  assert.ok(searchIndex(idx, '树').length >= 1)
  assert.deepEqual(searchIndex(idx, 'nonexistentword'), [])
})

it('超长单行按字数切块，命中文本截在命中词附近', () => {
  const long = 'x'.repeat(5000) + ' needle ' + 'y'.repeat(5000)
  const idx = buildIndex(long)
  assert.ok(idx.chunks.length > 1)
  const hits = searchIndex(idx, 'needle', 1, 200)
  assert.equal(hits.length, 1)
  assert.ok(hits[0].text.length <= 202)
  assert.match(hits[0].text, /needle/)
})

it('按行读取：夹取范围并带行号', () => {
  const idx = buildIndex('a\nb\nc\nd')
  const r = readLines(idx, 3, 10)
  assert.deepEqual([r.start, r.end, r.total], [3, 4, 4])
  assert.equal(r.text, '3│c\n4│d')
  assert.equal(readLines(idx, 99, 1).start, 4)
})

it('摘要：Markdown 标题优先', () => {
  assert.equal(outline('# A\ntext\n## B\n## C\nmore'), '# A / ## B / ## C')
  assert.equal(outline('first\n\nsecond'), 'first / second')
})
