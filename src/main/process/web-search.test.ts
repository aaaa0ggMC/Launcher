/**
 * `web-search`（多引擎联合搜索）的单测。
 *
 * 全程不联网：用 `__setHttpFetchForTest` 注入按 URL 分发的假 fetch，
 * 各家引擎的响应按官方文档的字段形状构造。
 *
 * 隔离：HOME / XDG_CONFIG_HOME 在 import 任何项目模块之前指向 /tmp 下的临时目录，
 * 避免碰真实 ~/.config/LinuxCockpit。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { after, before, it } from 'node:test'

process.env.HOME = mkdtempSync('/tmp/web-search-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

if (!process.env.HOME.startsWith('/tmp/')) {
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')
}
if (!process.env.XDG_CONFIG_HOME.startsWith('/tmp/')) {
  throw new Error('拒绝运行：XDG_CONFIG_HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

let ws: typeof import('./web-search')

before(async () => {
  ws = await import('./web-search')
})

after(() => {
  ws.__setHttpFetchForTest(null)
})

// ---------------------------------------------------------------------------
// 假 fetch
// ---------------------------------------------------------------------------

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** 按 URL 片段分发；没有匹配的路径说明请求了没想到的地址 */
function router(routes: Record<string, Handler>): FetchLike {
  return async (url, init) => {
    const target = String(url)
    // 已中止的信号：真实 fetch 会直接拒绝，假 fetch 也照做
    if (init.signal?.aborted) throw init.signal.reason ?? new Error('aborted')
    for (const [needle, handler] of Object.entries(routes)) {
      if (target.includes(needle)) return handler(target, init)
    }
    throw new Error(`unexpected fetch: ${target}`)
  }
}

function setRoutes(routes: Record<string, Handler>): void {
  ws.__setHttpFetchForTest(router(routes))
}

const TAVILY_BODY = {
  answer: 'tavily answer',
  results: [
    { title: 'A1', url: 'https://a.test/1', content: 'a1 snippet' },
    { title: 'Shared', url: 'https://s.test/x', content: 'shared snippet' },
    { title: 'A3', url: 'https://a.test/3', content: 'a3 snippet' }
  ]
}

const BRAVE_BODY = {
  web: {
    results: [
      {
        title: 'Shared(B)',
        url: 'https://s.test/x/?utm_medium=z#top',
        description: 'brave shared'
      },
      { title: 'B1', url: 'https://b.test/1', description: 'b1 snippet' }
    ]
  }
}

// ---------------------------------------------------------------------------
// URL 归一化
// ---------------------------------------------------------------------------

it('normalizeUrl 去 hash、utm_* 与末尾斜杠', () => {
  assert.equal(
    ws.normalizeUrl('https://x.test/a/?utm_source=a&utm_campaign=b#frag'),
    'https://x.test/a'
  )
  assert.equal(ws.normalizeUrl('https://x.test/a'), 'https://x.test/a')
  assert.equal(ws.normalizeUrl('https://x.test/'), 'https://x.test')
  // 非 utm_ 参数保留
  assert.equal(ws.normalizeUrl('https://x.test/s?q=1'), 'https://x.test/s?q=1')
  // 非法 URL 原样返回（去首尾空白）
  assert.equal(ws.normalizeUrl('  not a url  '), 'not a url')
})

// ---------------------------------------------------------------------------
// 去重合并
// ---------------------------------------------------------------------------

it('同一 URL 跨引擎去重，engines 记录两个来源', async () => {
  setRoutes({
    'api.tavily.com': () =>
      json({
        answer: null,
        results: [{ title: 'A', url: 'https://e.test/a/?utm_source=x', content: 'tavily text' }]
      }),
    'api.search.brave.com': () =>
      json({
        web: { results: [{ title: 'B', url: 'https://e.test/a#top', description: 'brave text' }] }
      })
  })

  const res = await ws.multiSearch('q', {
    engines: [
      { id: 'tavily', key: 'k1' },
      { id: 'brave', key: 'k2' }
    ]
  })
  assert.equal(res.hits.length, 1)
  assert.deepEqual(res.hits[0].engines, ['tavily', 'brave'])
  assert.equal(res.hits[0].title, 'A')
  assert.equal(res.hits[0].url, 'https://e.test/a/?utm_source=x')
  assert.equal(res.hits[0].snippet, 'tavily text')
  assert.equal(res.answer, null)
  assert.ok(res.note.length > 0)
})

