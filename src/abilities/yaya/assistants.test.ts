/**
 * 多助手（assistants.ts）的单测：纯函数，不读写磁盘。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { YayaConfig } from './types'
import {
  assistantConfig,
  assistantFromDefaults,
  DEFAULT_ASSISTANT_ID,
  findAssistant,
  normalizeAssistants,
  sessionAssistantId
} from './assistants'

function base(): YayaConfig {
  return {
    assistantName: 'Verity',
    activeProviderId: 'p1',
    activeModel: 'm1',
    systemPrompt: 'You are {name}.',
    autoApproveTools: false,
    maxLoopSteps: 25,
    streamOutput: true,
    providers: [],
    mcpServers: [],
    pluginEnabled: { system: false },
    disabledTools: ['web_fetch'],
    profile: { userName: 'me', assistantAvatarMode: 'model' }
  }
}

it('旧配置：从全局字段迁移出 default 助手，生效配置与以前一致', () => {
  const cfg = base()
  normalizeAssistants(cfg)
  assert.equal(cfg.assistants?.length, 1)
  assert.equal(cfg.activeAssistantId, DEFAULT_ASSISTANT_ID)
  const a = cfg.assistants![0]
  assert.equal(a.assistantName, 'Verity')
  assert.equal(a.activeModel, 'm1')
  assert.deepEqual(a.pluginEnabled, { system: false })
  const eff = assistantConfig(cfg, DEFAULT_ASSISTANT_ID)
  for (const k of ['assistantName', 'systemPrompt', 'activeModel', 'activeProviderId'] as const)
    assert.equal(eff[k], cfg[k])
  assert.deepEqual(eff.disabledTools, ['web_fetch'])
  assert.equal(eff.profile?.userName, 'me')
  assert.equal(eff.profile?.assistantAvatarMode, 'model')
})

it('新助手复制默认值，但模型留空 = 跟随默认模型；改一个助手不影响别的', () => {
  const cfg = base()
  normalizeAssistants(cfg)
  const b = assistantFromDefaults(cfg, 'b', { name: 'Coder', now: 1 })
  cfg.assistants!.push(b)
  assert.equal(b.activeModel, '')
  b.pluginEnabled = { system: true }
  b.systemPrompt = 'code'
  b.profile = { assistantNameVisible: false }
  const eb = assistantConfig(cfg, 'b')
  assert.equal(eb.assistantName, 'Coder')
  assert.equal(eb.activeModel, 'm1', '没选模型时用全局默认')
  assert.deepEqual(eb.pluginEnabled, { system: true })
  assert.equal(eb.profile?.userName, 'me', '你的名字是全局的')
  assert.equal(eb.profile?.assistantNameVisible, false)
  const ea = assistantConfig(cfg, DEFAULT_ASSISTANT_ID)
  assert.deepEqual(ea.pluginEnabled, { system: false })
  assert.equal(ea.systemPrompt, 'You are {name}.')
  b.activeModel = 'm2'
  b.activeProviderId = 'p2'
  assert.equal(assistantConfig(cfg, 'b').activeProviderId, 'p2')
})

it('校验：坏条目 / 重复 id 去掉，活动助手不存在时回落第一个', () => {
  const cfg = base()
  cfg.assistants = [
    { id: 'x', assistantName: '  ', maxLoopSteps: 999 } as never,
    { id: 'x', assistantName: 'dup' } as never,
    { id: '../evil', assistantName: 'bad' } as never,
    null as never
  ]
  cfg.activeAssistantId = 'gone'
  normalizeAssistants(cfg)
  assert.deepEqual(
    cfg.assistants!.map((a) => a.id),
    ['x']
  )
  assert.equal(cfg.assistants![0].assistantName, 'YAYA')
  assert.equal(cfg.assistants![0].maxLoopSteps, 100)
  assert.equal(cfg.activeAssistantId, 'x')
})

it('会话的助手：旧会话 = default；被删的助手退回第一个', () => {
  assert.equal(sessionAssistantId(undefined), DEFAULT_ASSISTANT_ID)
  assert.equal(sessionAssistantId({ meta: {} }), DEFAULT_ASSISTANT_ID)
  assert.equal(sessionAssistantId({ meta: { assistantId: 'b' } }), 'b')
  const cfg = base()
  normalizeAssistants(cfg)
  assert.equal(findAssistant(cfg, 'deleted')?.id, DEFAULT_ASSISTANT_ID)
})
