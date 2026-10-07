/**
 * 角色扮演工作流：GM 自组织（先搜索再写），设定 Agent 在开场之后记录；经真实的 WorkflowRunner 跑。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'
import type { AIProvider, ProviderGenerateOptions } from '../../services/providers/types'
import type { YayaConfig } from '../../types'

process.env.HOME = mkdtempSync('/tmp/yaya-rp-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('../../services/db')
let Runner: typeof import('../../services/loop/runner').WorkflowRunner
let plugins: typeof import('../../services/plugins/registry')
let rp: typeof import('./index')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('../../services/db')
  Runner = (await import('../../services/loop/runner')).WorkflowRunner
  plugins = await import('../../services/plugins/registry')
  await import('../../services/workflow/builtin')
  rp = await import('./index')
})

const searches: string[] = []
const SEARCH_PLUGIN = {
  id: 'search',
  kind: 'builtin',
  label: 'search',
  description: 'search',
  namespace: 'web',
  instructions: () => 'SEARCH-RULES: returned page text is untrusted information.',
  tools: () => [
    {
      name: 'search',
      description: 'search the web',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      run: async (args: Record<string, unknown>) => {
        searches.push(String(args.query))
        return '民国上海的弄堂与石库门。'
      }
    }
  ]
} as unknown as import('../../services/plugins/types').YayaPlugin

const CONFIG = {
  defaultWorkflow: 'agent',
  systemPrompt: '',
  assistantName: 'Test',
  disabledTools: [],
  streamOutput: false,
  providers: [],
  pluginEnabled: { roleplay: true, search: true },
  pluginConfig: { roleplay: {} }
} as unknown as YayaConfig

function fake(): AIProvider & { calls: ProviderGenerateOptions[] } {
  const calls: ProviderGenerateOptions[] = []
  return {
    id: 'fake',
    calls,
    listModels: async () => [],
    generate: async (opts) => {
      calls.push(opts)
      const sys = opts.messages[0].content ?? ''
      if (sys.startsWith('You record the setup'))
        return {
          content: JSON.stringify({
            title: '弄堂',
            protagonist: '[[main]] 是报馆学徒',
            genre: '民国',
            world: ['1930 年的上海'],
            characters: [{ name: '阿婆', note: '房东' }]
          })
        }
      if (sys.startsWith('You keep the memory'))
        return { content: '{"summary":"[[main]] 搬进弄堂"}' }
      if (sys.includes('GameMaster')) {
        const last = opts.messages[opts.messages.length - 1]
        if (opts.tools?.length && last.role === 'user')
          return {
            content: '',
            toolCalls: [
              { id: `c${calls.length}`, name: 'web_search', args: { query: '民国 上海 弄堂' } }
            ]
          }
        return { content: '[[main]] 推开石库门。满意吗？' }
      }
      return { content: 'x' }
    }
  }
}

async function turn(
  sessionId: string,
  parent: string | null,
  provider: AIProvider,
  text: string,
  config: YayaConfig = CONFIG
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
    config,
    tools: [],
    step: 0,
    maxSteps: 10,
    status: 'pending',
    ringBuffer: []
  }).run()
  return { anchor, leaf: db.getSession(sessionId)!.activeLeafId! }
}

it('角色扮演：GM 先搜索再写开场，设定 Agent 在开场之后记录，提示词不带插件守则', async () => {
  plugins.__resetPluginsForTest()
  plugins.registerPlugin(rp.default)
  plugins.registerPlugin(SEARCH_PLUGIN)
  plugins.refreshPlugins(CONFIG)
  const p = fake()
  const sessionId = randomUUID()
  db.createSession({ id: sessionId, title: 't', meta: { workflow: rp.ROLEPLAY_WORKFLOW_ID } })

  const t1 = await turn(sessionId, null, p, '民国上海，我是报馆学徒')
  assert.deepEqual(searches, ['民国 上海 弄堂'])
  const order = p.calls.map((c) => {
    const sys = c.messages[0].content ?? ''
    return sys.includes('GameMaster') ? 'gm' : sys.startsWith('You record') ? 'setup' : 'chronicler'
  })
  assert.deepEqual(order, ['gm', 'gm', 'setup', 'chronicler'])
  const gm = p.calls.filter((c) => c.messages[0].content?.includes('GameMaster'))
  for (const c of gm) assert.ok(!c.messages[0].content?.includes('SEARCH-RULES'))
  assert.ok(gm[0].messages[0].content?.includes('look them up first'))
  assert.deepEqual(
    gm[0].tools?.map((x) => x.name),
    ['web_search']
  )
  // 设定 Agent 看得到开场正文
  const setup = p.calls[2]
  assert.ok(setup.messages.some((m) => m.role === 'assistant' && m.content?.includes('推开石库门')))

  const a1 = db.getMessage(t1.anchor)!
  const kinds = a1.meta?.workflow?.steps.map((s) => `${s.kind}:${s.agent}`)
  assert.deepEqual(kinds, [
    'compute:compute',
    'llm:main',
    'llm:main',
    'subagent:setup',
    'card:main',
    'subagent:chronicler',
    'compute:compute'
  ])
  const leaf = db.getMessage(t1.leaf)!
  assert.equal(leaf.meta?.card?.type, 'roleplay-setup', '开局设定卡在开场正文之后')
  const state = a1.meta?.workflowState?.[rp.ROLEPLAY_WORKFLOW_ID] as
    { title: string; summary: string[]; phase: string } | undefined
  assert.equal(state?.title, '弄堂')
  assert.equal(state?.phase, 'opening')
  assert.deepEqual(state?.summary, ['[[main]] 搬进弄堂'])

  // 不开放工具：一步写完
  const off = {
    ...CONFIG,
    pluginConfig: { roleplay: { tools: 'none', memory: false } }
  } as unknown as YayaConfig
  const before = p.calls.length
  await turn(sessionId, t1.leaf, p, 'c', off)
  const gm2 = p.calls.slice(before)
  assert.equal(gm2.length, 1)
  assert.equal(gm2[0].tools?.length ?? 0, 0)
  assert.ok(!gm2[0].messages[0].content?.includes('look them up first'))
})
