import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MessageNode } from '../types'
import { answerStep, buildTurns, hasProcess, processSteps, summarizeArgs, turnText } from './turns'

let clock = 0
function node(partial: Partial<MessageNode> & Pick<MessageNode, 'id' | 'role'>): MessageNode {
  return {
    sessionId: 's',
    parentId: null,
    content: '',
    status: 'completed',
    createdAt: ++clock,
    ...partial
  }
}

describe('buildTurns', () => {
  it('folds assistant steps and tool results into one turn per user message', () => {
    const branch = [
      node({ id: 'u1', role: 'user', content: 'hi' }),
      node({
        id: 'a1',
        role: 'assistant',
        content: 'checking',
        toolCalls: [{ id: 'c1', name: 'run_bash', args: { command: 'ls' }, status: 'success' }],
        siblingIds: ['a0', 'a1']
      }),
      node({ id: 't1', role: 'tool', toolCallId: 'c1', name: 'run_bash', content: '{}' }),
      node({ id: 'a2', role: 'assistant', content: 'done', status: 'completed' }),
      node({ id: 'u2', role: 'user', content: 'again' }),
      node({ id: 'a3', role: 'assistant', content: '', status: 'streaming' })
    ]
    const turns = buildTurns(branch)
    assert.deepEqual(
      turns.map((t) => t.kind),
      ['user', 'assistant', 'user', 'assistant']
    )
    const first = turns[1]
    assert.ok(first.kind === 'assistant')
    assert.deepEqual(
      first.steps.map((s) => s.id),
      ['a1', 'a2']
    )
    assert.equal(first.orphanResults.length, 0)
    assert.deepEqual(first.siblingIds, ['a0', 'a1'])
    assert.equal(first.firstId, 'a1')
    assert.equal(first.lastId, 'a2')
    assert.equal(turnText(first), 'checking\n\ndone')
    const last = turns[3]
    assert.ok(last.kind === 'assistant')
    assert.equal(last.status, 'streaming')
  })

  it('keeps tool results without a matching call (imported data) as orphans', () => {
    const turns = buildTurns([
      node({ id: 'u1', role: 'user', content: 'q' }),
      node({ id: 't1', role: 'tool', name: 'x', content: 'result' })
    ])
    const t = turns[1]
    assert.ok(t.kind === 'assistant')
    assert.equal(t.steps.length, 0)
    assert.equal(t.orphanResults[0].id, 't1')
  })
})

describe('summarizeArgs', () => {
  it('prefers well-known fields and truncates', () => {
    assert.equal(
      summarizeArgs({ id: '1', name: 'run_bash', args: { command: 'ls  -la\n/tmp' } }),
      'ls -la /tmp'
    )
    assert.equal(summarizeArgs({ id: '1', name: 'x', args: 'a'.repeat(100) }, 10), 'aaaaaaaaaa…')
    assert.equal(summarizeArgs({ id: '1', name: 'x', args: { n: 1 } }), '{"n":1}')
  })
})

describe('answer / process split', () => {
  const tool = { id: 'c', name: 'run_bash', args: {}, status: 'success' as const }
  it('puts the last tool-free step in the bubble and the rest in the process card', () => {
    const [, t] = buildTurns([
      node({ id: 'u', role: 'user', content: 'q' }),
      node({ id: 'a1', role: 'assistant', content: 'looking', toolCalls: [tool] }),
      node({ id: 'a2', role: 'assistant', content: 'answer' })
    ])
    assert.ok(t.kind === 'assistant')
    assert.equal(answerStep(t)?.id, 'a2')
    assert.deepEqual(
      processSteps(t).map((s) => s.id),
      ['a1']
    )
    assert.equal(hasProcess(t), true)
  })
  it('has no process card for a plain answer, but shows one for reasoning or sub-agents', () => {
    const plain = buildTurns([
      node({ id: 'u', role: 'user' }),
      node({ id: 'a', role: 'assistant', content: 'x' })
    ])[1]
    assert.ok(plain.kind === 'assistant')
    assert.equal(hasProcess(plain), false)
    const reasoning = buildTurns([
      node({ id: 'u', role: 'user' }),
      node({ id: 'a', role: 'assistant', content: 'x', reasoningContent: 'hmm' })
    ])[1]
    assert.ok(reasoning.kind === 'assistant')
    assert.equal(hasProcess(reasoning), true)
    const planned = buildTurns([
      node({ id: 'u', role: 'user' }),
      node({
        id: 'a',
        role: 'assistant',
        content: 'x',
        meta: {
          workflow: {
            runId: 'r',
            workflowId: 'plan-act',
            label: 'p',
            status: 'ok',
            startedAt: 0,
            tokens: 0,
            steps: [
              {
                id: 's',
                agent: 'planner',
                kind: 'subagent',
                label: 'plan',
                status: 'ok',
                startedAt: 0
              }
            ]
          }
        }
      })
    ])[1]
    assert.ok(planned.kind === 'assistant')
    assert.equal(hasProcess(planned), true)
    assert.equal(planned.workflow?.workflowId, 'plan-act')
  })
  it('keeps a step that is still calling tools out of the bubble', () => {
    const [, t] = buildTurns([
      node({ id: 'u', role: 'user' }),
      node({
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [tool],
        status: 'tool_executing'
      })
    ])
    assert.ok(t.kind === 'assistant')
    assert.equal(answerStep(t), null)
  })
})
