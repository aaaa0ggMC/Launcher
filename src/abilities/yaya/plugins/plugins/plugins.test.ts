/**
 * plugins 插件（插件管理）的单测。
 *
 * 隔离：HOME / XDG_CONFIG_HOME 在 import 任何项目模块之前指向 /tmp 下的临时目录，
 * 配置文件只写在那里，绝不碰真实 ~/.config/LinuxCockpit。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { before, beforeEach, it } from 'node:test'
import type { PluginTool, ToolRunContext } from '../../services/plugins/types'

process.env.HOME = mkdtempSync('/tmp/yaya-plugins-test-')
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

before(async () => {
  plugin = (await import('./index')).default
  config = await import('../../services/config')
  registry = await import('../../services/plugins/registry')
})

beforeEach(() => {
  registry.__resetPluginsForTest()
  registry.registerPlugin(plugin)
  registry.refreshPlugins(config.loadYayaConfig())
})

function tool(name: string): PluginTool {
  const found = plugin.tools().find((t) => t.name === name)
  assert.ok(found, `tool not found: ${name}`)
  return found
}

function run(name: string, args: Record<string, unknown>): Promise<unknown> {
  const ctx: ToolRunContext = {
    sessionId: 'test',
    pluginId: 'plugins',
    signal: new AbortController().signal
  }
  return tool(name).run(args, ctx)
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

/** 每个用例自己定义 MCP 服务器初始状态（配置在用例间共享缓存） */
function setServers(servers: unknown[]): void {
  const cfg = config.loadYayaConfig()
  cfg.mcpServers = servers as typeof cfg.mcpServers
  config.saveYayaConfig(cfg)
}

it('不允许停用插件管理插件自己', async () => {
  const result = await run('set_plugin_enabled', { id: 'plugins', enabled: false })
  assert.ok(isError(result), 'must fail')
  assert.match(textOf(result), /插件管理/)
  assert.equal(config.loadYayaConfig().pluginEnabled?.plugins, undefined)
})

it('不允许停用插件管理插件自己的工具', async () => {
  const wireName = registry.wireName(plugin, { name: 'mcp_add' })
  const result = await run('set_tool_enabled', { wireName, enabled: false })
  assert.ok(isError(result), 'must fail')
  assert.match(textOf(result), /插件管理/)
  assert.equal((config.loadYayaConfig().disabledTools ?? []).includes(wireName), false)
})

it('mcp_list 只给请求头名，绝不泄露请求头的值', async () => {
  setServers([
    {
      id: 'demo',
      name: 'Demo',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer sup3r-secret-value' },
      enabled: true
    }
  ])

  const result = (await run('mcp_list', {})) as { servers: { id: string; headersSet: string[] }[] }
  assert.equal(result.servers.length, 1)
  assert.equal(result.servers[0].id, 'demo')
  assert.deepEqual(result.servers[0].headersSet, ['Authorization'])
  assert.ok(
    !JSON.stringify(result).includes('sup3r-secret-value'),
    'header value must not be returned'
  )
})

it('mcp_add 拒绝非 http(s) 地址', async () => {
  setServers([])
  const result = await run('mcp_add', { name: 'evil', url: 'file:///etc/passwd' })
  assert.ok(isError(result), 'must fail')
  assert.match(textOf(result), /http/)
  assert.equal((config.loadYayaConfig().mcpServers ?? []).length, 0)
})

it('mcp_add 接受 https 地址并落盘（加密后再读回仍只有头名）', async () => {
  setServers([])
  const result = (await run('mcp_add', {
    name: 'My Server',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer abc123' }
  })) as { ok: boolean; server: { id: string; headersSet: string[] } }
  assert.equal(result.ok, true)
  assert.equal(result.server.id, 'my-server')
  assert.deepEqual(result.server.headersSet, ['Authorization'])
  assert.ok(!JSON.stringify(result).includes('abc123'), 'header value must not be returned')

  // 落盘的是密文；读回来后 mcp_list 也只给头名
  const saved = JSON.parse(readFileSync(config.getYayaConfigPath(), 'utf8')) as {
    mcpServers: { headers: Record<string, string> }[]
  }
  assert.match(saved.mcpServers[0].headers.Authorization, /^enc:v2:/)

  const listed = (await run('mcp_list', {})) as {
    servers: { id: string; url: string; headersSet: string[] }[]
  }
  assert.equal(listed.servers.length, 1)
  assert.equal(listed.servers[0].url, 'https://mcp.example.com/mcp')
  assert.ok(!JSON.stringify(listed).includes('abc123'))
})

it('context_info 在没有宿主上下文时返回 available: false', async () => {
  assert.deepEqual(await run('context_info', {}), { available: false })
})

it('启用开关只改本次对话的助手，别的助手和默认值不变', async () => {
  const db = await import('../../services/db')
  const { assistantFromDefaults } = await import('../../assistants')
  const cfg = config.loadYayaConfig()
  cfg.assistants = [...(cfg.assistants ?? []), assistantFromDefaults(cfg, 'coder')]
  config.saveYayaConfig(cfg)
  db.createSession({ id: 'coder-chat', title: 'x', meta: { assistantId: 'coder' } })
  const ctx: ToolRunContext = {
    sessionId: 'coder-chat',
    pluginId: 'plugins',
    signal: new AbortController().signal
  }
  registry.registerPlugin({ ...plugin, id: 'demo-p', label: 'Demo', tools: () => [] })
  registry.refreshPlugins(config.loadYayaConfig())
  const ok = await tool('set_plugin_enabled').run({ id: 'demo-p', enabled: false }, ctx)
  assert.ok(!isError(ok), textOf(ok))
  const saved = config.loadYayaConfig()
  assert.equal(saved.assistants?.find((a) => a.id === 'coder')?.pluginEnabled?.['demo-p'], false)
  assert.equal(
    saved.assistants?.find((a) => a.id === 'default')?.pluginEnabled?.['demo-p'],
    undefined
  )
  assert.equal(saved.pluginEnabled?.['demo-p'], undefined)
})
