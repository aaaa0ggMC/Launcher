/**
 * ask 插件：问题 / 回答规范化，以及经真实 WorkflowRunner 的「提问 → 挂起 → 回答 → 继续」。
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { before, it } from 'node:test'
import type { AIProvider, ProviderGenerateOptions } from '../../services/providers/types'
import type { YayaConfig } from '../../types'
import {
  answerText,
  normalizeQuestions,
  normalizeResponse,
  pendingCalls,
  submitAnswer,
  waitForAnswer
} from './ask'

process.env.HOME = mkdtempSync('/tmp/yaya-ask-test-')
process.env.XDG_CONFIG_HOME = `${process.env.HOME}/.config`

let db: typeof import('../../services/db')
let Runner: typeof import('../../services/loop/runner').WorkflowRunner
let plugins: typeof import('../../services/plugins/registry')
let ask: typeof import('./index')
before(async () => {
  assert.ok(process.env.HOME?.startsWith('/tmp/'), 'HOME must be isolated under /tmp/')
  db = await import('../../services/db')
  Runner = (await import('../../services/loop/runner')).WorkflowRunner
  plugins = await import('../../services/plugins/registry')
  await import('../../services/workflow/builtin')
  ask = await import('./index')
})

it('问题规范化：去重选项、单选项报错、顶层单题兼容', () => {
  const qs = normalizeQuestions({
    questions: [
      {
        question: ' 用哪种语言？ ',
        header: '语言',
        options: [{ label: 'TS' }, { label: 'TS' }, 'Go', { label: '' }],
        multiSelect: true
      },
      { question: '还有什么要求？' }
    ]
  })
  assert.deepEqual(qs, [
    {
      question: '用哪种语言？',
      header: '语言',
      options: [{ label: 'TS' }, { label: 'Go' }],
      multiSelect: true
    },
    { question: '还有什么要求？', options: [], multiSelect: false }
  ])
  assert.throws(() => normalizeQuestions({ questions: [] }))
  assert.throws(() => normalizeQuestions({ questions: [{ question: 'x', options: ['a'] }] }))
  assert.throws(() => normalizeQuestions({ questions: Array(5).fill({ question: 'x' }) }))
  assert.equal(normalizeQuestions({ question: '单题？', options: ['A', 'B'] }).length, 1)
  // 有的模型把数组写成 JSON 字符串
  assert.equal(normalizeQuestions({ questions: '[{"question":"q?"}]' })[0].question, 'q?')
})

it('回答规范化：未知选项丢掉、单选只留一个、空答案算跳过、全跳过算没回答', () => {
  const qs = normalizeQuestions({
    questions: [
      { question: 'a?', options: ['x', 'y'] },
      { question: 'b?', options: ['m', 'n'], multiSelect: true },
      { question: 'c?' }
    ]
  })
  const res = normalizeResponse(qs, {
    answers: [{ selected: ['y', 'x', 'zzz'] }, { selected: ['n', 'm'], note: ' 都要 ' }, {}]
  })
  assert.deepEqual(res, {
    answers: [
      { selected: ['x'] },
      { selected: ['m', 'n'], note: '都要' },
      { selected: [], skipped: true }
    ]
  })
  const text = answerText(qs, res)
  assert.ok(text.includes('1. a?\n   Answer: x'))
  assert.ok(text.includes('Note: 都要'))
  assert.ok(text.includes('3. c?\n   (skipped'))
  assert.equal(normalizeResponse(qs, { answers: [] }).dismissed, true)
  assert.ok(answerText(qs, { answers: [], dismissed: true }).includes('without answering'))
})

it('挂起表：按调用 id 回答；对不上时会话里只有一个就答它；中止时清掉', async () => {
  const qs = normalizeQuestions({ question: 'q?', options: ['a', 'b'] })
  const p = waitForAnswer('s1', 'c1', qs)
  assert.deepEqual(pendingCalls('s1'), ['c1'])
  assert.equal(submitAnswer('s2', 'c1', {}), false)
  assert.equal(submitAnswer('s1', 'other', { answers: [{ selected: ['b'] }] }), true)
  assert.deepEqual((await p).answers, [{ selected: ['b'] }])
  assert.deepEqual(pendingCalls('s1'), [])

  const ac = new AbortController()
  const q = waitForAnswer('s1', 'c2', qs, ac.signal)
  ac.abort(new Error('stop'))
  await assert.rejects(q, /stop/)
  assert.deepEqual(pendingCalls('s1'), [])
  assert.equal(submitAnswer('s1', 'c2', {}), false)
})

const CONFIG = {
  defaultWorkflow: 'agent',
  systemPrompt: '',
  assistantName: 'Test',
  disabledTools: [],
  streamOutput: false,
  providers: [],
  pluginEnabled: { ask: true },
  pluginConfig: {}
} as unknown as YayaConfig

it('经 Runner：ask_user 挂起直到用户回答，模型在同一轮拿到回答继续', async () => {
  plugins.__resetPluginsForTest()
  plugins.registerPlugin(ask.default)
  plugins.refreshPlugins(CONFIG)
  const calls: ProviderGenerateOptions[] = []
  const provider: AIProvider = {
    id: 'fake',
    listModels: async () => [],
    generate: async (opts) => {
      calls.push(opts)
      const last = opts.messages[opts.messages.length - 1]
      if (last.role === 'user')
        return {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'ask_user',
              args: { questions: [{ question: '用哪种语言？', options: ['TS', 'Go'] }] }
            }
          ]
        }
      return { content: `好的，${last.content.includes('Answer: Go') ? '用 Go' : '?'}` }
    }
  }
  const sessionId = randomUUID()
  db.createSession({ id: sessionId, title: 't' })
  const user = randomUUID()
  const anchor = randomUUID()
  db.insertMessage(
    {
      id: user,
      sessionId,
      parentId: null,
      role: 'user',
      content: '帮我写个脚本',
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
  const run = new Runner({
    sessionId,
    userMessageId: user,
    assistantMessageId: anchor,
    provider,
    config: CONFIG,
    tools: [],
    step: 0,
    maxSteps: 10,
    status: 'pending',
    ringBuffer: []
  }).run()

  // 等工具挂起
  for (let i = 0; i < 100 && !pendingCalls(sessionId).length; i++)
    await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(pendingCalls(sessionId), ['call-1'])
  assert.ok(calls[0].messages[0].content?.includes('## Asking the user'))
  assert.equal(db.getMessage(anchor)!.toolCalls?.[0].status, 'executing')

  assert.equal(submitAnswer(sessionId, 'call-1', { answers: [{ selected: ['Go'] }] }), true)
  await run

  const branch = db.getMessageBranch(db.getSession(sessionId)!.activeLeafId)
  assert.equal(branch.at(-1)!.content, '好的，用 Go')
  const call = db.getMessage(anchor)!.toolCalls![0]
  assert.equal(call.status, 'success')
  assert.deepEqual((call.result as { answers: unknown }).answers, [{ selected: ['Go'] }])
})
