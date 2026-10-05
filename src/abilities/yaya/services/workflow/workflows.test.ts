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
      streamOutput: false
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
