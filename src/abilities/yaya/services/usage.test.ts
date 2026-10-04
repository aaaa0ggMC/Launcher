import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { MessageNode } from '../types'
import { computeSessionUsage } from './usage'

let clock = 0
const node = (p: Partial<MessageNode> & Pick<MessageNode, 'id' | 'role'>): MessageNode => ({
  sessionId: 's',
  parentId: null,
  content: '',
  createdAt: ++clock,
  ...p
})

test('用量统计：token 合计 / 缓存 / 按模型 / 工具风险与状态 / 分支过滤', () => {
  const msgs = [
    node({ id: 'u', role: 'user' }),
    node({
      id: 'a1',
      role: 'assistant',
      usage: { prompt: 1000, completion: 100, total: 1100, cached: 800, reasoning: 40 },
      meta: { model: 'm1' },
      toolCalls: [
        { id: 'c1', name: 'run_bash', args: { command: 'ls' }, status: 'success', ms: 20 },
        {
          id: 'c2',
          name: 'run_bash',
          args: { command: 'rm x' },
          status: 'failed',
          rejectReason: 'no'
        },
        { id: 'c3', name: 'get_system_time', args: {}, status: 'failed', error: 'boom' }
      ]
    }),
    node({
      id: 'a2',
      role: 'assistant',
      usage: { prompt: 2000, completion: 50, total: 2050 },
      meta: { model: 'm2' }
    })
  ]
  const risk = (n: string): 'high' | 'low' => (n === 'run_bash' ? 'high' : 'low')
  const all = computeSessionUsage(msgs, new Set(['u', 'a1']), risk)
  assert.equal(all.totals.total, 3150)
  assert.equal(all.totals.cached, 800)
  assert.equal(all.totals.reasoning, 40)
  assert.equal(all.totals.calls, 2)
  assert.deepEqual(
    all.models.map((m) => m.model),
    ['m2', 'm1']
  )
  const bash = all.tools.find((t) => t.name === 'run_bash')!
  assert.deepEqual([bash.count, bash.ok, bash.rejected, bash.risk], [2, 1, 1, 'high'])
  assert.equal(all.tools.find((t) => t.name === 'get_system_time')!.failed, 1)
  assert.deepEqual(
    all.toolLog.map((c) => c.status),
    ['success', 'rejected', 'failed']
  )
  const branch = computeSessionUsage(msgs, new Set(['u', 'a1']), risk, true)
  assert.equal(branch.totals.total, 1100)
  assert.equal(branch.calls.length, 1)
})
