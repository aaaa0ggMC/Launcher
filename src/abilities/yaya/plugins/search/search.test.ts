/**
 * search 插件（GenericSearch 网页搜索）的单测。
 *
 * 隔离：HOME / XDG_CONFIG_HOME 在 import 任何项目模块之前指向 /tmp 下的临时目录，
 * 配置文件只写在那里，绝不碰真实 ~/.config/LinuxCockpit。
 * 全程不联网：引擎请求经框架模块的测试钩子 `__setHttpFetchForTest` 换成假 fetch。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, beforeEach, it } from 'node:test'
import type { ToolRunContext, YayaPlugin } from '../../services/plugins/types'
import type { YayaConfig } from '../../types'

process.env.HOME = mkdtempSync('/tmp/yaya-search-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

if (!process.env.HOME.startsWith('/tmp/')) {
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')
}
if (!process.env.XDG_CONFIG_HOME.startsWith('/tmp/')) {
  throw new Error('拒绝运行：XDG_CONFIG_HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')
}

let plugin: typeof import('./index').default
let config: typeof import('../../services/config')
let registry: typeof import('../../services/plugins/registry')
let webSearch: typeof import('../../../../main/process/web-search')

before(async () => {
  plugin = (await import('./index')).default
  config = await import('../../services/config')
  registry = await import('../../services/plugins/registry')
  webSearch = await import('../../../../main/process/web-search')
})

beforeEach(() => {
  registry.__resetPluginsForTest()
  registry.registerPlugin(plugin as YayaPlugin)
  registry.refreshPlugins(config.loadYayaConfig())
})

/** 写一份配置（进程内有缓存） */
function writeConfig(patch: Partial<YayaConfig>): YayaConfig {
  config.saveYayaConfig({ ...config.loadYayaConfig(), ...patch } as YayaConfig)
  return config.loadYayaConfig()
}

function writePluginConfig(values: Record<string, unknown>): YayaConfig {
  return writeConfig({ pluginConfig: { search: values } })
}

/** 经注册表跑一次工具：ctx.config 由宿主机按当前配置填好（secret 已解密） */
async function run(name: string, args: Record<string, unknown>): Promise<{ value: unknown }> {
  const resolved = (await registry.resolveTools(config.loadYayaConfig())).find(
    (t) => t.tool.name === name
  )
  assert.ok(resolved, `tool not resolved: ${name}`)
  const ctx: Omit<ToolRunContext, 'pluginId' | 'config'> = {
    sessionId: 'test',
    signal: new AbortController().signal
  }
  return { value: await registry.runPluginTool(resolved, args, ctx) }
}

interface Structured {
  content?: { type: string; text: string }[]
  isError?: boolean
}

function isError(value: unknown): boolean {
  return (value as Structured | undefined)?.isError === true
}

function textOf(value: unknown): string {
  const parts = (value as Structured | undefined)?.content
  return parts ? parts.map((p) => p.text).join('\n') : JSON.stringify(value)
}

/** 假 fetch：按 URL 分发的 tavily / brave 响应 */
function fakeFetch(handler: (url: string, init: RequestInit) => Response): {
  urls: string[]
  headers: Record<string, string>[]
} {
  const urls: string[] = []
  const headers: Record<string, string>[] = []
  webSearch.__setHttpFetchForTest(async (url, init) => {
    urls.push(String(url))
    headers.push((init.headers ?? {}) as Record<string, string>)
    return handler(String(url), init)
  })
  return { urls, headers }
}

// ---------------------------------------------------------------------------
// 元数据与工具定义稳定性
// ---------------------------------------------------------------------------

it('默认配置下没有任何可用引擎：结构化失败并指向设置页', async () => {
  const { value } = await run('search', { query: '陈粒' })
  assert.ok(isError(value), 'must fail')
  assert.match(textOf(value), /设置/)
  assert.match(textOf(value), /网页搜索/)
})

it('query 为空也是结构化失败', async () => {
  const { value } = await run('search', { query: '   ' })
  assert.ok(isError(value))
  assert.match(textOf(value), /query/)
})

it('工具定义与配置无关（提示词缓存）', async () => {
  const snapshot = (): string =>
    JSON.stringify(
      plugin.tools().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        approval: t.approval ?? 'auto',
        docs: t.docs ?? null,
        group: t.group ?? null
      }))
    )
  const empty = snapshot()
  assert.equal(empty.length > 0, true)

  writePluginConfig({ mode: 'multi', engines: 'brave,bing', engine: 'grok', max_results: 9 })
  registry.refreshPlugins(config.loadYayaConfig())
  assert.equal(snapshot(), empty, 'tool table must not depend on config')

  writePluginConfig({ mode: 'single', engine: 'tavily', max_results: 1 })
  registry.refreshPlugins(config.loadYayaConfig())
  assert.equal(snapshot(), empty)

  // 对模型暴露的名字固定是 web_search（namespace = web）
  assert.equal(registry.wireName(plugin as YayaPlugin, { name: 'search' }), 'web_search')
})

