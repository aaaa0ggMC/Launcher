import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildUrl,
  formatCatalog,
  formatInfo,
  instancesOf,
  parseParams,
  selectInstances,
  sourceType,
  SOURCE_TYPES,
  DEFAULT_INSTANCES,
  type InfoInstance
} from './info-sources'

const inst = (o: Partial<InfoInstance> = {}): InfoInstance => ({
  name: '渠道A',
  type: 'wikipedia',
  enabled: true,
  ...o
})

test('类型注册表：id 唯一、模板非空（generic 除外）、extract 是函数', () => {
  const ids = SOURCE_TYPES.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const t of SOURCE_TYPES) {
    assert.equal(typeof t.extract, 'function', t.id)
    if (t.id !== 'generic') assert.ok(t.template.includes('{query}'), t.id)
    assert.ok(t.label && t.hint, t.id)
  }
  assert.ok(sourceType('wikipedia'))
  assert.equal(sourceType('nope'), null)
})

test('parseParams：解析与忽略坏项', () => {
  assert.deepEqual(parseParams('a=1&b=2'), { a: '1', b: '2' })
  // 没有 = 的、= 前为空的都忽略
  assert.deepEqual(parseParams(' a = 1 && =x &b'), { a: '1' })
  assert.deepEqual(parseParams(undefined), {})
})

test('buildUrl：{query} 编码、实例参数覆盖类型默认', () => {
  const t = sourceType('wikipedia')!
  const url = buildUrl(inst(), t, '量子 计算')
  assert.ok(url.includes('gsrsearch=%E9%87%8F%E5%AD%90%20%E8%AE%A1%E7%AE%97'))
  assert.ok(!url.includes('{query}'))
  // 类型没有默认参数时不再拼 ?
  const url2 = buildUrl(inst({ type: 'duckduckgo' }), sourceType('duckduckgo')!, 'ai')
  assert.ok(url2.startsWith('https://api.duckduckgo.com/?q=ai'))
  // 实例参数追加
  const url3 = buildUrl(inst({ params: 'gsrlimit=1' }), t, 'x')
  assert.ok(url3.includes('gsrlimit=1'))
  // 自定义模板覆盖默认
  const url4 = buildUrl(
    inst({ type: 'generic', template: 'https://x.test/api?q={query}&lang=zh' }),
    sourceType('generic')!,
    'hello world'
  )
  assert.equal(url4, 'https://x.test/api?q=hello%20world&lang=zh')
})

test('selectInstances：按启用状态与名字 / 类型点名，未命中的报出来', () => {
  const list = [
    inst({ name: '维基' }),
    inst({ name: '学术', type: 'openalex' }),
    inst({ name: '停用', type: 'crossref', enabled: false }),
    inst({ name: '坏类型', type: 'nope' })
  ]
  const all = selectInstances(list)
  assert.deepEqual(
    all.picked.map((p) => p.name),
    ['维基', '学术']
  )
  const byName = selectInstances(list, ['维基'])
  assert.deepEqual(
    byName.picked.map((p) => p.name),
    ['维基']
  )
  const byType = selectInstances(list, ['OPENALEX'])
  assert.deepEqual(
    byType.picked.map((p) => p.name),
    ['学术']
  )
  const miss = selectInstances(list, ['不存在'])
  assert.deepEqual(miss.picked, [])
  assert.deepEqual(miss.notFound, ['不存在'])
})

