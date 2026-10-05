/**
 * 插件配置 / 子分组的单测（PLAN 6.4）。
 *
 * 隔离：HOME / XDG_CONFIG_HOME 在 import 任何项目模块之前指向 /tmp 下的临时目录，
 * 配置文件只写在那里，绝不碰真实 ~/.config/LinuxCockpit。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { before, beforeEach, it } from 'node:test'
import type { PluginConfigField, PluginTool, ToolRunContext, YayaPlugin } from './types'
import type { YayaConfig } from '../../types'

process.env.HOME = mkdtempSync('/tmp/yaya-plugin-config-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

if (!process.env.HOME.startsWith('/tmp/')) {
  throw new Error('拒绝运行：HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')
}
if (!process.env.XDG_CONFIG_HOME.startsWith('/tmp/')) {
  throw new Error('拒绝运行：XDG_CONFIG_HOME 必须是 /tmp 下的临时目录，避免改写真实用户配置')
}

let config: typeof import('../config')
let registry: typeof import('./registry')

before(async () => {
  config = await import('../config')
  registry = await import('./registry')
})

beforeEach(() => {
  registry.__resetPluginsForTest()
})

const SCHEMA: PluginConfigField[] = [
  {
    key: 'engine',
    type: 'select',
    label: 'Engine',
    default: 'tavily',
    options: [
      { value: 'tavily', label: 'Tavily' },
      { value: 'brave', label: 'Brave' }
    ]
  },
  { key: 'limit', type: 'number', label: 'Limit', default: 10, min: 1, max: 50 },
  { key: 'verbose', type: 'boolean', label: 'Verbose', default: false },
  { key: 'api_key', type: 'string', label: 'API key', secret: true }
]

interface Harness {
  tools: PluginTool[]
  /** 改 shizuku 分组的状态（ready ↔ error） */
  setShizukuState: (state: 'ready' | 'error') => void
  /** 工具运行时报上来的 ctx.config */
  seen: Array<Record<string, unknown> | undefined>
}

/** 注册一个带配置 schema 与两个分组的演示插件，并刷新插件表 */
function registerPlugin(): Harness {
  const seen: Array<Record<string, unknown> | undefined> = []
  let shizukuState: 'ready' | 'error' = 'ready'
  const tools: PluginTool[] = [
    {
      name: 'plain_tool',
      description: 'no group',
      parameters: { type: 'object', properties: {} },
      run: async (_args, ctx) => {
        seen.push(ctx.config)
        return 'ok'
      }
    },
    {
      name: 'group_tool',
      description: 'in group',
      parameters: { type: 'object', properties: {} },
      group: 'shizuku',
      run: async () => 'group'
    }
  ]
  const plugin: YayaPlugin = {
    id: 'demo',
    kind: 'builtin',
    label: 'Demo',
    description: '',
    configSchema: SCHEMA,
    groups: () => [
      {
        id: 'shizuku',
        label: 'Shizuku',
        description: 'adb',
        defaultEnabled: true,
        status: () => ({ state: shizukuState })
      },
      { id: 'termux', label: 'Termux:API', defaultEnabled: false }
    ],
    tools: () => tools
  }
  registry.registerPlugin(plugin)
  registry.refreshPlugins(config.loadYayaConfig())
  return { tools, seen, setShizukuState: (s) => (shizukuState = s) }
}

/** 写一份配置（进程内有缓存，每个用例自己初始化） */
function writeConfig(patch: Partial<YayaConfig>): YayaConfig {
  config.saveYayaConfig({ ...config.loadYayaConfig(), ...patch } as YayaConfig)
  return config.loadYayaConfig()
}

function diskConfig(): YayaConfig & { pluginConfig?: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(config.getYayaConfigPath(), 'utf8'))
}

it('默认值填充与数字夹取', () => {
  registerPlugin()
  writeConfig({ pluginConfig: { demo: { limit: 999, verbose: 'true', engine: 'nope' } } })
  const info = registry.listPluginInfo(config.loadYayaConfig()).find((p) => p.id === 'demo')!
  assert.equal(info.config?.values.limit, 50)
  assert.equal(info.config?.values.verbose, true)
  assert.equal(info.config?.values.engine, 'tavily')
  assert.deepEqual(info.config?.secretsSet, [])

  // 没写进配置的字段用默认值
  writeConfig({ pluginConfig: undefined })
  const fresh = registry.listPluginInfo(config.loadYayaConfig()).find((p) => p.id === 'demo')!
  assert.deepEqual(fresh.config?.values, { engine: 'tavily', limit: 10, verbose: false })
})

it('secret 加密落盘、读回解密、publicYayaConfig 只给 pluginSecretsSet', () => {
  registerPlugin()
  writeConfig({ pluginConfig: { demo: { api_key: 'sk-live-123', limit: 5 } } })

  // 内存里是明文（工具要读）
  const inMemory = config.loadYayaConfig()
  assert.equal(inMemory.pluginConfig?.demo?.api_key, 'sk-live-123')

  // 落盘的是密文
  const saved = diskConfig()
  assert.match(String(saved.pluginConfig?.demo?.api_key), /^enc:v2:/)
  assert.equal(saved.pluginConfig?.demo?.limit, 5)
  assert.ok(!JSON.stringify(saved).includes('sk-live-123'), 'plaintext must not hit disk')

  // 下发视图：没有值，只有「已设置」
  const pub = config.publicYayaConfig(inMemory)
  assert.ok(!('api_key' in (pub.pluginConfig?.demo ?? {})), 'secret value must be stripped')
  assert.deepEqual(pub.pluginSecretsSet?.demo, ['api_key'])
  assert.equal(pub.pluginConfig?.demo?.limit, 5)
})

