import assert from 'node:assert/strict'
import { it } from 'node:test'
import {
  MAX_TASKS,
  deputyTools,
  mapLimit,
  parseDispatch,
  parseTasks,
  reportText,
  runDeputies
} from './index'

it('parseTasks: 容忍顶层单任务、丢弃空任务、限制个数与名字长度', () => {
  assert.deepEqual(parseTasks({ task: 'do x', name: 'X' }), [{ name: 'X', task: 'do x' }])
  const many = Array.from({ length: 9 }, (_, i) => ({ name: `n${i}`, task: `t${i}` }))
  assert.equal(parseTasks({ tasks: many }).length, MAX_TASKS)
  const out = parseTasks({
    tasks: [{ name: '', task: 'a', tools: ['x', 1] }, { name: 'b' }, 'junk', { brief: 'c' }]
  })
  assert.deepEqual(out, [
    { name: '#1', task: 'a', tools: ['x'] },
    { name: '#2', task: 'c' }
  ])
})

it('parseDispatch: 代码块包裹 / 前后废话 / 空列表 / 坏 JSON', () => {
  assert.deepEqual(parseDispatch('```json\n{"tasks":[{"name":"A","task":"go"}]}\n```'), [
    { name: 'A', task: 'go' }
  ])
  assert.deepEqual(parseDispatch('Sure: {"tasks": []} done'), [])
  assert.equal(parseDispatch('no json'), null)
  assert.equal(parseDispatch('{"tasks": [}'), null)
})

it('deputyTools: 不给自己的工具；readonly 只留免确认；白名单', () => {
  const available = [
    { name: 'deputy_dispatch', pluginId: 'deputy', approval: 'auto' as const },
    { name: 'read', pluginId: 'system', approval: 'auto' as const },
    { name: 'shell', pluginId: 'system', approval: 'ask' as const },
    { name: 'web', pluginId: 'search', approval: 'dynamic' as const }
  ]
  assert.deepEqual(deputyTools(available, 'all'), ['read', 'shell', 'web'])
  assert.deepEqual(deputyTools(available, 'readonly'), ['read'])
  assert.deepEqual(deputyTools(available, 'none'), [])
  assert.deepEqual(deputyTools(available, 'all', ['web', 'deputy_dispatch']), ['web'])
})

it('deputyTools: 交互类工具（noSubAgent）不交给副代理', () => {
  const available = [
    { name: 'read', pluginId: 'system', approval: 'auto' as const },
    { name: 'ask_user', pluginId: 'ask', approval: 'auto' as const, noSubAgent: true },
    { name: 'shell', pluginId: 'system', approval: 'ask' as const }
  ]
  assert.deepEqual(deputyTools(available, 'all'), ['read', 'shell'])
  assert.deepEqual(deputyTools(available, 'readonly'), ['read'])
  // 白名单也绕不过：过程卡片里没有回答入口
  assert.deepEqual(deputyTools(available, 'all', ['ask_user', 'read']), ['read'])
})

it('mapLimit: 并发不超过上限，结果按原顺序', async () => {
  let running = 0
  let peak = 0
  const out = await mapLimit([5, 1, 3, 2, 4], 2, async (x) => {
    running++
    peak = Math.max(peak, running)
    await new Promise((r) => setTimeout(r, x))
    running--
    return x * 10
  })
  assert.equal(peak, 2)
  assert.deepEqual(out, [50, 10, 30, 20, 40])
})

it('runDeputies: 单个失败不影响其他；报告文字带状态', async () => {
  const seen: Array<{ label: string; tools: unknown; maxRounds?: number }> = []
  const res = await runDeputies(
    {
      availableTools: () => [
        { name: 'deputy_dispatch', pluginId: 'deputy' },
        { name: 'read', pluginId: 'system', approval: 'auto' }
      ],
      runAgent: async (o) => {
        seen.push({ label: o.label, tools: o.tools, maxRounds: o.maxRounds })
        if (o.label === 'bad') throw new Error('boom')
        return { content: `did ${o.task}`, calls: [], rounds: 1, tokens: 3, exhausted: false }
      }
    },
    [
      { name: 'good', task: 'A' },
      { name: 'bad', task: 'B' }
    ],
    { maxRounds: 99 }
  )
  assert.deepEqual(
    res.map((r) => [r.name, r.status, r.report, r.error]),
    [
      ['good', 'ok', 'did A', undefined],
      ['bad', 'error', '', 'boom']
    ]
  )
  assert.deepEqual(seen[0].tools, ['read'])
  assert.equal(seen[0].maxRounds, 30)
  const text = reportText(res)
  assert.match(text, /## Deputy "good" — ok/)
  assert.match(text, /Error: boom/)
})

it('reportText: 停止 / 轮数用完有明确措辞', () => {
  const text = reportText([
    {
      name: 'stop',
      task: 'A',
      status: 'stopped',
      report: '',
      calls: 1,
      failedCalls: 0,
      rounds: 2,
      tokens: 0,
      exhausted: false
    },
    {
      name: 'tired',
      task: 'B',
      status: 'ok',
      report: 'partial',
      calls: 3,
      failedCalls: 1,
      rounds: 8,
      tokens: 10,
      exhausted: true
    }
  ])
  assert.match(text, /## Deputy "stop" — stopped/)
  assert.match(text, /\(stopped before it could finish\)/)
  assert.match(text, /## Deputy "tired" — ok \(ran out of rounds\)/)
  assert.match(text, /partial/)
})
