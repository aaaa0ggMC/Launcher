import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ThinkTagSplitter, splitThinkTags } from './think-tags'
import { detailsText, isSummaryDetails, mergeReasoningDetails } from './reasoning-details'
import {
  guessBuiltinSearch,
  openaiSearchStyle,
  SearchCollector,
  supportsBuiltinSearch
} from './builtin-search'
import { chosenSearchMode, useBuiltinSearch, withoutGenericSearch } from '../search-mode'
import type { YayaConfig } from '../../types'

function feed(chunks: string[]): { content: string; reasoning: string; tag: string | null } {
  const s = new ThinkTagSplitter()
  let content = ''
  let reasoning = ''
  for (const c of [...chunks.map((x) => s.push(x)), s.flush()]) {
    content += c.content
    reasoning += c.reasoning
  }
  return { content, reasoning, tag: s.sawTag }
}

test('正文开头的 <thought> / <think>：流式拆开，标签被切在两块之间也能认', () => {
  assert.deepEqual(feed(['<tho', 'ught>**Plan**\n\nlook', ' up</th', 'ought>\n\nHello']), {
    content: 'Hello',
    reasoning: '**Plan**\n\nlook up',
    tag: '<thought>'
  })
  assert.deepEqual(feed(['  <think>a</think><think>b</think>', 'Hi <think>x</think>']), {
    content: 'Hi <think>x</think>',
    reasoning: 'ab',
    tag: '<think>'
  })
})

test('不在开头的标签 / 普通文本原样当正文；没闭合的标签算思考', () => {
  assert.deepEqual(feed(['Use ', '<think> tags']), {
    content: 'Use <think> tags',
    reasoning: '',
    tag: null
  })
  assert.deepEqual(feed(['<', 'b>bold</b>']), { content: '<b>bold</b>', reasoning: '', tag: null })
  assert.deepEqual(feed(['<think>still thinking']), {
    content: '',
    reasoning: 'still thinking',
    tag: '<think>'
  })
  assert.deepEqual(splitThinkTags('plain'), { content: 'plain', reasoning: '', tag: null })
})

test('reasoning_details：按 index 合并增量，摘要 / 原文可显示，加密块保留', () => {
  let acc = mergeReasoningDetails(
    [],
    [{ type: 'reasoning.summary', index: 0, summary: '**Plan** ' }]
  )
  acc = mergeReasoningDetails(acc, [
    { type: 'reasoning.summary', index: 0, summary: 'step' },
    { type: 'reasoning.encrypted', index: 1, data: 'abc' }
  ])
  assert.equal(acc.length, 2)
  assert.equal(acc[0].summary, '**Plan** step')
  assert.equal(detailsText([{ type: 'reasoning.text', text: 'raw' }]), 'raw')
  assert.equal(detailsText([{ type: 'reasoning.encrypted', data: 'x' }]), '')
  assert.equal(isSummaryDetails(acc), true)
  assert.equal(isSummaryDetails([{ type: 'reasoning.text', text: 'r' }]), false)
})

test('自带搜索：按类型 / 地址 / 名字猜，逐模型设置优先', () => {
  assert.equal(guessBuiltinSearch({ type: 'gemini' }, 'gemini-2.5-flash'), true)
  assert.equal(guessBuiltinSearch({ type: 'gemini' }, 'gemini-embedding-001'), false)
  assert.equal(guessBuiltinSearch({ type: 'gemini' }, 'gemma-3-27b-it'), false)
  assert.equal(guessBuiltinSearch({ type: 'anthropic' }, 'claude-sonnet-4-5'), true)
  assert.equal(guessBuiltinSearch({ type: 'anthropic' }, 'claude-3-haiku-20240307'), false)
  const or = { type: 'openai' as const, baseUrl: 'https://openrouter.ai/api/v1' }
  assert.equal(openaiSearchStyle(or), 'openrouter')
  assert.equal(guessBuiltinSearch(or, 'anything/model'), true)
  const oai = { type: 'openai' as const }
  assert.equal(guessBuiltinSearch(oai, 'gpt-4o-search-preview'), true)
  assert.equal(guessBuiltinSearch(oai, 'gpt-4o'), false)
  assert.equal(guessBuiltinSearch({ type: 'ollama' }, 'qwen3'), false)
  assert.equal(supportsBuiltinSearch({ ...oai, builtinSearch: { 'gpt-4o': true } }, 'gpt-4o'), true)
  assert.equal(
    supportsBuiltinSearch({ type: 'gemini', builtinSearch: { 'gemini-x': false } }, 'gemini-x'),
    false
  )
})

test('SearchCollector：查询词与来源去重，没用到搜索就没有结果', () => {
  const c = new SearchCollector()
  assert.equal(c.result(), undefined)
  c.query(' weather ')
  c.query('weather')
  c.annotations([{ type: 'url_citation', url_citation: { url: 'https://a.com', title: 'A' } }])
  c.source('https://a.com', 'dup')
  c.source('javascript:alert(1)')
  c.qwenSearchInfo({ search_results: [{ url: 'https://b.com', title: 'B' }] })
  assert.deepEqual(c.result(), {
    queries: ['weather'],
    sources: [
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' }
    ]
  })
})

test('搜索模式：会话 → 默认；builtin 只在模型支持时生效，生效时关掉 GenericSearch', () => {
  assert.equal(chosenSearchMode({}, undefined), 'generic')
  assert.equal(chosenSearchMode({ searchMode: 'builtin' }, undefined), 'builtin')
  assert.equal(chosenSearchMode({ searchMode: 'builtin' }, { search: 'generic' }), 'generic')
  assert.equal(useBuiltinSearch('builtin', { type: 'gemini' }, 'gemini-2.5-pro'), true)
  assert.equal(useBuiltinSearch('builtin', { type: 'ollama' }, 'qwen3'), false)
  assert.equal(useBuiltinSearch('generic', { type: 'gemini' }, 'gemini-2.5-pro'), false)
  const cfg = { pluginEnabled: { mermaid: true } } as unknown as YayaConfig
  assert.deepEqual(withoutGenericSearch(cfg).pluginEnabled, { mermaid: true, search: false })
  assert.deepEqual(cfg.pluginEnabled, { mermaid: true })
})
