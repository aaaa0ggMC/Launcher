import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { MessageNode, WorkflowCardMeta, WorkflowStepRecord } from '../types'
import {
  answerStep,
  buildTurns,
  buildTurnsReusing,
  mergeNodes,
  hasProcess,
  processSteps,
  summarizeArgs,
  turnFullMarkdown,
  turnSegments,
  turnText
} from './turns'
import type { AssistantTurn } from './turns'

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

describe('turnSegments', () => {
  it('splits plugin tool-card calls (e.g. ask_user) out of the process block, after their step', () => {
    const turns = buildTurns([
      node({ id: 'u', role: 'user', content: 'go' }),
      node({
        id: 's1',
        role: 'assistant',
        content: 'one question first',
        toolCalls: [
          { id: 'c1', name: 'run_bash', args: { command: 'ls' }, status: 'success' },
          { id: 'c2', name: 'ask_user', args: { questions: [] }, status: 'executing' }
        ]
      })
    ])
    const turn = turns[1]
    assert.ok(turn.kind === 'assistant')
    const segs = turnSegments(turn, 'before', (n) => n === 'ask_user')
    assert.deepEqual(
      segs.map((s) => s.kind),
      ['text', 'process', 'toolcard']
    )
    const card = segs[2]
    assert.ok(card.kind === 'toolcard')
    assert.equal(card.call.id, 'c2')
    // 没有判定函数时与旧行为一致
    assert.deepEqual(
      turnSegments(turn).map((s) => s.kind),
      ['text', 'process']
    )
  })

  it('interleaves narration with process blocks; only reasoning and tools are folded', () => {
    const call = (id: string): MessageNode['toolCalls'] => [
      { id, name: 'cockpit_command_script', args: { code: 'x' }, status: 'success' }
    ]
    const turns = buildTurns([
      node({ id: 'u', role: 'user', content: 'play' }),
      node({
        id: 's1',
        role: 'assistant',
        content: '',
        reasoningContent: 'plan',
        toolCalls: call('c1')
      }),
      node({
        id: 's2',
        role: 'assistant',
        content: 'intro is playing',
        reasoningContent: 'hmm',
        toolCalls: call('c2')
      }),
      node({ id: 's3', role: 'assistant', content: 'title screen', toolCalls: call('c3') }),
      node({ id: 's4', role: 'assistant', content: 'done', reasoningContent: 'wrap up' })
    ])
    const turn = turns[1]
    assert.ok(turn.kind === 'assistant')
    const segs = turnSegments(turn)
    assert.deepEqual(
      segs.map((s) =>
        s.kind === 'text'
          ? `text:${s.node.id}`
          : s.kind === 'process'
            ? `proc:${s.items.length}`
            : 'card'
      ),
      // [s1 全部 + s2 思考] → s2 的话 → [s2 工具] → s3 的话 → [s3 工具 + s4 思考]
      ['proc:2', 'text:s2', 'proc:1', 'text:s3', 'proc:2']
    )
    const first = segs[0]
    assert.ok(first.kind === 'process')
    assert.deepEqual(
      first.items.map((i) => (i.kind === 'llm' ? `${i.node.id}:${i.part}` : i.kind)),
      ['s1:all', 's2:reasoning']
    )
    const last = segs[4]
    assert.ok(last.kind === 'process')
    assert.deepEqual(
      last.items.map((i) => (i.kind === 'llm' ? `${i.node.id}:${i.part}:${i.answer}` : i.kind)),
      ['s3:tools:false', 's4:all:true']
    )
    // 最终回答不在分段里
    assert.ok(!segs.some((s) => s.kind === 'text' && s.node.id === 's4'))
  })
})

