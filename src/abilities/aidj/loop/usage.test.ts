import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addUsage, diffUsage, emptyUsage, mergeUsage, readUsage, usageFromHistory } from './usage'
import { buildWorkflows, runningStage, usageOfEvents } from '../components/workflow-view'

describe('AIDJ usage accounting', () => {
  it('reads DeepSeek and OpenAI cache fields', () => {
    assert.deepEqual(
      readUsage({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 }),
      { prompt: 100, completion: 5, cached: 80 }
    )
    assert.deepEqual(
      readUsage({
        prompt_tokens: 10,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 4 }
      }),
      { prompt: 10, completion: 1, cached: 4 }
    )
    assert.deepEqual(readUsage(undefined), { prompt: 0, completion: 0, cached: 0 })
  })

  it('adds per agent and merges', () => {
    const a = addUsage(emptyUsage(), 'loop', { prompt: 10, completion: 2, cached: 5 })
    const b = addUsage(
      addUsage(emptyUsage(), 'loop', { prompt: 1, completion: 1, cached: 0 }),
      'dream',
      {
        prompt: 7,
        completion: 3,
        cached: 7
      }
    )
    const m = mergeUsage(a, b)
    assert.deepEqual([m.prompt, m.completion, m.cached], [18, 6, 12])
    assert.deepEqual(m.byAgent.loop, { prompt: 11, completion: 3, cached: 5 })
    assert.equal(a.prompt, 10) // inputs untouched
  })

  it('live usage from events: totals and the latest LoopAgent call as context', () => {
    const ev = [
      { type: 'usage', agent: 'loop', prompt: 100, completion: 10, cached: 50 },
      { type: 'usage', agent: 'dream', prompt: 900, completion: 30, cached: 0 },
      { type: 'usage', agent: 'loop', prompt: 300, completion: 20, cached: 250 }
    ]
    const { total, lastLoop } = usageOfEvents(ev)
    assert.deepEqual([total.prompt, total.completion, total.cached], [1300, 60, 300])
    assert.deepEqual(lastLoop, { prompt: 300, completion: 20, cached: 250 })
    const [w] = buildWorkflows([
      { type: 'workflow_start', batch: 'b', goal: 'g', phase: 'p', startedAt: 1 },
      ...ev.map((e) => ({ ...e, batch: 'b' }))
    ])
    assert.equal(w.usage.prompt, 1300)
  })

  it('running stage text follows the active step', () => {
    const tr = (x: { fallback: string; vars: Record<string, string | number> }): string =>
      x.fallback.replace(/\{(\w+)\}/g, (m, k: string) => (k in x.vars ? String(x.vars[k]) : m))
    const [w] = buildWorkflows([
      { type: 'workflow_start', batch: 'b', goal: 'g', phase: 'p', startedAt: 1 },
      { type: 'agent_step', batch: 'b', step: 5, max: 15 },
      { type: 'tool_call', batch: 'b', id: 'd', name: 'dream_from_seeds', args: {} }
    ])
    assert.equal(runningStage(w, tr), 'DreamAgent 扩展…')
    const [w2] = buildWorkflows([
      { type: 'workflow_start', batch: 'b', goal: 'g', phase: 'p', startedAt: 1 },
      { type: 'agent_step', batch: 'b', step: 2, max: 15 }
    ])
    assert.equal(runningStage(w2, tr), 'LoopAgent 思考中 · 第 2 轮')
  })
})

describe('AIDJ usage — history', () => {
  it('diffUsage gives one turn', () => {
    const before = addUsage(emptyUsage(), 'loop', { prompt: 10, completion: 1, cached: 2 })
    const after = addUsage(
      addUsage(mergeUsage(emptyUsage(), before), 'loop', { prompt: 5, completion: 1, cached: 5 }),
      'rank',
      {
        prompt: 3,
        completion: 2,
        cached: 0
      }
    )
    const d = diffUsage(after, before)
    assert.deepEqual([d.prompt, d.completion, d.cached], [8, 3, 5])
    assert.deepEqual(Object.keys(d.byAgent).sort(), ['loop', 'rank'])
  })

  it('rebuilds totals from line usage, falling back to workflow usage events', () => {
    const u1 = addUsage(emptyUsage(), 'text', { prompt: 100, completion: 10, cached: 0 })
    const raw = [
      { type: 'user' },
      { type: 'both', usage: u1, context: { prompt: 100, completion: 10 } },
      { type: 'user' },
      {
        type: 'workflow',
        workflow: [
          { type: 'usage', agent: 'loop', prompt: 50, completion: 5, cached: 40 },
          { type: 'usage', agent: 'dream', prompt: 200, completion: 20, cached: 150 },
          { type: 'usage', agent: 'loop', prompt: 70, completion: 7, cached: 60 }
        ]
      },
      { type: 'both' }, // old line without usage → workflow events count
      { type: 'model' }
    ]
    const r = usageFromHistory(raw)
    assert.deepEqual([r.usage.prompt, r.usage.completion, r.usage.cached], [420, 42, 250])
    assert.deepEqual(r.context, { prompt: 70, completion: 7 })
    assert.equal(usageFromHistory([]).usage.prompt, 0)
  })
})
