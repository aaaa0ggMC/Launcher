/**
 * 上下文管理（切点选择 / 估算 / 摘要输入）的单测：纯函数，不读写磁盘。
 */
import assert from 'node:assert/strict'
import { it } from 'node:test'
import type { MessageNode } from '../types'
import {
  boundaryIndex,
  contextPreamble,
  estimateTokens,
  normalizeContextConfig,
  planContext,
  renderTranscript,
  resolveBudget,
  type ContextState
} from './context'

let seq = 0
function node(role: MessageNode['role'], content: string): MessageNode {
  seq++
  return {
    id: `n${seq}`,
    sessionId: 's',
    parentId: null,
    role,
    content,
    status: 'completed',
    createdAt: seq
  } as MessageNode
}

/** 10 轮，每轮用户 + 助手，每条约 1000 token */
function conversation(): MessageNode[] {
  const out: MessageNode[] = []
  for (let i = 0; i < 10; i++) {
    out.push(node('user', 'u'.repeat(4000)))
    out.push(node('assistant', 'a'.repeat(4000)))
  }
  return out
}

it('估算：中日韩字符算 1，其余 4 字符算 1', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens(''), 0)
})

it('配置归一化与预算', () => {
  assert.deepEqual(normalizeContextConfig({ mode: 'weird', keepTurns: 0 }), {
    mode: 'off',
    maxTokens: 0,
    keepTurns: 4
  })
  assert.equal(normalizeContextConfig({ maxTokens: 100 }).maxTokens, 4000)
  assert.equal(resolveBudget({ mode: 'drop', maxTokens: 0, keepTurns: 4 }, 200_000), 150_000)
  assert.equal(resolveBudget({ mode: 'drop', maxTokens: 0, keepTurns: 4 }), 96_000)
  assert.equal(resolveBudget({ mode: 'drop', maxTokens: 50_000, keepTurns: 4 }, 200_000), 50_000)
})

it('没超预算不切；超了切在用户消息上，切到预算的一半以下，保留最近几轮', () => {
  const nodes = conversation()
  const opts = { keepTurns: 4, overhead: 500, mode: 'drop' as const }
  assert.equal(planContext(nodes, { ...opts, budget: 100_000 }), null)
  const plan = planContext(nodes, { ...opts, keepTurns: 2, budget: 12_000 })
  assert.ok(plan)
  assert.equal(nodes[plan.index].role, 'user')
  assert.ok(plan.after <= 6_000, `after=${plan.after}`)
  assert.equal(plan.cut.length, plan.index)
  // 保留最近 4 轮 = 最多切到倒数第 4 条用户消息
  const tight = planContext(nodes, { ...opts, budget: 1_000 })
  assert.ok(tight)
  assert.equal(tight.index, 12)
})

it('切点记住后前缀不变：再次规划从旧切点开始，没超就不动', () => {
  const nodes = conversation()
  const plan = planContext(nodes, { keepTurns: 2, overhead: 0, mode: 'drop', budget: 12_000 })!
  const state: ContextState = {
    boundaryId: nodes[plan.index].id,
    dropped: plan.index,
    mode: 'drop',
    at: 0,
    before: plan.before,
    after: plan.after
  }
  assert.equal(boundaryIndex(nodes, state), plan.index)
  // 多一轮对话，仍在预算内 → 不动
  const more = [...nodes, node('user', 'hi'), node('assistant', 'ok')]
  assert.equal(
    planContext(more, { keepTurns: 2, overhead: 0, mode: 'drop', budget: 12_000, state }),
    null
  )
  // 切点不在分支上（换了分支）→ 无效
  assert.equal(boundaryIndex(nodes.slice(0, 3), state), -1)
})

it('摘要输入带上旧摘要，单条过长截断；前言区分压缩 / 丢弃', () => {
  const t = renderTranscript([node('user', '问题'), node('tool', 'x'.repeat(5000))], '旧摘要内容')
  assert.match(t, /Previous summary\n\n旧摘要内容/)
  assert.match(t, /chars omitted/)
  const base = { boundaryId: 'x', dropped: 6, at: 0, before: 0, after: 0 }
  assert.match(contextPreamble({ ...base, mode: 'compress', summary: 'S' }), /Summary.*\nS\n/)
  assert.match(contextPreamble({ ...base, mode: 'drop' }), /6 earlier messages .* dropped/)
})
