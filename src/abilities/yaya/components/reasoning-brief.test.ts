import { test } from 'node:test'
import assert from 'node:assert/strict'
import { latestReasoningTitle, reasoningSections } from './reasoning-brief'

test('思考摘要按「**小标题**」分段；原始思维链是一整段', () => {
  assert.deepEqual(
    reasoningSections('**Planning the search**\n\nI need to look up X.\n\n**Comparing**\n\nA vs B'),
    [
      { title: 'Planning the search', body: 'I need to look up X.' },
      { title: 'Comparing', body: 'A vs B' }
    ]
  )
  assert.deepEqual(reasoningSections('raw chain **not a heading** here\nmore'), [
    { title: '', body: 'raw chain **not a heading** here\nmore' }
  ])
  assert.deepEqual(reasoningSections(''), [{ title: '', body: '' }])
  assert.deepEqual(reasoningSections('intro\n**T**\nbody'), [
    { title: '', body: 'intro' },
    { title: 'T', body: 'body' }
  ])
})

test('最新的小标题', () => {
  assert.equal(latestReasoningTitle('**A**\n\nx\n\n**B**\n\ny'), 'B')
  assert.equal(latestReasoningTitle('no headings'), '')
  assert.equal(latestReasoningTitle(undefined), '')
})

test('上一段句号后直接接下一段小标题也能拆开', () => {
  assert.deepEqual(reasoningSections('**A**\n\nDone.**B**\n\nmore'), [
    { title: 'A', body: 'Done.' },
    { title: 'B', body: 'more' }
  ])
  assert.equal(latestReasoningTitle('**A**\nx.**B**'), 'B')
  assert.deepEqual(reasoningSections('This is **key**\nnext'), [
    { title: '', body: 'This is **key**\nnext' }
  ])
})
