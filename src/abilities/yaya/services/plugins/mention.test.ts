import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'
import type { YayaConfig } from '../../types'
import type { YayaPlugin } from './types'

process.env.HOME = mkdtempSync('/tmp/yaya-mention-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let registry: typeof import('./registry')
let mention: typeof import('./mention')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  registry = await import('./registry')
  mention = await import('./mention')
})

const tool = (name: string): ReturnType<YayaPlugin['tools']>[number] => ({
  name,
  description: `${name} tool`,
  parameters: {},
  run: async () => 'ok'
})

function setup(): YayaConfig {
  registry.__resetPluginsForTest()
  registry.registerPlugin({
    id: 'alpha',
    kind: 'builtin',
    label: 'Alpha',
    description: 'always on',
    tools: () => [tool('one')]
  })
  registry.registerPlugin({
    id: 'beta',
    kind: 'builtin',
    label: 'Beta',
    description: 'off by default',
    defaultEnabled: false,
    tools: () => [tool('two'), tool('three')]
  })
  registry.registerPlugin({
    id: 'chart',
    kind: 'builtin',
    label: 'Chart',
    description: 'display only',
    tools: () => [],
    mention: () => ({ note: 'you may draw charts' })
  })
  const config = { disabledTools: [], pluginEnabled: {} } as unknown as YayaConfig
  registry.refreshPlugins(config)
  return config
}

it('候选只有插件（含全局禁用的），按工具名也能搜到所属插件', () => {
  const config = setup()
  const all = mention.mentionCandidates(config)
  assert.deepEqual(
    all.map((c) => c.ref),
    ['alpha', 'beta', 'chart']
  )
  assert.ok(all.some((c) => c.ref === 'beta' && !c.enabled && c.tools === 2))
  assert.deepEqual(
    mention.mentionCandidates(config, 'three').map((c) => c.ref),
    ['beta']
  )
})

it('点名插件：启用整个插件 + 附注；显示类插件只给附注不启用', async () => {
  setup()
  const r = await mention.resolveMentions(['beta', 'chart', 'nope'], 's1')
  assert.deepEqual(
    r.records.map((x) => x.ref),
    ['beta', 'chart']
  )
  assert.deepEqual(
    r.enable.map((x) => x.ref),
    ['beta']
  )
  assert.match(r.note, /Beta/)
  assert.match(r.note, /beta_two, beta_three/)
  assert.match(r.note, /you may draw charts/)
})

it('点名的工具追加在工具表末尾，常规工具前缀不变', async () => {
  const config = setup()
  const before = (await registry.resolveTools(config)).map((t) => t.wireName)
  assert.deepEqual(before, ['alpha_one'])
  const forced = (await registry.resolveTools(config, ['tool:beta_three', 'beta', 'alpha'])).map(
    (t) => t.wireName
  )
  assert.deepEqual(forced, ['alpha_one', 'beta_three', 'beta_two'])
})

it('旧格式 tool: 点名归到所属插件；requires 连带启用', async () => {
  const config = setup()
  registry.registerPlugin({
    id: 'guide',
    kind: 'skill',
    label: 'Guide',
    description: 'skill-like',
    tools: () => [],
    mention: () => ({ note: 'read me', requires: ['alpha'] })
  })
  registry.refreshPlugins(config)
  const r = await mention.resolveMentions(['tool:beta_three', 'beta', 'guide'], 's1')
  assert.deepEqual(
    r.records.map((x) => x.ref),
    ['beta', 'guide']
  )
  assert.deepEqual(
    r.enable.map((x) => x.ref),
    ['beta', 'alpha']
  )
})

it('会话点名列表去重并保持先后顺序', () => {
  const merged = mention.mergeSessionMentions(
    [{ ref: 'beta', label: 'Beta', kind: 'builtin' }],
    [
      { ref: 'alpha', label: 'Alpha', kind: 'builtin' },
      { ref: 'beta', label: 'Beta', kind: 'builtin' }
    ]
  )
  assert.deepEqual(
    merged.map((m) => m.ref),
    ['beta', 'alpha']
  )
})

it('点名未连接的动态插件（MCP）：先启动再列工具；连不上也记为启用并告诉模型', async () => {
  const config = setup()
  let connected = false
  registry.registerPlugin({
    id: 'mcp-demo',
    kind: 'mcp',
    label: 'Demo MCP',
    description: 'tools appear after start',
    defaultEnabled: false,
    start: async () => {
      connected = true
    },
    tools: () => (connected ? [tool('video')] : [])
  })
  registry.registerPlugin({
    id: 'mcp-down',
    kind: 'mcp',
    label: 'Down MCP',
    description: 'cannot connect',
    defaultEnabled: false,
    start: async () => {
      throw new Error('ECONNREFUSED')
    },
    tools: () => []
  })
  registry.refreshPlugins(config)
  const r = await mention.resolveMentions(['mcp-demo', 'mcp-down'], 's1')
  assert.deepEqual(
    r.enable.map((x) => x.ref),
    ['mcp-demo', 'mcp-down']
  )
  assert.match(r.note, /mcp-demo_video/)
  assert.match(r.note, /ECONNREFUSED/)
})

it('基础设施插件可退出点名候选，不改变其他插件的默认可见性', () => {
  const config = setup()
  registry.registerPlugin({
    id: 'composer',
    kind: 'builtin',
    label: 'Composer',
    description: 'input infrastructure',
    mentionable: false,
    tools: () => []
  })
  registry.refreshPlugins(config)
  assert.ok(!mention.mentionCandidates(config).some((item) => item.ref === 'composer'))
  assert.ok(mention.mentionCandidates(config).some((item) => item.ref === 'chart'))
})
