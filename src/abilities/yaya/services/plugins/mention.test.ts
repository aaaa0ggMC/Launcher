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

it('候选包含全局禁用的插件与工具，可按名字过滤', () => {
  const config = setup()
  const all = mention.mentionCandidates(config)
  assert.ok(all.some((c) => c.ref === 'beta' && !c.enabled))
  assert.ok(all.some((c) => c.ref === 'tool:beta_two' && c.plugin === 'Beta'))
  assert.deepEqual(
    mention.mentionCandidates(config, 'three').map((c) => c.ref),
    ['tool:beta_three']
  )
})

it('点名插件：启用整个插件 + 附注；显示类插件只给附注不启用', async () => {
  setup()
  const r = await mention.resolveMentions(['beta', 'chart', 'nope'], 's1')
  assert.deepEqual(
    r.records.map((x) => x.ref),
    ['beta', 'chart']
  )
  assert.deepEqual(r.enable, ['beta'])
  assert.match(r.note, /Beta/)
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

it('会话点名列表去重并保持先后顺序', () => {
  const recs = [
    { ref: 'beta', label: 'Beta', kind: 'builtin' as const },
    { ref: 'tool:alpha_one', label: 'alpha_one', kind: 'tool' as const }
  ]
  const merged = mention.mergeSessionMentions(
    [{ ref: 'beta', label: 'Beta', kind: 'builtin' }],
    recs,
    ['tool:alpha_one', 'beta']
  )
  assert.deepEqual(
    merged.map((m) => m.ref),
    ['beta', 'tool:alpha_one']
  )
})
