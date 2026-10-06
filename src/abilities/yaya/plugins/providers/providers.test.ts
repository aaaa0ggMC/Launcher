/**
 * providers 插件（模型服务商）的单测。
 *
 * 隔离：HOME / XDG_CONFIG_HOME 在 import 任何项目模块之前指向 /tmp 下的临时目录。
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'
import type { PluginTool, ToolRunContext } from '../../services/plugins/types'

process.env.HOME = mkdtempSync('/tmp/yaya-providers-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

if (!process.env.HOME.startsWith('/tmp/')) {
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')
}

let plugin: typeof import('./index').default
let config: typeof import('../../services/config')

before(async () => {
  plugin = (await import('./index')).default
  config = await import('../../services/config')
})

function run(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = plugin.tools().find((t) => t.name === name) as PluginTool
  assert.ok(tool, `tool not found: ${name}`)
  const ctx: ToolRunContext = {
    sessionId: 'test',
    pluginId: 'providers',
    signal: new AbortController().signal
  }
  return tool.run(args, ctx)
}

it('没有删除工具', () => {
  const names = plugin.tools().map((t) => t.name)
  assert.deepEqual(names.sort(), ['add', 'list', 'update'])
  for (const t of plugin.tools()) if (t.name !== 'list') assert.equal(t.approval, 'ask')
})

it('添加后 list 不返回密钥，只给 apiKeySet', async () => {
  const added = (await run('add', {
    name: 'Test',
    baseUrl: 'https://user:pw@api.example.com/v1/',
    apiKey: 'sk-secret-123',
    models: ['a', 'b', 'a']
  })) as { provider: { id: string; baseUrl: string; models: string[] } }
  assert.equal(added.provider.baseUrl, 'https://api.example.com/v1')
  assert.deepEqual(added.provider.models, ['a', 'b'])
  const listed = await run('list', {})
  assert.doesNotMatch(JSON.stringify(listed), /sk-secret-123/)
  assert.match(JSON.stringify(listed), /"apiKeySet":true/)
  assert.equal(
    config.loadYayaConfig().providers.find((p) => p.id === added.provider.id)?.apiKey,
    'sk-secret-123'
  )
})

it('停用而不是删除；换地址不给新密钥会清掉旧密钥', async () => {
  const cfg = config.loadYayaConfig()
  const id = cfg.providers.find((p) => p.name === 'Test')!.id
  const before = cfg.providers.length
  await run('update', { id, enabled: false })
  let p = config.loadYayaConfig().providers.find((x) => x.id === id)!
  assert.equal(p.enabled, false)
  assert.equal(p.apiKey, 'sk-secret-123')
  assert.equal(config.loadYayaConfig().providers.length, before)

  const res = (await run('update', { id, baseUrl: 'https://evil.example.org/v1' })) as {
    notes: string[]
  }
  p = config.loadYayaConfig().providers.find((x) => x.id === id)!
  assert.equal(p.apiKey, '')
  assert.equal(res.notes.length, 1)
})

it('拒绝非 http(s) 地址', async () => {
  const res = (await run('add', { name: 'x', baseUrl: 'file:///etc/passwd' })) as {
    isError?: boolean
  }
  assert.equal(res.isError, true)
})