test('抽取器：各类样例响应都能抽出条目（缺字段不抛）', () => {
  const wiki = sourceType('wikipedia')!.extract(
    {
      query: {
        pages: {
          '1': { pageid: 1, title: 'AI', extract: 'Artificial <b>intelligence</b>', index: 1 }
        }
      }
    },
    { query: 'AI' }
  )
  assert.equal(wiki.length, 1)
  assert.equal(wiki[0].title, 'AI')
  assert.ok(!wiki[0].text.includes('<b>'))
  assert.equal(wiki[0].url, 'https://en.wikipedia.org/?curid=1')

  const openalex = sourceType('openalex')!.extract(
    {
      results: [
        {
          display_name: 'A paper',
          publication_year: 2024,
          cited_by_count: 7,
          doi: 'https://doi.org/10.1/x'
        }
      ]
    },
    { query: 'x' }
  )
  assert.equal(openalex[0].title, 'A paper')
  assert.ok(openalex[0].text.includes('被引 7'))

  const arxiv = sourceType('arxiv')!.extract(
    '<feed><entry><title>  A title </title><summary>Some summary here.</summary><id>http://arxiv/1</id><published>2025-01-02T</published></entry></feed>',
    { query: 'x' }
  )
  assert.equal(arxiv.length, 1)
  assert.equal(arxiv[0].title, 'A title')
  assert.ok(arxiv[0].url?.startsWith('http://arxiv/'))

  const countries = sourceType('countries')!.extract(
    [{ name: { common: 'Canada' }, capital: ['Ottawa'], region: 'Americas', population: 38000000 }],
    { query: 'Canada' }
  )
  assert.ok(countries[0].text.includes('首都 Ottawa'))

  const ddg = sourceType('duckduckgo')!.extract(
    { Heading: 'X', AbstractText: 'about X' },
    { query: 'x' }
  )
  assert.equal(ddg.length, 1)

  const generic = sourceType('generic')!.extract(
    [{ name: 'thing', description: 'desc', url: 'https://a' }],
    { query: 'q' }
  )
  assert.equal(generic[0].title, 'thing')
  assert.equal(generic[0].url, 'https://a')

  // 空 / 坏响应一律空数组，不抛
  for (const t of SOURCE_TYPES) {
    assert.deepEqual(t.extract(null, { query: 'q' }), [], t.id)
    assert.deepEqual(t.extract('not json', { query: 'q' }).length >= 0, true, t.id)
  }
})

test('formatInfo：分节、失败有说明、封顶截断', () => {
  const t = sourceType('wikipedia')!
  const text = formatInfo([
    { instance: inst(), type: t, items: [{ title: 'A', text: 'x'.repeat(500), url: 'https://a' }] },
    { instance: inst({ name: 'B' }), type: t, items: [] },
    { instance: inst({ name: 'C' }), type: t, error: 'timeout' }
  ])
  assert.ok(text.includes('### 渠道A（Wikipedia 概要）'))
  assert.ok(text.includes('**A**'))
  assert.ok(text.includes('（https://a）'))
  assert.ok(text.includes('没有命中'))
  assert.ok(text.includes('取数失败：timeout'))
  assert.ok(text.split('**A**')[1].length < 500, '单条文本应被截断')

  const long = formatInfo(
    [{ instance: inst(), type: t, items: [{ title: 'A', text: 'y'.repeat(200) }] }],
    {
      maxChars: 20
    }
  )
  assert.ok(long.endsWith('…（超长已截断）'))
})

test('instancesOf：没配回落种子、显式空数组尊重、脏条目丢弃', () => {
  for (const raw of [undefined, null, '', 'not json', '{"a":1}']) {
    assert.deepEqual(instancesOf(raw), DEFAULT_INSTANCES, String(raw))
  }
  assert.deepEqual(instancesOf('[]'), [])
  const list = instancesOf(
    JSON.stringify([
      { name: '维基', type: 'wikipedia' },
      { name: '', type: 'wikipedia' },
      { name: '无类型', type: '' },
      'junk',
      {
        name: '带参数',
        type: 'generic',
        template: 'https://x/{query}',
        params: 'a=1',
        note: '自定义',
        enabled: false
      }
    ])
  )
  assert.deepEqual(
    list.map((i) => i.name),
    ['维基', '带参数']
  )
  assert.equal(list[1].enabled, false)
  assert.equal(list[1].template, 'https://x/{query}')
})

test('formatCatalog：列出启用渠道与类型', () => {
  const text = formatCatalog([inst({ name: '维基' }), inst({ name: '停', enabled: false })])
  assert.ok(text.includes('`维基`'))
  assert.ok(!text.includes('`停`'))
  assert.equal(formatCatalog([]), '（还没有配置任何信息源渠道）')
})