it('多引擎同时命中的排前面，其余按原始名次交错', async () => {
  setRoutes({
    'api.tavily.com': () => json(TAVILY_BODY),
    'api.search.brave.com': () => json(BRAVE_BODY)
  })

  const res = await ws.multiSearch('q', {
    engines: [
      { id: 'tavily', key: 'k1' },
      { id: 'brave', key: 'k2' }
    ]
  })
  assert.deepEqual(
    res.hits.map((h) => h.url),
    // shared 被两个引擎同时命中 → 排最前；名次相同时保留先插入的那份（此处 Brave 名次 0 更靠前）
    [
      'https://s.test/x/?utm_medium=z#top',
      'https://a.test/1',
      'https://b.test/1',
      'https://a.test/3'
    ]
  )
  assert.deepEqual(res.hits[0].engines, ['tavily', 'brave'])
  // 结论取第一个有回答的引擎
  assert.equal(res.answer, 'tavily answer')
  // 报告顺序与传入顺序一致
  assert.deepEqual(
    res.engines.map((e) => e.id),
    ['tavily', 'brave']
  )
  assert.equal(
    res.engines.every((e) => e.ok),
    true
  )
})

it('结果条数受 maxResults 限制', async () => {
  setRoutes({
    'api.tavily.com': () => json(TAVILY_BODY),
    'api.search.brave.com': () => json(BRAVE_BODY)
  })

  const res = await ws.multiSearch('q', {
    engines: [
      { id: 'tavily', key: 'k1' },
      { id: 'brave', key: 'k2' }
    ],
    maxResults: 3
  })
  assert.equal(res.hits.length, 3)
})

it('摘要截到 600 字', async () => {
  setRoutes({
    'api.tavily.com': () =>
      json({
        answer: null,
        results: [{ title: 'T', url: 'https://t.test/1', content: 'c'.repeat(2000) }]
      })
  })
  const res = await ws.multiSearch('q', { engines: [{ id: 'tavily', key: 'k1' }] })
  assert.equal(res.hits[0].snippet.length, 600)
})

// ---------------------------------------------------------------------------
// 容错：单引擎失败 / 超时 / 未知引擎
// ---------------------------------------------------------------------------

it('单个引擎失败不影响其它引擎，错误带状态码与前 200 字', async () => {
  const boom = 'E'.repeat(500)
  setRoutes({
    'api.tavily.com': () => new Response(boom, { status: 403 }),
    'api.search.brave.com': () => json(BRAVE_BODY)
  })

  const res = await ws.multiSearch('q', {
    engines: [
      { id: 'tavily', key: 'k1' },
      { id: 'brave', key: 'k2' }
    ]
  })
  const tavily = res.engines.find((e) => e.id === 'tavily')
  const brave = res.engines.find((e) => e.id === 'brave')
  assert.equal(tavily?.ok, false)
  assert.match(tavily?.error ?? '', /tavily: HTTP 403/)
  assert.ok(tavily?.error?.includes('E'.repeat(200)), 'first 200 chars are kept')
  assert.equal(tavily?.error?.includes('E'.repeat(201)), false, 'the rest is dropped')
  assert.equal(brave?.ok, true)
  assert.equal(res.hits.length, 2)
  assert.ok(res.hits.every((h) => h.engines.includes('brave')))
})

it('引擎超时报 timeout，其它引擎照常返回', async () => {
  setRoutes({
    // 一直挂着，直到信号被中止
    'api.tavily.com': (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(init.signal?.reason ?? new Error('aborted'))
        )
      }),
    'api.search.brave.com': () => json(BRAVE_BODY)
  })

  const res = await ws.multiSearch('q', {
    engines: [
      { id: 'tavily', key: 'k1' },
      { id: 'brave', key: 'k2' }
    ],
    timeoutMs: 1000
  })
  const tavily = res.engines.find((e) => e.id === 'tavily')
  assert.equal(tavily?.ok, false)
  assert.equal(tavily?.error, 'timeout after 1000ms')
  assert.equal(res.hits.length, 2)
})

it('未知引擎 id 与缺失凭据都是单引擎失败', async () => {
  setRoutes({ 'api.search.brave.com': () => json(BRAVE_BODY) })
  const res = await ws.multiSearch('q', {
    engines: [{ id: 'nope' }, { id: 'brave', key: 'k2' }, { id: 'tavily' }]
  })
  assert.equal(res.engines.find((e) => e.id === 'nope')?.ok, false)
  assert.match(res.engines.find((e) => e.id === 'nope')?.error ?? '', /unknown engine/)
  assert.equal(res.engines.find((e) => e.id === 'brave')?.ok, true)
  // 没给 key → tavily 自己报缺 key，不发起请求
  assert.equal(res.engines.find((e) => e.id === 'tavily')?.ok, false)
  assert.match(res.engines.find((e) => e.id === 'tavily')?.error ?? '', /missing API key/)
})