it('每个引擎一个子分组，只组织设置页；未配置时报「未配置密钥」', () => {
  const groups = (plugin as YayaPlugin).groups?.() ?? []
  assert.deepEqual(groups.map((g) => g.id).sort(), [
    'engine-bing',
    'engine-brave',
    'engine-google',
    'engine-grok',
    'engine-searxng',
    'engine-tavily'
  ])
  // 默认什么都没配 → 全部分组 idle
  assert.ok(groups.every((g) => g.status?.().state === 'idle'))
  assert.match(groups[0]?.status?.().message ?? '', /未配置密钥/)
  // 工具不挂任何分组 → 分组状态不影响它是否提供
  assert.equal(
    plugin.tools().every((t) => !t.group),
    true
  )
})

// ---------------------------------------------------------------------------
// 运行：单引擎 / 多引擎（假 fetch，不联网）
// ---------------------------------------------------------------------------

it('配好 Tavily 时正常返回紧凑文本与界面结构', async () => {
  writePluginConfig({ tavily_key: 'tvly-x', mode: 'single', engine: 'tavily', max_results: 2 })
  const seen = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          answer: '陈粒是中国独立音乐人',
          results: [{ title: '陈粒 - 远辰', url: 'https://music.test/1', content: '歌曲介绍' }]
        })
      )
  )

  const { value } = await run('search', { query: '陈粒 风格', max_results: 1 })
  assert.ok(!isError(value), textOf(value))
  const text = textOf(value)
  assert.match(text, /陈粒是中国独立音乐人/)
  assert.match(text, /\[1\] 陈粒 - 远辰 — https:\/\/music\.test\/1/)
  assert.match(text, /引擎：tavily/)
  assert.match(text, /不可信信息/)

  const display = (value as { display?: Record<string, unknown> }).display
  assert.equal((display?.hits as unknown[])?.length, 1)
  assert.equal(display?.answer, '陈粒是中国独立音乐人')
  assert.equal(display?.query, '陈粒 风格')

  // 真的按 Tavily 的文档发了请求（Bearer key）
  assert.equal(seen.urls[0], 'https://api.tavily.com/search')
  assert.equal(seen.headers[0].Authorization, 'Bearer tvly-x')
  webSearch.__setHttpFetchForTest(null)
})

it('多引擎模式按配置并发调用，单引擎失败不影响整体', async () => {
  writePluginConfig({
    mode: 'multi',
    engines: 'tavily,brave',
    tavily_key: 'tvly-x',
    brave_key: 'brave-x'
  })
  const seen = fakeFetch((url) => {
    if (url.includes('api.tavily.com'))
      return new Response(JSON.stringify({ answer: null, results: [] }), { status: 500 })
    return new Response(
      JSON.stringify({
        web: { results: [{ title: 'B', url: 'https://b.test/1', description: 'brave hit' }] }
      })
    )
  })

  const { value } = await run('search', { query: 'q' })
  assert.ok(!isError(value), textOf(value))
  const display = (value as { display?: Record<string, unknown> }).display
  const engines = display?.engines as { id: string; ok: boolean }[]
  assert.deepEqual(
    engines.map((e) => `${e.id}:${e.ok}`),
    ['tavily:false', 'brave:true']
  )
  assert.equal((display?.hits as unknown[])?.length, 1)
  assert.match(textOf(value), /未返回结果的引擎：tavily/)
  assert.equal(seen.urls.length, 2)
  webSearch.__setHttpFetchForTest(null)
})

it('mode=single 时忽略 engines 列表，只用 engine', async () => {
  writePluginConfig({
    mode: 'single',
    engine: 'brave',
    engines: 'tavily,grok',
    brave_key: 'brave-x'
  })
  const seen = fakeFetch(
    () =>
      new Response(
        JSON.stringify({
          web: { results: [{ title: 'B', url: 'https://b.test/2', description: 'x' }] }
        })
      )
  )
  const { value } = await run('search', { query: 'q' })
  assert.ok(!isError(value), textOf(value))
  assert.equal(seen.urls.length, 1)
  assert.match(seen.urls[0], /api\.search\.brave\.com/)
  webSearch.__setHttpFetchForTest(null)
})