it('buildTurnsReusing keeps unchanged turn objects and mergeNodes keeps unchanged nodes', () => {
  const mk = (
    id: string,
    role: MessageNode['role'],
    content: string,
    parentId: string | null
  ): MessageNode =>
    ({
      id,
      sessionId: 's',
      parentId,
      role,
      content,
      createdAt: 0,
      status: 'completed'
    }) as MessageNode
  const v1 = [
    mk('u1', 'user', 'hi', null),
    mk('a1', 'assistant', 'yo', 'u1'),
    mk('u2', 'user', 'q', 'a1'),
    mk('a2', 'assistant', 'par', 'u2')
  ]
  const t1 = buildTurns(v1)
  const fresh = v1.map((m) => ({ ...m }))
  fresh[3] = { ...fresh[3], content: 'partial more' }
  const merged = mergeNodes(v1, fresh)
  assert.equal(merged[0], v1[0])
  assert.equal(merged[1], v1[1])
  assert.notEqual(merged[3], v1[3])
  const t2 = buildTurnsReusing(merged, t1)
  assert.equal(t2[0], t1[0])
  assert.equal(t2[1], t1[1])
  assert.equal(t2[2], t1[2])
  assert.notEqual(t2[3], t1[3])
})

it('turnFullMarkdown 按顺序包含思考、说的话、工具调用与回答', () => {
  const steps = [
    {
      id: 'a',
      sessionId: 's',
      parentId: 'u',
      role: 'assistant',
      content: '先查一下',
      reasoningContent: '想想\n再想想',
      toolCalls: [{ id: 'c', name: 'read_file', args: { path: '/x' }, result: { ok: true } }],
      createdAt: 0
    },
    { id: 'b', sessionId: 's', parentId: 'a', role: 'assistant', content: '答案', createdAt: 1 }
  ] as MessageNode[]
  const turn = buildTurns([
    { id: 'u', sessionId: 's', parentId: null, role: 'user', content: 'q', createdAt: 0 },
    ...steps
  ])[1] as AssistantTurn
  const md = turnFullMarkdown(turn, {
    thinking: 'T',
    tool: 'Tool',
    args: 'Args',
    result: 'Res',
    error: 'Err'
  })
  const order = [
    '> **T**',
    '> 想想',
    '先查一下',
    'Tool：`read_file`',
    '"path": "/x"',
    'Res：',
    '答案'
  ]
  let at = -1
  for (const piece of order) {
    const i = md.indexOf(piece)
    assert.ok(i > at, `${piece} 顺序不对：\n${md}`)
    at = i
  }
})

describe('data cards (ctx.addCard)', () => {
  it('cards stay out of steps, are placed by the workflow record, trailing ones after the answer', () => {
    const rec = (
      kind: 'card' | 'llm' | 'compute',
      messageId?: string,
      id = `r-${kind}-${messageId}`
    ): WorkflowStepRecord => ({
      id,
      agent: kind === 'compute' ? 'compute' : 'main',
      kind,
      label: kind,
      messageId,
      startedAt: 0,
      status: 'ok' as const
    })
    const workflow = {
      runId: 'r',
      workflowId: 'story',
      label: 'story',
      status: 'ok' as const,
      startedAt: 0,
      tokens: 0,
      steps: [rec('compute'), rec('card', 'c1'), rec('llm', 'a1'), rec('card', 'c2')]
    }
    const card = (id: string): WorkflowCardMeta => ({
      workflowId: 'story',
      type: 'state',
      title: id
    })
    const turns = buildTurns([
      node({ id: 'u', role: 'user', content: 'go' }),
      node({ id: 'c1', role: 'assistant', content: '', meta: { workflow, card: card('c1') } }),
      node({ id: 'a1', role: 'assistant', content: 'Once upon a time' }),
      node({ id: 'c2', role: 'assistant', content: 'state', meta: { card: card('c2') } })
    ])
    const t = turns[1]
    assert.ok(t.kind === 'assistant')
    assert.deepEqual(
      t.steps.map((n) => n.id),
      ['a1']
    )
    assert.equal(answerStep(t)?.id, 'a1')
    assert.deepEqual(
      turnSegments(t, 'after').map((x) => (x.kind === 'card' ? `card:${x.node.id}` : x.kind)),
      ['card:c2']
    )
    assert.deepEqual(
      turnSegments(t).map((s) => (s.kind === 'card' ? `card:${s.node.id}` : s.kind)),
      ['process', 'card:c1']
    )
    assert.ok(hasProcess(t), 'compute step shows the process card')
  })
})