it('secret 空串沿用旧值；pluginClearSecrets 删除；未知插件原样保留', () => {
  registerPlugin()
  writeConfig({ pluginConfig: { demo: { api_key: 'sk-keep', limit: 7 } } })

  const base = (patch: Partial<YayaConfig>): YayaConfig =>
    ({ ...config.loadYayaConfig(), ...patch }) as YayaConfig

  // secret 传空串 = 不修改，非 secret 照常覆盖
  const keep = config.mergeIncomingYayaConfig(
    base({ pluginConfig: { demo: { api_key: '', limit: 9 } } })
  )
  assert.equal(keep.pluginConfig?.demo?.api_key, 'sk-keep')
  assert.equal(keep.pluginConfig?.demo?.limit, 9)

  // 显式清除
  const cleared = config.mergeIncomingYayaConfig(
    base({ pluginConfig: { demo: { api_key: '' } }, pluginClearSecrets: ['demo/api_key'] })
  )
  assert.ok(!('api_key' in (cleared.pluginConfig?.demo ?? {})))

  // 未知插件 / 未知 key 原样保留（插件可能暂时没加载）
  const merged = config.mergeIncomingYayaConfig(base({ pluginConfig: { ghost: { anything: 1 } } }))
  assert.deepEqual(merged.pluginConfig?.ghost, { anything: 1 })
  assert.equal(merged.pluginSecretsSet, undefined)
  assert.equal(merged.pluginClearSecrets, undefined)

  // 仅传输字段不落盘
  writeConfig({
    ...merged,
    pluginSecretsSet: { demo: ['api_key'] },
    pluginClearSecrets: ['demo/api_key']
  })
  const disk = diskConfig()
  assert.equal(disk.pluginSecretsSet, undefined)
  assert.equal(disk.pluginClearSecrets, undefined)
})

it('分组被关掉 / 状态非 ready 时工具不提供给模型', async () => {
  const harness = registerPlugin()
  const cfg = config.loadYayaConfig()

  assert.deepEqual((await registry.resolveTools(cfg)).map((t) => t.tool.name).sort(), [
    'group_tool',
    'plain_tool'
  ])

  harness.tools.push({
    name: 'termux_tool',
    description: 'termux',
    parameters: { type: 'object', properties: {} },
    group: 'termux',
    run: async () => 'nope'
  })
  harness.tools.push({
    name: 'ghost_group_tool',
    description: 'unknown group = treated as ungrouped',
    parameters: { type: 'object', properties: {} },
    group: 'ghost',
    run: async () => 'ghost'
  })

  const off = await registry.resolveTools({ ...cfg, pluginGroupEnabled: { 'demo/shizuku': false } })
  assert.ok(!off.some((t) => t.tool.name === 'group_tool'), 'disabled group must be skipped')
  assert.ok(
    off.some((t) => t.tool.name === 'ghost_group_tool'),
    'unknown group = ungrouped'
  )
  assert.ok(!off.some((t) => t.tool.name === 'termux_tool'), 'defaultEnabled:false group is off')

  // 分组状态变 error → 同样整组不提供
  harness.setShizukuState('error')
  const broken = await registry.resolveTools(cfg)
  assert.ok(!broken.some((t) => t.tool.name === 'group_tool'), 'unready group must be skipped')
})

it('runPluginTool 把当前配置放进 ctx.config', async () => {
  const harness = registerPlugin()
  writeConfig({ pluginConfig: { demo: { api_key: 'sk-ctx', limit: 123 } } })
  const resolved = (await registry.resolveTools(config.loadYayaConfig())).find(
    (t) => t.tool.name === 'plain_tool'
  )!
  const ctx: Omit<ToolRunContext, 'pluginId' | 'config'> = {
    sessionId: 'test',
    signal: new AbortController().signal
  }
  await registry.runPluginTool(resolved, {}, ctx)
  const seen = harness.seen[0]!
  assert.equal(seen.limit, 50) // 夹到 max
  assert.equal(seen.api_key, 'sk-ctx') // secret 解密后给工具
  assert.equal(seen.engine, 'tavily')
})

it('插件没加载（拿不到 schema）时，它的 secret 保存后仍是密文、也不下发给页面', () => {
  registerPlugin()
  writeConfig({ pluginConfig: { demo: { api_key: 'sk-unloaded-456' } } })
  // 插件被移除 / 构建期关掉 / MCP 还没连上：注册表里没有它的 schema
  registry.__resetPluginsForTest()
  registry.refreshPlugins(config.loadYayaConfig())
  writeConfig({ assistantName: 'Other' })
  const saved = diskConfig()
  assert.match(String(saved.pluginConfig?.demo?.api_key), /^enc:v2:/)
  assert.ok(!JSON.stringify(saved).includes('sk-unloaded-456'), 'plaintext must not hit disk')
  const pub = config.publicYayaConfig(config.loadYayaConfig())
  assert.ok(!JSON.stringify(pub).includes('sk-unloaded-456'), 'secret must not reach the page')
  assert.deepEqual(pub.pluginSecretsSet?.demo, ['api_key'])
})
