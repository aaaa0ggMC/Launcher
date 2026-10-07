import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'
import type { AIProvider, ProviderGenerateResult } from '../providers/types'
import type { YayaConfig } from '../../types'

process.env.HOME = mkdtempSync('/tmp/yaya-controls-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('../db')
let Runner: typeof import('./runner').WorkflowRunner
let sessions: typeof import('../../../../main/process/agent/sessions')
let plugins: typeof import('../plugins/registry')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('../db')
  Runner = (await import('./runner')).WorkflowRunner
  sessions = await import('../../../../main/process/agent/sessions')
  plugins = await import('../plugins/registry')
  await import('../workflow/builtin')
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((r) => {
      resolve = r
    }),
    resolve: (v) => resolve(v)
  }
}
const answer = { content: 'done' } satisfies ProviderGenerateResult
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await tick()
  }
  assert.fail('state was not reached')
}
function runner(
  id: string,
  provider: AIProvider,
  config: Partial<YayaConfig> = {}
): InstanceType<typeof Runner> {
  const user = randomUUID()
  const assistant = randomUUID()
  db.insertMessage({
    id: user,
    sessionId: id,
    parentId: null,
    role: 'user',
    content: 'test',
    status: 'completed',
    createdAt: Date.now()
  })
  db.insertMessage({
    id: assistant,
    sessionId: id,
    parentId: user,
    role: 'assistant',
    content: '',
    status: 'pending',
    createdAt: Date.now()
  })
  return new Runner({
    sessionId: id,
    userMessageId: user,
    assistantMessageId: assistant,
    provider,
    config: {
      defaultWorkflow: 'agent',
      systemPrompt: '',
      assistantName: 'Test',
      disabledTools: [],
      providers: [],
      ...config
    } as YayaConfig,
    tools: [],
    step: 0,
    maxSteps: 3,
    status: 'pending',
    ringBuffer: []
  })
}

it('late completion of a stopped run cannot unregister the replacement run in the same chat', async () => {
  plugins.__resetPluginsForTest()
  const id = randomUUID()
  db.createSession({ id, title: 'test' })
  const oldAnswer = deferred<ProviderGenerateResult>()
  const newAnswer = deferred<ProviderGenerateResult>()
  const old = runner(id, {
    id: 'fake',
    generate: async () => oldAnswer.promise,
    listModels: async () => []
  })
  const oldDone = old.run()
  await tick()
  old.abort()
  const next = runner(id, {
    id: 'fake',
    generate: async () => newAnswer.promise,
    listModels: async () => []
  })
  const nextDone = next.run()
  await tick()
  assert.notEqual(old.agentSessionId, next.agentSessionId)
  oldAnswer.resolve(answer)
  await oldDone
  assert.ok(sessions.getSession(next.agentSessionId))
  newAnswer.resolve(answer)
  await nextDone
  assert.equal(sessions.getSession(next.agentSessionId), undefined)
})

it('approval cannot execute a tool until a pause is released; unadvertised tools fail', async () => {
  plugins.__resetPluginsForTest()
  let calls = 0
  plugins.registerPlugin({
    id: 'test',
    kind: 'builtin',
    label: '',
    description: '',
    namespace: false,
    tools: () => [
      {
        name: 'allowed',
        description: '',
        parameters: {},
        approval: 'ask',
        run: async () => {
          calls++
          return 'ok'
        }
      },
      {
        name: 'disabled',
        description: '',
        parameters: {},
        run: async () => {
          calls++
          return 'bad'
        }
      }
    ]
  })
  const config = { disabledTools: ['disabled'] } as YayaConfig
  plugins.refreshPlugins(config)
  const id = randomUUID()
  db.createSession({ id, title: 'test' })
  let step = 0
  const r = runner(
    id,
    {
      id: 'fake',
      listModels: async () => [],
      generate: async () =>
        ++step === 1
          ? {
              content: '',
              toolCalls: [
                { id: 'c1', name: 'allowed', args: {}, status: 'pending' },
                { id: 'c2', name: 'disabled', args: {}, status: 'pending' }
              ]
            }
          : answer
    },
    config
  )
  const done = r.run()
  await until(() => r.status === 'waiting_approval')
  r.pause()
  r.resolveApproval(true)
  await tick()
  assert.equal(calls, 0)
  r.resume()
  await done
  assert.equal(calls, 1)
})

it('a plugin tool can run a sub-agent with tools; its calls share approval and land in the process record', async () => {
  plugins.__resetPluginsForTest()
  let probed = 0
  plugins.registerPlugin({
    id: 'test',
    kind: 'builtin',
    label: '',
    description: '',
    namespace: false,
    tools: () => [
      {
        name: 'probe',
        description: '',
        parameters: {},
        approval: 'ask',
        run: async () => {
          probed++
          return 'probe-result'
        }
      },
      {
        name: 'dispatch',
        description: '',
        parameters: {},
        run: async (_args, ctx) => {
          assert.ok(ctx.workflow, 'tools run by the workflow host get a workflow handle')
          const res = await ctx.workflow.runAgent({
            agent: 'deputy',
            label: 'deputy',
            system: 'sub',
            task: 'look',
            tools: ['probe']
          })
          return `report: ${res.content} (${res.calls.length} calls)`
        }
      }
    ]
  })
  plugins.refreshPlugins({} as YayaConfig)
  const id = randomUUID()
  db.createSession({ id, title: 'test' })
  const seen: string[][] = []
  let main = 0
  const r = runner(id, {
    id: 'fake',
    listModels: async () => [],
    generate: async (opts) => {
      const sys = opts.messages[0].content
      if (sys === 'sub') {
        seen.push((opts.tools ?? []).map((x) => x.name))
        const last = opts.messages[opts.messages.length - 1]
        return last.role === 'tool'
          ? { content: `found ${last.content}` }
          : {
              content: '',
              toolCalls: [{ id: 's1', name: 'probe', args: {}, status: 'pending' }]
            }
      }
      return ++main === 1
        ? {
            content: '',
            toolCalls: [{ id: 'm1', name: 'dispatch', args: {}, status: 'pending' }]
          }
        : answer
    }
  })
  const done = r.run()
  await until(() => r.status === 'waiting_approval')
  assert.equal(r.getSnapshot().pendingApprovalTool?.name, 'probe')
  r.resolveApproval(true)
  await done
  assert.equal(probed, 1)
  // 子 Agent 只拿到白名单里的工具
  assert.deepEqual(seen[0], ['probe'])
  const branch = db.getMessageBranch(db.getSession(id)!.activeLeafId!)
  const toolNode = branch.find((n) => n.role === 'tool' && n.name === 'dispatch')
  assert.equal(toolNode?.content, 'report: found probe-result (1 calls)')
  const rec = branch.find((n) => n.meta?.workflow)?.meta?.workflow
  const step = rec.steps.find((s: { agent: string }) => s.agent === 'deputy')
  assert.equal(step.status, 'ok')
  assert.equal(step.calls[0].status, 'success')
  assert.equal(step.detail, 'found probe-result')
})
