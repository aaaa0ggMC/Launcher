import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWorkflows,
  summarize,
  formatMs,
  isWorkflowEvent,
  runningWorkflow,
  workflowToMarkdown
} from './workflow-view'

const render = (x: { fallback: string; vars: Record<string, string | number> } | null): string =>
  x ? x.fallback.replace(/\{(\w+)\}/g, (m, k: string) => (k in x.vars ? String(x.vars[k]) : m)) : ''

describe('AIDJ workflow view', () => {
  it('groups events per batch, tracks playbook, agents, summaries and the outcome', () => {
    const ev = [
      {
        type: 'workflow_start',
        batch: 'b1',
        phase: 'initial',
        goal: '从辽阔的森林开始',
        startedAt: 1
      },
      { type: 'agent_step', batch: 'b1', step: 1, max: 15 },
      {
        type: 'tool_call',
        batch: 'b1',
        id: 'c1',
        name: 'use_playbook',
        args: { id: 'seed_start' }
      },
      {
        type: 'tool_result',
        batch: 'b1',
        id: 'c1',
        name: 'use_playbook',
        ok: true,
        result: '{}',
        stats: { id: 'seed_start' },
        ms: 1
      },
      {
        type: 'tool_call',
        batch: 'b1',
        id: 'c2',
        name: 'search_lyrics',
        args: { phrases: ['辽阔的森林'] }
      },
      {
        type: 'tool_result',
        batch: 'b1',
        id: 'c2',
        name: 'search_lyrics',
        ok: true,
        result: '{',
        stats: { total_matches: 2, results: 2 },
        ms: 9
      },
      {
        type: 'tool_call',
        batch: 'b1',
        id: 'c3',
        name: 'filter_library',
        args: { drop_emotion: ['upbeat', 'intense'], keep_language: ['chinese'] }
      },
      {
        type: 'tool_result',
        batch: 'b1',
        id: 'c3',
        name: 'filter_library',
        ok: true,
        result: '{}',
        stats: { before: 3223, after: 2071 },
        ms: 3
      },
      {
        type: 'tool_call',
        batch: 'b1',
        id: 'c4',
        name: 'dream_from_seeds',
        args: { seeds: ['#w470'] }
      },
      {
        type: 'tool_result',
        batch: 'b1',
        id: 'c4',
        name: 'dream_from_seeds',
        ok: false,
        result: '{}',
        stats: { error: 'timeout' },
        ms: 5
      },
      { type: 'tool_call', batch: 'b1', id: 'c5', name: 'rank_agent', args: {} },
      { type: 'user', content: 'not a workflow event' },
      { type: 'tool_call', batch: 'b2', id: 'x', name: 'tag_cloud', args: {} },
      {
        type: 'workflow_end',
        batch: 'b1',
        ok: true,
        candidates: 16,
        queued: 8,
        dropped: 8,
        steps: 4,
        ms: 23100
      }
    ]
    const [w1, w2] = buildWorkflows(ev)
    assert.equal(w1.batch, 'b1')
    assert.equal(w1.goal, '从辽阔的森林开始')
    assert.equal(w1.playbook, 'seed_start')
    assert.equal(w1.status, 'ok')
    assert.equal(w1.maxSteps, 15)
    assert.deepEqual(
      w1.steps.map((s) => [s.name, s.agent, s.status]),
      [
        ['use_playbook', 'loop', 'ok'],
        ['search_lyrics', 'loop', 'ok'],
        ['filter_library', 'loop', 'ok'],
        ['dream_from_seeds', 'dream', 'error'],
        // never got a result before the batch ended
        ['rank_agent', 'rank', 'error']
      ]
    )
    assert.equal(render(w1.steps[1].summary), '“辽阔的森林” → 2 首')
    assert.equal(render(w1.steps[2].summary), '3223 → 2071 首 · −emotion(2) +language(1)')
    assert.equal(render(w1.steps[3].summary), '失败：timeout')
    assert.deepEqual(w1.end, {
      noMusic: false,
      candidates: 16,
      queued: 8,
      dropped: 8,
      steps: 4,
      ms: 23100,
      error: undefined
    })
    assert.equal(w1.stage, 'done')
    assert.equal(w2.status, 'running')
    assert.equal(w2.stage, 'loop')
    assert.equal(w2.steps[0].status, 'running')
    assert.equal(runningWorkflow([w1, w2])?.batch, 'b2')
  })

  it('reports the RankAgent stage while it runs (rounds are a ceiling, not a target)', () => {
    const [w] = buildWorkflows([
      { type: 'workflow_start', batch: 'b', phase: 'initial', goal: 'g', startedAt: 1 },
      { type: 'agent_step', batch: 'b', step: 5, max: 15 },
      { type: 'tool_call', batch: 'b', id: 'r', name: 'rank_agent', args: {} }
    ])
    assert.equal(w.stage, 'rank')
    assert.equal(w.step, 5)
    assert.equal(w.maxSteps, 15)
  })

  it('summaries for queue / rank', () => {
    assert.equal(
      render(
        summarize(
          'queue_tracks',
          { pin_first: true },
          { accepted: 1, rejected: 0, queued_total: 1 },
          true
        )
      ),
      '+1 · 拒绝 0 · 共 1'
    )
    assert.equal(
      summarize('queue_tracks', { pin_first: true }, { accepted: 1 }, true)?.key,
      'aidj.wf.sum.queuePin'
    )
    assert.equal(
      render(summarize('rank_agent', {}, { candidates: 16, order: 8, dropped: 8 }, true)),
      '16 选 8 · 剔除 8'
    )
    assert.equal(summarize('my_custom_tool', {}, { x: 1 }, true), null)
  })

  it('helpers', () => {
    assert.equal(formatMs(950), '950ms')
    assert.equal(formatMs(23100), '23.1s')
    assert.equal(formatMs(125000), '2m5s')
    assert.equal(isWorkflowEvent({ type: 'tool_call' }), true)
    assert.equal(isWorkflowEvent({ type: 'playlist' }), false)
  })
})

