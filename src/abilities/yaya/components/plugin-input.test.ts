import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchInputTrigger } from './plugin-input'

const triggers = [{ prefix: '@', maxQueryLength: 32 }, { prefix: '/skill' }]
test('matches literal keyword prefixes at the caret and preserves trailing text', () => {
  assert.deepEqual(matchInputTrigger('before @chart after', 13, triggers), {
    prefix: '@',
    query: 'chart',
    start: 7,
    end: 13
  })
  assert.equal(matchInputTrigger('/skillmath', 10, triggers)?.query, 'math')
})
test('avoids emails, whitespace queries, repeated prefixes and overlong queries', () => {
  for (const text of ['name@example.com', '@two words', '@@', '@' + 'x'.repeat(33)])
    assert.equal(matchInputTrigger(text, text.length, triggers), null)
})
test('supports literal metacharacters, Unicode and optional boundaries', () => {
  assert.equal(matchInputTrigger(' @图表', 4, triggers)?.query, '图表')
  assert.equal(matchInputTrigger('x[abc', 5, [{ prefix: '[', boundary: false }])?.query, 'abc')
  assert.equal(matchInputTrigger('anything', 8, [{ prefix: '' }]), null)
})
