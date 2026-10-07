import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'
import type { AIProvider, ProviderGenerateOptions } from '../providers/types'
import type { YayaConfig } from '../../types'

process.env.HOME = mkdtempSync('/tmp/yaya-workflows-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('../db')
let Runner: typeof import('../loop/runner').WorkflowRunner
let builtin: typeof import('./builtin')
let plugins: typeof import('../plugins/registry')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('../db')
  Runner = (await import('../loop/runner')).WorkflowRunner
  plugins = await import('../plugins/registry')
  builtin = await import('./builtin')
})

/** 按系统提示词区分调用：子 Agent / 主 Agent 各自给不同回答 */
function fakeProvider(
  reply: (system: string, opts: ProviderGenerateOptions) => string
): AIProvider & { calls: ProviderGenerateOptions[] } {
  const calls: ProviderGenerateOptions[] = []
  return {
    id: 'fake',
    calls,
    listModels: async () => [],
    generate: async (opts) => {
      calls.push(opts)
      const system = opts.messages.find((m) => m.role === 'system')?.content ?? ''
      return { content: reply(system, opts) }
    }
  }
}

async function run(workflow: string, provider: AIProvider): Promise<string[]> {
  plugins.__resetPluginsForTest()
  const sessionId = randomUUID()
  db.createSession({ id: sessionId, title: 't', meta: { workflow } })
  const user = randomUUID()
  const assistant = randomUUID()
  db.insertMessage(
    {
      id: user,
      sessionId,
      parentId: null,
      role: 'user',
      content: 'question',
      status: 'completed',
      createdAt: Date.now()
    },
    { moveLeaf: true }
  )
  db.insertMessage({
    id: assistant,
    sessionId,
    parentId: user,
    role: 'assistant',
    content: '',
    status: 'pending',
    createdAt: Date.now()
  })
  const r = new Runner({
    sessionId,
    userMessageId: user,
    assistantMessageId: assistant,
    provider,
    config: {
      defaultWorkflow: 'agent',
      systemPrompt: '',
      assistantName: 'Test',
      disabledTools: [],
      streamOutput: false,
      providers: []
    } as unknown as YayaConfig,
    tools: [],
    step: 0,
    maxSteps: 4,
    status: 'pending',
    ringBuffer: []
  })
  await r.run()
  const leaf = db.getSession(sessionId)?.activeLeafId
  return db
    .getMessageBranch(leaf)
    .filter((m) => m.role === 'assistant')
    .map((m) => m.content)
}

it('review：审阅通过只有一版回答', async () => {
  const p = fakeProvider((sys) =>
    sys.includes('You are the reviewing sub-agent') ? 'LGTM.' : 'draft'
  )
  assert.deepEqual(await run('review', p), ['draft'])
  assert.equal(p.calls.length, 2)
})

it('review：有问题时按意见不带工具重写', async () => {
  const p = fakeProvider((sys) => {
    if (sys.includes('You are the reviewing sub-agent')) return '- wrong number'
    return sys.includes('wrong number') ? 'fixed' : 'draft'
  })
  assert.deepEqual(await run('review', p), ['draft', 'fixed'])
  assert.equal(p.calls.length, 3)
  assert.equal(p.calls[2].tools?.length ?? 0, 0)
})

it('perspectives：三个子 Agent 并行，主 Agent 拿到全部视角', async () => {
  const p = fakeProvider((sys) => {
    for (const v of builtin.PERSPECTIVES) if (sys === v.system) return `${v.agent} says`
    return 'synth'
  })
  assert.deepEqual(await run('perspectives', p), ['synth'])
  assert.equal(p.calls.length, 4)
  const main = p.calls[3].messages[0].content
  for (const v of builtin.PERSPECTIVES) assert.ok(main.includes(`${v.agent} says`))
})

it('reviewPassed 容忍标点与代码块', () => {
  assert.ok(builtin.reviewPassed('`LGTM`'))
  assert.ok(builtin.reviewPassed('lgtm。'))
  assert.ok(!builtin.reviewPassed('LGTM but fix X'))
})

// ---------------------------------------------------------------------------
// 插件注入的工作流：可用性 / 回落 / 计算节点 / 数据卡片 / 按分支的状态
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  defaultWorkflow: 'agent',
  systemPrompt: '',
  assistantName: 'Test',
  disabledTools: [],
  streamOutput: false,
  providers: []
} as unknown as YayaConfig

function registerCounterPlugin(): void {
  plugins.__resetPluginsForTest()
  plugins.registerPlugin({
    id: 'counter',
    kind: 'builtin',
    label: 'Counter',
    description: 'test',
    defaultEnabled: false,
    tools: () => [],
    workflows: () => [
      {
        id: 'counter.count',
        labelKey: 'x',
        label: 'Count',
        descriptionKey: 'x',
        description: 'counts turns',
        usesTools: false,
        async run(ctx) {
          const prev = ctx.loadState<{ n: number }>()
          const n = await ctx.compute('next', () => (prev?.n ?? 0) + 1)
          ctx.addCard({ type: 'count', title: `turn ${n}`, data: { n }, modelText: `count=${n}` })
          await ctx.assistantStep({ tools: 'none', extraSystem: `COUNT ${n}` })
          ctx.saveState({ n })
        }
      }
    ]
  })
}