it('调用方的 signal 中止时引擎立即失败', async () => {
  setRoutes({ 'api.search.brave.com': () => json(BRAVE_BODY) })
  const ac = new AbortController()
  ac.abort()
  const res = await ws.multiSearch('q', {
    engines: [{ id: 'brave', key: 'k2' }],
    signal: ac.signal
  })
  assert.equal(res.engines[0].ok, false)
})

// ---------------------------------------------------------------------------
// 回答型引擎归一
// ---------------------------------------------------------------------------

it('Tavily 请求体带 key 与 include_answer', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  ws.__setHttpFetchForTest(async (url, init) => {
    seen = { url, init }
    return json({ answer: 'A', results: [] })
  })
  await ws.multiSearch('hello', {
    engines: [{ id: 'tavily', key: 'tvly-1' }],
    maxResults: 7
  })
  const s = seen as unknown as { url: string; init: RequestInit }
  assert.equal(s.url, 'https://api.tavily.com/search')
  assert.equal((s.init.headers as Record<string, string>).Authorization, 'Bearer tvly-1')
  assert.equal(JSON.parse(String(s.init.body)).max_results, 7)
  assert.equal(JSON.parse(String(s.init.body)).include_answer, true)
})

it('Grok 的回答与引用归一成 answer + citations', async () => {
  setRoutes({
    'api.x.ai': () =>
      json({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'grok says hi' }] },
          { type: 'web_search_call' }
        ],
        citations: ['https://one.test/a', 'https://two.test/b']
      })
  })
  const res = await ws.multiSearch('q', { engines: [{ id: 'grok', key: 'xai-1' }] })
  assert.equal(res.answer, 'grok says hi')
  assert.deepEqual(res.citations, [
    { title: 'one.test', url: 'https://one.test/a' },
    { title: 'two.test', url: 'https://two.test/b' }
  ])
  assert.equal(res.hits.length, 0)
})

it('answer 取第一个有回答的引擎', async () => {
  setRoutes({
    'api.tavily.com': () => json({ answer: 'first', results: [] }),
    'api.x.ai': () =>
      json({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'second' }] }],
        citations: ['https://c.test/c']
      })
  })
  const res = await ws.multiSearch('q', {
    engines: [
      { id: 'tavily', key: 'k1' },
      { id: 'grok', key: 'k2' }
    ]
  })
  assert.equal(res.answer, 'first')
  assert.equal(res.citations, undefined)
})

it('SearXNG / Google 按配置拼 URL', async () => {
  const seen: string[] = []
  ws.__setHttpFetchForTest(async (url) => {
    seen.push(String(url))
    return json({ results: [] })
  })
  await ws.multiSearch('q1', { engines: [{ id: 'searxng', baseUrl: 'https://searx.test/' }] })
  await ws.multiSearch('q2', {
    engines: [{ id: 'google', key: 'gkey', extra: { cx: 'cx-1' } }],
    maxResults: 9
  })
  assert.match(seen[0], /^https:\/\/searx\.test\/search\?/)
  assert.match(seen[0], /format=json/)
  assert.match(seen[0], /q=q1/)
  assert.match(seen[1], /customsearch\/v1\?/)
  assert.match(seen[1], /key=gkey/)
  assert.match(seen[1], /cx=cx-1/)
  assert.match(seen[1], /num=9/)
})

it('Bing 用 Ocp-Apim-Subscription-Key，字段是 name / snippet', async () => {
  let seen: { url: string; init: RequestInit } | null = null
  ws.__setHttpFetchForTest(async (url, init) => {
    seen = { url, init }
    return json({
      webPages: { value: [{ name: 'T', url: 'https://b.test/1', snippet: 'bing snippet' }] }
    })
  })
  const res = await ws.multiSearch('q', { engines: [{ id: 'bing', key: 'bk' }] })
  const s = seen as unknown as { url: string; init: RequestInit }
  assert.equal((s.init.headers as Record<string, string>)['Ocp-Apim-Subscription-Key'], 'bk')
  assert.match(s.url, /api\.bing\.microsoft\.com\/v7\.0\/search\?.*responseFilter=Webpages/)
  assert.deepEqual(res.hits, [
    { title: 'T', url: 'https://b.test/1', snippet: 'bing snippet', engines: ['bing'] }
  ])
})