describe('AIDJ workflow export', () => {
  const ev = [
    {
      type: 'workflow_start',
      batch: 'b',
      phase: 'initial',
      goal: '从辽阔的森林开始',
      startedAt: 1
    },
    { type: 'usage', batch: 'b', agent: 'loop', prompt: 1000, completion: 100, cached: 800 },
    {
      type: 'tool_call',
      batch: 'b',
      id: '1',
      name: 'search_lyrics',
      args: { phrases: ['辽阔的森林'] }
    },
    {
      type: 'tool_result',
      batch: 'b',
      id: '1',
      name: 'search_lyrics',
      ok: true,
      result: '{"x":"a ``` b"}',
      stats: { total_matches: 2 },
      ms: 9
    },
    { type: 'tool_call', batch: 'b', id: '2', name: 'rank_agent', args: {} },
    {
      type: 'tool_result',
      batch: 'b',
      id: '2',
      name: 'rank_agent',
      ok: true,
      result: JSON.stringify({ order: ['#a A'], dropped: [{ track: '#b B', reason: '太吵' }] }),
      stats: { candidates: 2, order: 1, dropped: 1 },
      ms: 5
    },
    {
      type: 'workflow_end',
      batch: 'b',
      ok: true,
      candidates: 2,
      queued: 1,
      dropped: 1,
      steps: 2,
      ms: 1500
    }
  ]
  const tr = (x: { fallback: string; vars: Record<string, string | number> }): string =>
    x.fallback.replace(/\{(\w+)\}/g, (m, k: string) => (k in x.vars ? String(x.vars[k]) : m))

  it('detailed: header + one line per step, no JSON, no drop reasons', () => {
    const [w] = buildWorkflows(ev)
    const md = workflowToMarkdown(w, 'detailed', tr)
    assert.match(
      md,
      /^> \*\*Workflow\*\* · 2 轮 · 2 次调用 · 候选 2 → 入选 1 · 剔除 1 · 1.1k tokens · 1.5s/
    )
    assert.match(md, /> 1\. LoopAgent · 歌词检索：“辽阔的森林” → 2 首 \(9ms\)/)
    assert.doesNotMatch(md, /```/)
    assert.doesNotMatch(md, /太吵/)
  })

  it('advanced: goal, per-agent tokens and every result as JSON (drop reasons included, fences safe)', () => {
    const [w] = buildWorkflows(ev)
    const md = workflowToMarkdown(w, 'advanced', tr)
    assert.match(md, /> 从辽阔的森林开始/)
    assert.match(md, /Tokens: loop 1k in \(800 cached\) \/ 100 out/)
    assert.match(md, /"reason": "太吵"/)
    assert.match(md, /````json\n\{\n {2}"x": "a ``` b"\n\}\n````/)
  })
})