/** 在 parent 下面跑一轮；返回 [session, 本轮首节点 id, 叶子] */
async function runTurn(
  sessionId: string,
  parent: string | null,
  provider: AIProvider,
  config: YayaConfig
): Promise<{ anchor: string; leaf: string }> {
  const user = randomUUID()
  const anchor = randomUUID()
  db.insertMessage(
    {
      id: user,
      sessionId,
      parentId: parent,
      role: 'user',
      content: 'next',
      status: 'completed',
      createdAt: Date.now()
    },
    { moveLeaf: true }
  )
  db.insertMessage({
    id: anchor,
    sessionId,
    parentId: user,
    role: 'assistant',
    content: '',
    status: 'pending',
    createdAt: Date.now()
  })
  await new Runner({
    sessionId,
    userMessageId: user,
    assistantMessageId: anchor,
    provider,
    config,
    tools: [],
    step: 0,
    maxSteps: 4,
    status: 'pending',
    ringBuffer: []
  }).run()
  return { anchor, leaf: db.getSession(sessionId)!.activeLeafId! }
}

it('插件工作流：只在插件启用时可选；不可用时回落助手默认 → 全局默认', async () => {
  registerCounterPlugin()
  const registry = await import('./registry')
  plugins.refreshPlugins(BASE_CONFIG)
  assert.ok(!registry.listWorkflowInfo(BASE_CONFIG).some((w) => w.id === 'counter.count'))
  const on = { ...BASE_CONFIG, pluginEnabled: { counter: true } } as YayaConfig
  const info = registry.listWorkflowInfo(on).find((w) => w.id === 'counter.count')
  assert.equal(info?.pluginId, 'counter')
  assert.equal(info?.pluginLabel, 'Counter')
  assert.equal(registry.resolveWorkflow('counter.count', on).id, 'counter.count')
  // 插件关着：助手默认（同样不可用）→ 全局默认 chat
  const off = { ...BASE_CONFIG, defaultWorkflow: 'counter.count' } as YayaConfig
  assert.equal(registry.resolveWorkflow('counter.count', off, 'chat').id, 'chat')
  assert.equal(registry.resolveWorkflow('counter.count', off).id, 'agent')
})

it('插件工作流：计算节点 + 数据卡片 + 状态跟着分支走', async () => {
  registerCounterPlugin()
  const config = { ...BASE_CONFIG, pluginEnabled: { counter: true } } as YayaConfig
  plugins.refreshPlugins(config)
  const p = fakeProvider((sys) => (sys.match(/COUNT (\d+)/)?.[0] ?? 'none').toLowerCase())
  const sessionId = randomUUID()
  db.createSession({ id: sessionId, title: 't', meta: { workflow: 'counter.count' } })

  const t1 = await runTurn(sessionId, null, p, config)
  const t2 = await runTurn(sessionId, t1.leaf, p, config)
  const branch = db.getMessageBranch(t2.leaf).filter((m) => m.role === 'assistant')
  // 每轮：卡片节点（复用首节点）+ 回答
  assert.deepEqual(
    branch.map((m) => (m.meta?.card ? `card:${m.content}` : m.content)),
    ['card:count=1', 'count 1', 'card:count=2', 'count 2']
  )
  const anchor1 = db.getMessage(t1.anchor)!
  assert.equal(anchor1.meta?.card?.type, 'count')
  assert.deepEqual(anchor1.meta?.workflowState, { 'counter.count': { n: 1 } })
  const rec = anchor1.meta?.workflow
  assert.deepEqual(
    rec?.steps.map((s) => s.kind),
    ['compute', 'card', 'llm']
  )
  assert.equal(rec?.steps[0].detail, '```json\n1\n```')
  // 卡片的 modelText 进了模型的历史
  const lastCall = p.calls[p.calls.length - 1]
  assert.ok(lastCall.messages.some((m) => m.role === 'assistant' && m.content === 'count=1'))

  // 在第一轮的用户消息下重新生成（新分支）：状态从头开始
  const user1 = anchor1.parentId!
  const regen = randomUUID()
  db.insertMessage({
    id: regen,
    sessionId,
    parentId: user1,
    role: 'assistant',
    content: '',
    status: 'pending',
    createdAt: Date.now()
  })
  await new Runner({
    sessionId,
    userMessageId: user1,
    assistantMessageId: regen,
    provider: p,
    config,
    tools: [],
    step: 0,
    maxSteps: 4,
    status: 'pending',
    ringBuffer: []
  }).run()
  assert.deepEqual(db.getMessage(regen)?.meta?.workflowState, { 'counter.count': { n: 1 } })
})
