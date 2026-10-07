/**
 * 故事模式工作流：用假的模型按系统提示词分辨各层 Agent，经真实的 WorkflowRunner 跑两轮。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'
import type { AIProvider, ProviderGenerateOptions } from '../../services/providers/types'
import type { YayaConfig } from '../../types'

process.env.HOME = mkdtempSync('/tmp/yaya-story-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('../../services/db')
let Runner: typeof import('../../services/loop/runner').WorkflowRunner
let plugins: typeof import('../../services/plugins/registry')
let story: typeof import('./index')
let cmd: typeof import('./commands')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('../../services/db')
  Runner = (await import('../../services/loop/runner')).WorkflowRunner
  plugins = await import('../../services/plugins/registry')
  await import('../../services/workflow/builtin')
  story = await import('./index')
  cmd = await import('./commands')
})

const ARCH = JSON.stringify({
  title: '雾港',
  genre: '悬疑',
  premise: '船长死在了起雾的夜里。',
  location: '码头',
  world: ['港口终年起雾'],
  characters: [
    { name: '你', role: 'protagonist', traits: '好奇' },
    { name: '老周', role: 'ally', goal: '保住渔船', secret: '他欠船长钱' }
  ],
  threads: ['谁杀了船长']
})

function fake(): AIProvider & { calls: ProviderGenerateOptions[] } {
  const calls: ProviderGenerateOptions[] = []
  return {
    id: 'fake',
    calls,
    listModels: async () => [],
    generate: async (opts) => {
      calls.push(opts)
      const sys = opts.messages.find((m) => m.role === 'system')?.content ?? ''
      let content = 'x'
      if (sys.includes('world architect')) content = '```json\n' + ARCH + '\n```'
      else if (sys.includes('plot writer'))
        content = JSON.stringify({
          scene: '码头·夜',
          goal: 'g',
          cast: ['老周'],
          beats: ['b'],
          hook: 'h'
        })
      else if (sys.startsWith('You are 老周')) content = 'INTENT: 隐瞒\nLINES: 「我什么都没看见。」'
      else if (sys.includes('## STORY MODE')) content = `你走进雾里。（第 ${calls.length} 次调用）`
      else if (sys.includes('chronicler'))
        content = JSON.stringify({
          summary: '你在码头遇见老周',
          characters: [{ name: '老周', status: '紧张' }],
          threads_add: ['老周在隐瞒什么']
        })
      return { content }
    }
  }
}

const CONFIG = {
  defaultWorkflow: 'agent',
  systemPrompt: '',
  assistantName: 'Test',
  disabledTools: [],
  streamOutput: false,
  providers: [],
  pluginEnabled: { storyteller: true },
  pluginConfig: { storyteller: { fate: true, chapter_beats: 4 } }
} as unknown as YayaConfig

async function turn(
  sessionId: string,
  parent: string | null,
  provider: AIProvider,
  text: string
): Promise<{ anchor: string; leaf: string }> {
  const user = randomUUID()
  const anchor = randomUUID()
  db.insertMessage(
    {
      id: user,
      sessionId,
      parentId: parent,
      role: 'user',
      content: text,
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
    config: CONFIG,
    tools: [],
    step: 0,
    maxSteps: 4,
    status: 'pending',
    ringBuffer: []
  }).run()
  return { anchor, leaf: db.getSession(sessionId)!.activeLeafId! }
}

it('故事模式：分层 Agent 跑两轮，卡片 + 正文进对话，档案按分支累积', async () => {
  plugins.__resetPluginsForTest()
  plugins.registerPlugin(story.default)
  plugins.refreshPlugins(CONFIG)
  const p = fake()
  const sessionId = randomUUID()
  db.createSession({ id: sessionId, title: 't', meta: { workflow: story.STORY_WORKFLOW_ID } })

  const t1 = await turn(sessionId, null, p, '我想听一个雾港的悬疑故事')
  const firstCalls = p.calls.length
  // 建筑师 + 编剧 + 角色(老周) + 旁白 + 记录员
  assert.equal(firstCalls, 5)
  const a1 = db.getMessage(t1.anchor)!
  assert.equal(a1.meta?.card?.type, 'story-state', '首节点是故事状态卡')
  assert.equal(a1.content, '', '状态卡对模型不可见')
  const data = a1.meta?.card?.data as { cast: { name: string }[]; turn: number; roll: number }
  assert.deepEqual(
    data.cast.map((c) => c.name),
    ['老周']
  )
  assert.equal(data.turn, 1)
  assert.ok(data.roll >= 1 && data.roll <= 20)
  const kinds = a1.meta?.workflow?.steps.map((s) => `${s.kind}:${s.agent}`)
  assert.deepEqual(kinds, [
    'compute:compute',
    'subagent:architect',
    'compute:compute',
    'subagent:plotter',
    'subagent:character',
    'card:main',
    'llm:main',
    'subagent:chronicler',
    'compute:compute'
  ])
  // 角色 Agent 拿到了自己的秘密，旁白没有
  const charCall = p.calls.find((c) => c.messages[0].content.startsWith('You are 老周'))!
  assert.ok(charCall.messages[0].content.includes('他欠船长钱'))
  const narr = p.calls.find((c) => c.messages[0].content.includes('## STORY MODE'))!
  assert.ok(!narr.messages[0].content.includes('他欠船长钱'))
  assert.ok(narr.messages[0].content.includes('「我什么都没看见。」'))

  const b1 = cmd.bibleOnBranch(t1.leaf)!
  assert.equal(b1.turn, 1)
  assert.equal(b1.title, '雾港')
  assert.equal(b1.characters.find((c) => c.name === '老周')?.status, '紧张')
  assert.ok(b1.threads.some((x) => x.text === '老周在隐瞒什么'))
  assert.deepEqual(b1.timeline, ['你在码头遇见老周'])

  // 第二轮：不再造世界，档案接着上一轮
  const t2 = await turn(sessionId, t1.leaf, p, '我问老周昨晚在哪')
  assert.equal(p.calls.length - firstCalls, 4)
  assert.ok(
    !p.calls.slice(firstCalls).some((c) => c.messages[0].content.includes('world architect'))
  )
  const b2 = cmd.bibleOnBranch(t2.leaf)!
  assert.equal(b2.turn, 2)
  assert.equal(b2.timeline.length, 2)
  // 第一轮的分支上档案不变
  assert.equal(cmd.bibleOnBranch(t1.leaf)!.turn, 1)

  // 插件关掉：故事模式不可选，运行回落
  const registry = await import('../../services/workflow/registry')
  const off = { ...CONFIG, pluginEnabled: {} } as unknown as YayaConfig
  assert.equal(registry.resolveWorkflow(story.STORY_WORKFLOW_ID, off).id, 'agent')
})
