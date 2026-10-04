import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type OpenAI from 'openai'
import type { PlaylistEntry, SongMeta } from '../types'
import { DEFAULT_AIDJ_CONFIG } from '../types'
import { artistsOf, orderLibrary, enforceArtistCap, configureArtistOrientation } from './diversity'
import { DEFAULT_LOOP_POLICY, resolveLoopPolicy, candidateTarget } from './policy'
import { DEFAULT_LOOP_PROMPTS, renderTemplate } from './prompts'
import { planBatch } from './planner'
import { activeDjTools, type DjTool, type DjToolContext } from './agent/tools'
import { runAgentBatch } from './agent/runner'
import { buildIdIndex } from './agent/ids'
import { buildLyricsIndex } from './agent/lyrics-index'
import { resolvePlaybooks, parsePlaybook } from './agent/playbooks'
import { parseRankOutput, runRankAgent } from './agent/rank'
import { LOOP_PROMPT_NAMES } from './prompts'
import { DJSession } from '../services/session'
import { runAgentWorkflow } from './agent/workflow'
import { agentModel } from './models'
import { tavilySearch } from './agent/web-search'
import type { AgentEvent } from './agent/runner'
import { SEPARATOR } from '../types'

const meta = new Map<string, SongMeta>([
  [
    'C418 - Sweden',
    { emotion: ['peaceful', 'nostalgic'], genre: 'ambient', language: 'Instrumental' }
  ],
  [
    'C418 - Wet Hands',
    { emotion: ['peaceful', 'nostalgic'], genre: 'ambient', language: 'Instrumental' }
  ],
  [
    'C418 - Mice on Venus',
    { emotion: ['peaceful', 'dreamy'], genre: 'ambient', language: 'Instrumental' }
  ],
  [
    '坂本龍一 - Energy Flow',
    { emotion: ['peaceful', 'melancholic'], genre: 'piano', language: 'Instrumental' }
  ],
  ['陈粒 - 小半', { emotion: ['melancholic', 'nostalgic'], genre: 'folk', language: 'Chinese' }],
  ['陈粒 - 易燃易爆炸', { emotion: ['intense'], genre: 'folk', language: 'Chinese' }],
  [
    'toe - Goodbye',
    { emotion: ['melancholic', 'nostalgic'], genre: 'post-rock', language: 'Japanese' }
  ]
])
const paths = new Map([...meta.keys()].map((k) => [k, `/m/${k}.flac`]))
const ids = buildIdIndex(meta.keys())
const lyricsIdx = buildLyricsIndex(
  meta.keys(),
  paths,
  new Map([
    ['陈粒 - 小半', '[00:01.00]作词 : 陈粒\n[00:10.00]走在辽阔的 森林里\n[00:20.00]不知归处'],
    ['toe - Goodbye', '[00:05.00]遼闊的森林'],
    ['C418 - Sweden', '[00:01.00]instrumental']
  ])
)

function ctx(over: Partial<DjToolContext> = {}): DjToolContext {
  return {
    config: DEFAULT_AIDJ_CONFIG,
    client: {} as OpenAI,
    policy: { ...DEFAULT_LOOP_POLICY, library_agent: false },
    prompts: DEFAULT_LOOP_PROMPTS,
    metadata: meta,
    musicPaths: paths,
    played: new Set(),
    staged: [],
    recent: [],
    capArtists: true,
    resolveKey: (q) => (meta.has(q) ? q : null),
    ids,
    pool: null,
    pinned: [],
    playbooks: resolvePlaybooks(DEFAULT_AIDJ_CONFIG, DEFAULT_LOOP_POLICY),
    lyrics: () => lyricsIdx,
    formatLibrary: () => '',
    addUsage: () => {},
    ...over
  }
}

function tool(name: string): DjTool {
  const t = activeDjTools({ ...DEFAULT_LOOP_POLICY, library_agent: true }).find(
    (x) => x.name === name
  )
  assert.ok(t, `tool ${name} registered`)
  return t
}

describe('AIDJ loop — diversity', () => {
  it('parses artists', () => {
    assert.deepEqual(artistsOf('羽生まゐご,v flower - ハレハレヤ'), ['羽生まゐご', 'v flower'])
    assert.deepEqual(artistsOf('NoSeparator'), [])
  })

  it('emotion order keeps same-artist tracks apart', () => {
    const o = orderLibrary([...meta.keys()], meta, 'emotion')
    assert.equal(o.length, meta.size)
    for (let i = 1; i < o.length; i++) {
      const a = artistsOf(o[i - 1])
      // C418 has 3 of 7 tracks in one bucket — they may meet only if unavoidable.
      if (a.includes('c418')) assert.ok(!artistsOf(o[i]).includes('c418') || i > 4)
    }
  })

  it('detects "Title - Artist" keys library-wide', () => {
    const keys = [
      '七里香 - 周杰伦',
      '晴天 - 周杰伦',
      '稻香 - 周杰伦',
      '夜曲 - 周杰伦',
      '走西口 - 张三',
      '李四 - 走西口',
      '王五 - 走西口',
      '赵六 - 走西口'
    ]
    configureArtistOrientation(keys)
    assert.deepEqual(artistsOf('七里香 - 周杰伦'), ['周杰伦'])
    // a song title covered 3 times is not mistaken for an artist
    assert.deepEqual(artistsOf('李四 - 走西口'), ['李四'])
    configureArtistOrientation([])
    assert.deepEqual(artistsOf('七里香 - 周杰伦'), ['七里香'])
  })

  it('caps artists and de-clusters', () => {
    const pl: PlaylistEntry[] = [...meta.keys()].map((n) => ({ name: n, path: paths.get(n)! }))
    const { kept, dropped } = enforceArtistCap(pl, 2)
    assert.equal(dropped.length, 1)
    assert.equal(kept.filter((s) => s.name.startsWith('C418')).length, 2)
    for (let i = 1; i < kept.length; i++) {
      assert.notDeepEqual(artistsOf(kept[i].name), artistsOf(kept[i - 1].name))
    }
  })
})

describe('AIDJ loop — policy / planner', () => {
  it('clamps and defaults', () => {
    const p = resolveLoopPolicy({
      ...DEFAULT_AIDJ_CONFIG,
      preferences: {
        ...DEFAULT_AIDJ_CONFIG.preferences,
        loop: { batch_size: 999, mode: 'nope' as never }
      }
    })
    assert.equal(p.batch_size, 50)
    assert.equal(p.mode, 'agent')
  })

  it('renders template placeholders once', () => {
    assert.equal(renderTemplate('{a} {b} {zz}', { a: '{b}', b: 2 }), '{b} 2 {zz}')
  })

  it('autonomous phase includes tags and caps artists', () => {
    const plan = planBatch({
      policy: DEFAULT_LOOP_POLICY,
      prompts: DEFAULT_LOOP_PROMPTS,
      mode: 'agent',
      metadata: meta,
      initialPrompt: '安静一点',
      userDirection: null,
      fetchCount: 2,
      rollingHistory: ['toe - Goodbye']
    })
    assert.equal(plan.phase, 'autonomous')
    assert.equal(plan.capArtists, true)
    assert.match(plan.prompt, /toe - Goodbye \| melancholic\/nostalgic \| post-rock/)
    assert.match(plan.prompt, /queue_tracks/)
  })

  it('user direction is not artist-capped', () => {
    const plan = planBatch({
      policy: DEFAULT_LOOP_POLICY,
      prompts: DEFAULT_LOOP_PROMPTS,
      mode: 'text',
      metadata: meta,
      initialPrompt: 'x',
      userDirection: '只放 C418',
      fetchCount: 3,
      rollingHistory: []
    })
    assert.equal(plan.phase, 'directed')
    assert.equal(plan.capArtists, false)
  })
})

describe('AIDJ loop — tools', () => {
  it('search_library filters, excludes played and diversifies', async () => {
    const c = ctx({ played: new Set(['toe - Goodbye']) })
    const r = (await tool('search_library').run({ emotion: ['melanchol'], per_artist: 1 }, c)) as {
      results: { key: string }[]
    }
    const keys = r.results.map((x) => x.key).sort()
    assert.deepEqual(keys, ['坂本龍一 - Energy Flow', '陈粒 - 小半'])
  })

  it('similar_to excludes the same artist by default', async () => {
    const r = (await tool('similar_to').run({ key: 'C418 - Sweden' }, ctx())) as {
      results: { key: string }[]
    }
    assert.ok(r.results.length > 0)
    assert.ok(r.results.every((x) => !x.key.startsWith('C418')))
  })

  it('queue_tracks validates and enforces the cap', async () => {
    const c = ctx({ played: new Set(['toe - Goodbye']) })
    const r = (await tool('queue_tracks').run(
      {
        ids: [
          ids.idOf('C418 - Sweden'),
          'C418 - Wet Hands',
          ids.idOf('C418 - Mice on Venus'),
          ids.idOf('toe - Goodbye'),
          '#zzzz'
        ]
      },
      c
    )) as { accepted: string[]; rejected: { reason: string }[]; still_needed: number }
    assert.deepEqual(r.accepted, [
      `${ids.idOf('C418 - Sweden')} C418 - Sweden`,
      `${ids.idOf('C418 - Wet Hands')} C418 - Wet Hands`
    ])
    assert.equal(r.rejected.length, 3)
    assert.equal(r.still_needed, candidateTarget(DEFAULT_LOOP_POLICY) - 2)
    await tool('unqueue_tracks').run({ ids: [ids.idOf('C418 - Sweden')] }, c)
    assert.deepEqual(
      c.staged.map((s) => s.name),
      ['C418 - Wet Hands']
    )
  })

  it('library agent reads only its scope and answers with IDs', async () => {
    let seenLibrary: string[] | null = null
    const fake = {
      chat: {
        completions: {
          create: async () => ({
            choices: [
              {
                message: {
                  content: `${ids.idOf('陈粒 - 小半')}\n- ${ids.idOf('toe - Goodbye')} toe - Goodbye\n#zzzz\n陈粒 - 易燃易爆炸`
                }
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
          })
        }
      }
    } as unknown as OpenAI
    const c = ctx({
      client: fake,
      formatLibrary: (keys) => {
        seenLibrary = keys
        return 'lib'
      }
    })
    const r = (await tool('ask_library_agent').run(
      { brief: 'sad folk', scope: { language: ['chinese'] } },
      c
    )) as { scope_size: number; results: { key: string; id: string }[] }
    assert.deepEqual([...(seenLibrary ?? [])].sort(), ['陈粒 - 小半', '陈粒 - 易燃易爆炸'])
    assert.equal(r.scope_size, 2)
    // toe is outside the scope → dropped even though the librarian named it.
    assert.deepEqual(
      r.results.map((x) => x.key),
      ['陈粒 - 小半', '陈粒 - 易燃易爆炸']
    )
    assert.equal(r.results[0].id, ids.idOf('陈粒 - 小半'))

    // Default scope = the filtered pool.
    await tool('filter_library').run({ drop_emotion: ['intense'], drop_language: ['japanese'] }, c)
    await tool('ask_library_agent').run({ brief: 'calm' }, c)
    const scoped: string[] = seenLibrary ?? []
    assert.equal(scoped.length, meta.size - 2)
    assert.ok(!scoped.includes('陈粒 - 易燃易爆炸'))
  })

  it('ids are short, stable and exact', () => {
    const id = ids.idOf('toe - Goodbye')
    assert.match(id, /^#[0-9a-z]{4}$/)
    assert.equal(buildIdIndex([...meta.keys()].reverse()).idOf('toe - Goodbye'), id)
    assert.equal(ids.keyOf(id), 'toe - Goodbye')
    assert.equal(ids.keyOf('#zzzz'), null)
  })

  it('filter_library narrows the pool in bulk and refuses to empty it', async () => {
    const c = ctx()
    const cloud = (await tool('tag_cloud').run({}, c)) as { tracks: number; emotion: string }
    assert.equal(cloud.tracks, meta.size)
    assert.match(cloud.emotion, /peaceful\(4\)/)
    const r = (await tool('filter_library').run(
      { keep_emotion: ['melancholic'], drop_genre: ['post-rock'], keep_emotion_typo: 1 },
      c
    )) as { after: number; unknown_tags: string[] }
    assert.equal(r.after, 2)
    assert.deepEqual([...(c.pool ?? [])].sort(), ['坂本龍一 - Energy Flow', '陈粒 - 小半'])
    const bad = (await tool('filter_library').run({ keep_genre: ['metal'] }, c)) as {
      error?: string
      unknown_tags: string[]
    }
    assert.ok(bad.error)
    assert.deepEqual(bad.unknown_tags, ['genre:metal'])
    assert.equal(c.pool?.size, 2)
    // search tools stay inside the pool
    const s = (await tool('search_library').run({}, c)) as { total_matches: number }
    assert.equal(s.total_matches, 2)
    await tool('filter_library').run({ reset: true }, c)
    assert.equal(c.pool?.size, meta.size)
  })

  it('lyrics search matches phrases across variants, spaces and punctuation', async () => {
    const c = ctx()
    const r = (await tool('search_lyrics').run({ phrases: ['辽阔的森林'] }, c)) as {
      total_matches: number
      searched: number
      results: { key: string; lyric: string }[]
    }
    assert.equal(r.searched, 3)
    assert.deepEqual(r.results.map((x) => x.key).sort(), ['toe - Goodbye', '陈粒 - 小半'])
    assert.equal(r.results.find((x) => x.key === '陈粒 - 小半')?.lyric, '走在辽阔的 森林里')
    const all = (await tool('search_lyrics').run(
      { phrases: ['森林', '归处'], require: 'all' },
      c
    )) as { results: { key: string }[] }
    assert.deepEqual(
      all.results.map((x) => x.key),
      ['陈粒 - 小半']
    )
    // credit lines are not lyrics
    const credit = (await tool('search_lyrics').run({ phrases: ['陈粒'] }, c)) as {
      total_matches: number
    }
    assert.equal(credit.total_matches, 0)
    await tool('filter_library').run({ keep_lyrics: ['森林'] }, c)
    assert.equal(c.pool?.size, 2)
  })
})

describe('AIDJ loop — kernel runner', () => {
  it('runs tool calls until a final reply', async () => {
    const replies = [
      {
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'queue_tracks',
              arguments: JSON.stringify({
                ids: [ids.idOf('陈粒 - 小半'), ids.idOf('toe - Goodbye')]
              })
            }
          },
          { id: 'c2', type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }
        ]
      },
      { content: '<think>hmm</think>**Intro** text' }
    ]
    const seen: unknown[][] = []
    const fake = {
      chat: {
        completions: {
          create: async (body: { messages: unknown[] }) => {
            seen.push([...body.messages])
            return {
              choices: [{ message: replies.shift() }],
              usage: { prompt_tokens: 100, completion_tokens: 20 }
            }
          }
        }
      }
    } as unknown as OpenAI
    const events: string[] = []
    const c = ctx({ client: fake })
    const r = await runAgentBatch({
      ctx: c,
      model: 'm',
      system: 'sys',
      history: [],
      userPrompt: 'go',
      maxSteps: 5,
      timeoutMs: 1000,
      retry: (fn) => fn(),
      onEvent: (e) =>
        events.push(e.type === 'agent_step' ? 'step' : `${e.type}:${'name' in e ? e.name : ''}`)
    })
    assert.equal(r.intro, '**Intro** text')
    assert.equal(r.steps, 2)
    assert.equal(r.promptTokens, 200)
    assert.deepEqual(
      c.staged.map((s) => s.name),
      ['陈粒 - 小半', 'toe - Goodbye']
    )
    assert.deepEqual(events, [
      'step',
      'usage:',
      'tool_call:queue_tracks',
      'tool_result:queue_tracks',
      'tool_call:no_such_tool',
      'tool_result:no_such_tool',
      'step',
      'usage:'
    ])
    assert.deepEqual(
      { prompt: r.usage.prompt, completion: r.usage.completion },
      { prompt: 200, completion: 40 }
    )
    // Second request carries the assistant tool_calls + both tool results.
    const roles = (seen[1] as { role: string }[]).map((m) => m.role)
    assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'tool'])
  })

  it('forces a final reply when out of steps', async () => {
    const choices: string[] = []
    const fake = {
      chat: {
        completions: {
          create: async (body: { tool_choice: string }) => {
            choices.push(body.tool_choice)
            return {
              choices: [
                {
                  message: {
                    content: body.tool_choice === 'none' ? 'done' : '',
                    tool_calls:
                      body.tool_choice === 'none'
                        ? undefined
                        : [
                            {
                              id: 'x',
                              type: 'function',
                              function: { name: 'tag_cloud', arguments: '{}' }
                            }
                          ]
                  }
                }
              ]
            }
          }
        }
      }
    } as unknown as OpenAI
    const r = await runAgentBatch({
      ctx: ctx({ client: fake }),
      model: 'm',
      system: 's',
      history: [],
      userPrompt: 'u',
      maxSteps: 2,
      timeoutMs: 1000,
      retry: (fn) => fn()
    })
    assert.deepEqual(choices, ['auto', 'auto', 'none'])
    assert.equal(r.intro, 'done')
  })
})

type FakeBody = { messages: { role: string; content: string }[] }

function fakeClient(reply: (body: FakeBody) => string): { client: OpenAI; calls: FakeBody[] } {
  const calls: { messages: { role: string; content: string }[] }[] = []
  const client = {
    chat: {
      completions: {
        create: async (body: { messages: { role: string; content: string }[] }) => {
          calls.push(body)
          return {
            choices: [{ message: { content: reply(body) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          }
        }
      }
    }
  } as unknown as OpenAI
  return { client, calls }
}

describe('AIDJ loop — prompt files & playbooks', () => {
  it('every template file exists and system prompts render without leftovers', () => {
    assert.ok(LOOP_PROMPT_NAMES.every((n) => DEFAULT_LOOP_PROMPTS[n].length > 0))
    const helper = new DJSession({} as OpenAI, meta, paths, DEFAULT_AIDJ_CONFIG)
    const leftovers = (s: string): string[] => s.match(/\{[a-zA-Z]\w*\}/g) ?? []
    const agent = helper.buildAgentSystemPrompt(
      resolvePlaybooks(DEFAULT_AIDJ_CONFIG, DEFAULT_LOOP_POLICY)
    )
    assert.deepEqual(leftovers(agent), [])
    assert.match(agent, /seed_start/)
    assert.match(agent, /MEDIUM/)
    assert.deepEqual(leftovers(helper.buildRankSystemPrompt()), [])
    const text = helper.buildSystemPrompt()
    assert.deepEqual(leftovers(text), [])
    assert.ok(text.includes(SEPARATOR))
    for (const phase of [
      { fetchCount: 0, userDirection: null },
      { fetchCount: 3, userDirection: null },
      { fetchCount: 3, userDirection: '来点周杰伦' }
    ]) {
      const plan = planBatch({
        policy: DEFAULT_LOOP_POLICY,
        prompts: DEFAULT_LOOP_PROMPTS,
        mode: 'agent',
        metadata: meta,
        initialPrompt: 'x',
        rollingHistory: ['toe - Goodbye'],
        ...phase
      })
      assert.deepEqual(leftovers(plan.prompt), [], plan.phase)
    }
  })

  it('built-in playbooks load; config overrides, adds and disables', () => {
    const ids0 = resolvePlaybooks(DEFAULT_AIDJ_CONFIG, DEFAULT_LOOP_POLICY).map((p) => p.id)
    assert.deepEqual([...ids0].sort(), [
      'artist_pick',
      'chat',
      'open_request',
      'radio_flow',
      'seed_start'
    ])
    const cfg = {
      ...DEFAULT_AIDJ_CONFIG,
      preferences: {
        ...DEFAULT_AIDJ_CONFIG.preferences,
        loop_playbooks: [
          { id: 'seed_start', title: 'mine', when: 'w', steps: 'my steps' },
          { id: 'sleep', title: 'Sleep', when: 'bedtime', steps: 'go quiet' }
        ]
      }
    }
    const list = resolvePlaybooks(cfg, {
      ...DEFAULT_LOOP_POLICY,
      disabled_playbooks: ['radio_flow']
    })
    assert.deepEqual(list.map((p) => p.id).sort(), [
      'artist_pick',
      'chat',
      'open_request',
      'seed_start',
      'sleep'
    ])
    assert.equal(list.find((p) => p.id === 'seed_start')?.steps, 'my steps')
    assert.equal(parsePlaybook('---\nid: a\nwhen: b\n---\nsteps', 'x')?.when, 'b')
  })

  it('playbook 按批次阶段过滤：radio_flow 只在自主续播，open_request 只在用户请求', () => {
    const ids = (phase?: 'initial' | 'directed' | 'autonomous'): string[] =>
      resolvePlaybooks(DEFAULT_AIDJ_CONFIG, DEFAULT_LOOP_POLICY, phase)
        .map((p) => p.id)
        .sort()
    // 用户的首次请求 / 新方向：不能出现「续播电台」（描述写了无新要求才用，但 LLM 会对「随便来点」挑它）
    for (const phase of ['initial', 'directed'] as const) {
      assert.ok(!ids(phase).includes('radio_flow'), phase)
      assert.ok(ids(phase).includes('open_request'), phase)
      assert.ok(ids(phase).includes('seed_start'), phase)
    }
    // 自主续播：没有用户请求，open_request 不适用
    assert.ok(ids('autonomous').includes('radio_flow'))
    assert.ok(!ids('autonomous').includes('open_request'))
    // 没给阶段（预览 / 设置页）：不过滤
    assert.ok(ids().includes('radio_flow') && ids().includes('open_request'))
    // 没声明 phases 的（如 chat）所有阶段都在
    for (const phase of ['initial', 'directed', 'autonomous'] as const)
      assert.ok(ids(phase).includes('chat'))
  })

  it('parsePlaybook 解析 phases；非法值忽略；用户自定义范式也可带 phases', () => {
    assert.deepEqual(
      parsePlaybook('---\nid: a\nwhen: b\nphases: initial, directed\n---\nsteps', 'x')?.phases,
      ['initial', 'directed']
    )
    assert.equal(
      parsePlaybook('---\nid: a\nwhen: b\nphases: bogus\n---\nsteps', 'x')?.phases,
      undefined
    )
    assert.equal(parsePlaybook('---\nid: a\nwhen: b\n---\nsteps', 'x')?.phases, undefined)
    const cfg = {
      ...DEFAULT_AIDJ_CONFIG,
      preferences: {
        ...DEFAULT_AIDJ_CONFIG.preferences,
        loop_playbooks: [
          { id: 'night', title: 'Night', when: 'late', steps: 's', phases: ['autonomous' as const] }
        ]
      }
    }
    const inAuto = resolvePlaybooks(cfg, DEFAULT_LOOP_POLICY, 'autonomous').map((p) => p.id)
    const inInit = resolvePlaybooks(cfg, DEFAULT_LOOP_POLICY, 'initial').map((p) => p.id)
    assert.ok(inAuto.includes('night') && !inInit.includes('night'))
  })

  it('use_playbook returns steps', async () => {
    const r = (await tool('use_playbook').run({ id: 'seed_start' }, ctx())) as { steps: string }
    assert.match(r.steps, /pin_first/)
    const bad = (await tool('use_playbook').run({ id: 'nope' }, ctx())) as { available: string[] }
    assert.ok(bad.available.includes('artist_pick'))
  })
})

describe('AIDJ loop — paradigm tools', () => {
  it('search_titles matches artists and titles across Chinese variants', async () => {
    const r = (await tool('search_titles').run({ query: ['陳粒'] }, ctx())) as {
      results: { key: string }[]
    }
    assert.deepEqual(r.results.map((x) => x.key).sort(), ['陈粒 - 小半', '陈粒 - 易燃易爆炸'])
    const t = (await tool('search_titles').run({ query: 'wet hands' }, ctx())) as {
      results: { key: string }[]
    }
    assert.deepEqual(
      t.results.map((x) => x.key),
      ['C418 - Wet Hands']
    )
    const none = (await tool('search_titles').run({ query: '辽阔的森林' }, ctx())) as {
      total_matches: number
    }
    assert.equal(none.total_matches, 0)
  })

  it('get_songs can include lyrics', async () => {
    const r = (await tool('get_songs').run(
      { ids: [ids.idOf('陈粒 - 小半')], include_lyrics: true },
      ctx()
    )) as { lyrics: string }[]
    assert.equal(r[0].lyrics, '走在辽阔的 森林里 / 不知归处')
  })

  it('pin_first opens the batch and may replay / bypass the cap', async () => {
    const c = ctx({ played: new Set(['toe - Goodbye']) })
    await tool('queue_tracks').run(
      { ids: [ids.idOf('C418 - Sweden'), ids.idOf('C418 - Wet Hands')] },
      c
    )
    const r = (await tool('queue_tracks').run(
      { ids: [ids.idOf('toe - Goodbye')], pin_first: true },
      c
    )) as { accepted: string[]; still_needed: number }
    assert.equal(r.accepted.length, 1)
    assert.deepEqual(
      c.staged.map((s) => s.name),
      ['toe - Goodbye', 'C418 - Sweden', 'C418 - Wet Hands']
    )
    assert.equal(
      r.still_needed,
      DEFAULT_LOOP_POLICY.batch_size * DEFAULT_LOOP_POLICY.candidate_factor - 3
    )
    await tool('queue_tracks').run({ ids: [ids.idOf('C418 - Mice on Venus')], pin_first: true }, c)
    assert.deepEqual(c.pinned, ['toe - Goodbye', 'C418 - Mice on Venus'])
    assert.equal(c.staged[1].name, 'C418 - Mice on Venus')
  })

  it('dream_from_seeds describes the seeds and never returns them', async () => {
    const { client, calls } = fakeClient(
      () => `${ids.idOf('陈粒 - 小半')}\n${ids.idOf('坂本龍一 - Energy Flow')}`
    )
    const c = ctx({ client })
    const r = (await tool('dream_from_seeds').run(
      { seeds: [ids.idOf('陈粒 - 小半')], direction: 'forest' },
      c
    )) as { results: { key: string }[] }
    assert.deepEqual(
      r.results.map((x) => x.key),
      ['坂本龍一 - Energy Flow']
    )
    const user = calls[0].messages[1].content
    assert.match(user, /陈粒 - 小半 \| melancholic\/nostalgic \| folk/)
    assert.match(user, /走在辽阔的 森林里/)
    assert.match(calls[0].messages[0].content, /DreamAgent/)
  })

  it('ask_library_agent accepts an explicit id scope', async () => {
    let seen: string[] = []
    const { client } = fakeClient(() => ids.idOf('陈粒 - 易燃易爆炸'))
    const c = ctx({
      client,
      formatLibrary: (keys) => {
        seen = keys ?? []
        return ''
      }
    })
    const r = (await tool('ask_library_agent').run(
      { brief: 'b', scope: { ids: [ids.idOf('陈粒 - 小半'), ids.idOf('陈粒 - 易燃易爆炸')] } },
      c
    )) as { results: { key: string }[] }
    assert.deepEqual([...seen].sort(), ['陈粒 - 小半', '陈粒 - 易燃易爆炸'])
    assert.deepEqual(
      r.results.map((x) => x.key),
      ['陈粒 - 易燃易爆炸']
    )
  })
})

describe('AIDJ loop — unknown language', () => {
  const m2 = new Map<string, SongMeta>([
    ['A - zh', { emotion: ['calm'], genre: 'pop', language: 'Chinese' }],
    ['B - en', { emotion: ['calm'], genre: 'pop', language: 'English' }],
    ['C - unk', { emotion: ['calm'], genre: 'pop', language: 'unknown' }],
    ['D - none', { emotion: ['calm'], genre: 'pop' }]
  ])
  const p2 = new Map([...m2.keys()].map((k) => [k, `/m/${k}`]))
  const c2 = (): DjToolContext =>
    ctx({
      metadata: m2,
      musicPaths: p2,
      ids: buildIdIndex(m2.keys()),
      resolveKey: (q) => (m2.has(q) ? q : null)
    })

  it('language filters never remove unknown-language tracks', async () => {
    const c = c2()
    const keep = (await tool('filter_library').run({ keep_language: ['chinese'] }, c)) as {
      after: number
      kept_unknown_language: number
    }
    assert.equal(keep.after, 3)
    assert.equal(keep.kept_unknown_language, 2)
    assert.deepEqual([...(c.pool ?? [])].sort(), ['A - zh', 'C - unk', 'D - none'])

    const c3 = c2()
    const drop = (await tool('filter_library').run(
      { drop_language: ['chinese', 'english', 'unknown'] },
      c3
    )) as { after: number; ignored: string[] }
    assert.equal(drop.after, 2)
    assert.deepEqual(drop.ignored, ['language:unknown'])

    const s = (await tool('search_library').run({ exclude_language: ['english'] }, c2())) as {
      total_matches: number
    }
    assert.equal(s.total_matches, 3)
    const cloud = (await tool('tag_cloud').run({}, c2())) as { language_unknown: number }
    assert.equal(cloud.language_unknown, 2)
  })
})

describe('AIDJ loop — RankAgent', () => {
  const cand = (n: string): PlaylistEntry => ({ name: n, path: paths.get(n)! })

  it('tolerant parsing: separator variants, several / bare IDs, no separator at all', () => {
    const c = ctx()
    const all = [...meta.keys()].map(cand)
    const a = ids.idOf('toe - Goodbye')
    const b = ids.idOf('C418 - Sweden')
    const v1 = parseRankOutput(`Intro\n--- SONG LIST ---\n${a}, ${b}`, c, all)
    assert.deepEqual(v1.order, ['toe - Goodbye', 'C418 - Sweden'])
    const v2 = parseRankOutput(
      `Intro\n[---SONG_LIST---]\n1. ${a.slice(1)} toe\n2. ${b.slice(1)}`,
      c,
      all
    )
    assert.deepEqual(v2.order, ['toe - Goodbye', 'C418 - Sweden'])
    const v3 = parseRankOutput(`Nice set tonight.\n\n${b} C418 - Sweden\n${a}`, c, all)
    assert.equal(v3.intro, 'Nice set tonight.')
    assert.deepEqual(v3.order, ['C418 - Sweden', 'toe - Goodbye'])
  })

  it('drop reasons: parsed from Part 3, never counted as the order, filled in for cap / missing', async () => {
    const c = ctx()
    const a = ids.idOf('toe - Goodbye')
    const b = ids.idOf('C418 - Sweden')
    const d = ids.idOf('陈粒 - 易燃易爆炸')
    const reply = `Intro\n${SEPARATOR}\n${a}\n[---DROPPED---]\n${b} — 太安静，接不上\n- ${d}: 能量过高`
    const p = parseRankOutput(reply, c, [...meta.keys()].map(cand))
    assert.deepEqual(p.order, ['toe - Goodbye'])
    assert.equal(p.reasons['C418 - Sweden'], '太安静，接不上')
    assert.equal(p.reasons['陈粒 - 易燃易爆炸'], '能量过高')

    c.client = fakeClient(() => reply).client
    const r = await runRankAgent({
      ctx: c,
      model: 'm',
      system: 's',
      instruction: 'i',
      note: 'n',
      candidates: ['toe - Goodbye', 'C418 - Sweden', 'C418 - Wet Hands'].map(cand),
      batchSize: 8,
      timeoutMs: 1000,
      retry: (fn) => fn()
    })
    assert.equal(r.dropReasons['C418 - Sweden'], '太安静，接不上')
    assert.equal(r.dropReasons['C418 - Wet Hands'], '(no reason given)')
    assert.equal(r.intro, 'Intro')
  })

  it('fallback keeps only one batch; a long reply is capped at 1.5×', async () => {
    const many = [...meta.keys()].map(cand) // 7 candidates
    const c = ctx({ client: fakeClient(() => 'no list at all').client })
    const fb = await runRankAgent({
      ctx: c,
      model: 'm',
      system: 's',
      instruction: 'i',
      note: 'n',
      candidates: many,
      batchSize: 3,
      timeoutMs: 1000,
      retry: (fn) => fn()
    })
    assert.equal(fb.fallback, true)
    assert.equal(fb.playlist.length, 3)
    const all = many.map((m) => ids.idOf(m.name)).join('\n')
    c.client = fakeClient(() => `x\n${SEPARATOR}\n${all}`).client
    const long = await runRankAgent({
      ctx: c,
      model: 'm',
      system: 's',
      instruction: 'i',
      note: 'n',
      candidates: many,
      batchSize: 3,
      timeoutMs: 1000,
      retry: (fn) => fn()
    })
    assert.equal(long.fallback, false)
    assert.equal(long.playlist.length, 5)
  })

  it('parses intro + ids, ignoring tracks outside the candidates', () => {
    const c = ctx()
    const out = parseRankOutput(
      `<think>x</think>**Hello**\n\n${SEPARATOR}\n${ids.idOf('toe - Goodbye')}\n${ids.idOf('C418 - Sweden')}\n#zzzz`,
      c,
      [cand('toe - Goodbye')]
    )
    assert.equal(out.intro, '**Hello**')
    assert.deepEqual(out.order, ['toe - Goodbye'])
  })

  it('keeps pinned first, drops the rest it left out, falls back when unparseable', async () => {
    const c = ctx()
    c.pinned.push('陈粒 - 小半')
    const candidates = ['陈粒 - 小半', 'toe - Goodbye', 'C418 - Sweden'].map(cand)
    const { client } = fakeClient(
      () => `Intro\n${SEPARATOR}\n${ids.idOf('C418 - Sweden')}\n${ids.idOf('陈粒 - 小半')}`
    )
    c.client = client
    const r = await runRankAgent({
      ctx: c,
      model: 'm',
      system: 's',
      instruction: 'i',
      note: 'n',
      candidates,
      batchSize: 8,
      timeoutMs: 1000,
      retry: (fn) => fn()
    })
    assert.equal(r.intro, 'Intro')
    assert.deepEqual(
      r.playlist.map((p) => p.name),
      ['陈粒 - 小半', 'C418 - Sweden']
    )
    assert.deepEqual(r.dropped, ['toe - Goodbye'])

    c.client = fakeClient(() => 'just words').client
    const fb = await runRankAgent({
      ctx: c,
      model: 'm',
      system: 's',
      instruction: 'i',
      note: 'n',
      candidates,
      batchSize: 8,
      timeoutMs: 1000,
      retry: (fn) => fn()
    })
    assert.equal(fb.playlist.length, 3)
    assert.equal(fb.playlist[0].name, '陈粒 - 小半')
  })
})

describe('AIDJ loop — shared workflow', () => {
  it('runs LoopAgent then RankAgent and emits one batch of events', async () => {
    const replies: unknown[] = [
      {
        content: '',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: {
              name: 'queue_tracks',
              arguments: JSON.stringify({
                ids: [ids.idOf('陈粒 - 小半'), ids.idOf('toe - Goodbye')],
                pin_first: false
              })
            }
          }
        ]
      },
      { content: 'handoff note' },
      { content: `Rank intro\n${SEPARATOR}\n${ids.idOf('toe - Goodbye')}` }
    ]
    const client = {
      chat: {
        completions: { create: async () => ({ choices: [{ message: replies.shift() }] }) }
      }
    } as unknown as OpenAI
    const events: AgentEvent[] = []
    const helper = new DJSession(client, meta, paths, DEFAULT_AIDJ_CONFIG)
    const plan = planBatch({
      policy: DEFAULT_LOOP_POLICY,
      prompts: DEFAULT_LOOP_PROMPTS,
      mode: 'agent',
      metadata: meta,
      initialPrompt: 'x',
      userDirection: null,
      fetchCount: 0,
      rollingHistory: []
    })
    const r = await runAgentWorkflow({
      client,
      config: DEFAULT_AIDJ_CONFIG,
      policy: DEFAULT_LOOP_POLICY,
      plan,
      helper,
      metadata: meta,
      musicPaths: paths,
      lyrics: new Map(),
      played: [],
      history: [],
      goal: 'x',
      retry: (fn) => fn(),
      emit: (e) => events.push(e)
    })
    assert.equal(r.intro, 'Rank intro')
    assert.deepEqual(
      r.playlist.map((p) => p.name),
      ['toe - Goodbye']
    )
    const batch = events[0].batch
    assert.ok(batch && events.every((e) => e.batch === batch))
    assert.deepEqual(
      events.map((e) => e.type),
      [
        'workflow_start',
        'agent_step',
        'tool_call',
        'tool_result',
        'agent_step',
        'tool_call',
        'tool_result',
        'workflow_end'
      ]
    )
    const qr = events[3] as Extract<AgentEvent, { type: 'tool_result' }>
    assert.equal(qr.stats?.accepted, 2)
    const end = events[7] as Extract<AgentEvent, { type: 'workflow_end' }>
    assert.deepEqual([end.ok, end.candidates, end.queued, end.dropped], [true, 2, 1, 1])
  })
})

describe('AIDJ loop — per-agent models', () => {
  it('falls back to the default model and routes each agent to its own', async () => {
    const cfg = {
      ...DEFAULT_AIDJ_CONFIG,
      preferences: {
        ...DEFAULT_AIDJ_CONFIG.preferences,
        model: 'default-m',
        agent_models: { rank: 'rank-m', lib: '  ', dream: 'dream-m' }
      }
    }
    assert.equal(agentModel(cfg, 'loop'), 'default-m')
    assert.equal(agentModel(cfg, 'lib'), 'default-m')
    assert.equal(agentModel(cfg, 'rank'), 'rank-m')

    const used: string[] = []
    const replies: unknown[] = [
      {
        content: '',
        tool_calls: [
          {
            id: 'd',
            type: 'function',
            function: {
              name: 'dream_from_seeds',
              arguments: JSON.stringify({ seeds: [ids.idOf('陈粒 - 小半')] })
            }
          }
        ]
      },
      { content: '' },
      {
        content: '',
        tool_calls: [
          {
            id: 'q',
            type: 'function',
            function: {
              name: 'queue_tracks',
              arguments: JSON.stringify({ ids: [ids.idOf('toe - Goodbye')] })
            }
          }
        ]
      },
      { content: 'note' },
      { content: `intro\n${SEPARATOR}\n${ids.idOf('toe - Goodbye')}` }
    ]
    const client = {
      chat: {
        completions: {
          create: async (body: { model: string }) => {
            used.push(body.model)
            return { choices: [{ message: replies.shift() }] }
          }
        }
      }
    } as unknown as OpenAI
    await runAgentWorkflow({
      client,
      config: cfg,
      policy: DEFAULT_LOOP_POLICY,
      plan: planBatch({
        policy: DEFAULT_LOOP_POLICY,
        prompts: DEFAULT_LOOP_PROMPTS,
        mode: 'agent',
        metadata: meta,
        initialPrompt: 'x',
        userDirection: null,
        fetchCount: 0,
        rollingHistory: []
      }),
      helper: new DJSession(client, meta, paths, cfg),
      metadata: meta,
      musicPaths: paths,
      lyrics: new Map(),
      played: [],
      history: [],
      goal: 'x',
      retry: (fn) => fn()
    })
    // loop → dream (sub-call) → loop → loop → rank
    assert.deepEqual(used, ['default-m', 'dream-m', 'default-m', 'default-m', 'rank-m'])
  })
})

describe('AIDJ loop — random_pick / web_search', () => {
  it('random_pick stays inside the pool, skips recent artists, can queue', async () => {
    const c = ctx({ recent: ['toe - Goodbye'], played: new Set(['C418 - Sweden']) })
    await tool('filter_library').run({ keep_emotion: ['peaceful', 'melancholic'] }, c)
    const r = (await tool('random_pick').run({ count: 10, per_artist: 1 }, c)) as {
      pool_size: number
      picked: { key: string }[]
    }
    const keys = r.picked.map((p) => p.key)
    assert.ok(keys.every((k) => c.pool!.has(k)))
    assert.ok(!keys.includes('C418 - Sweden')) // played
    assert.ok(!keys.some((k) => k.startsWith('toe'))) // recent artist
    assert.equal(keys.filter((k) => k.startsWith('C418')).length, 1) // per_artist
    const q = (await tool('random_pick').run({ count: 2, queue: true }, c)) as {
      queued: { accepted: string[] }
    }
    assert.equal(q.queued.accepted.length, c.staged.length)
    assert.ok(c.staged.length > 0)
  })

  it('web_search is only offered when enabled with a key', () => {
    const names = (cfg: typeof DEFAULT_AIDJ_CONFIG): string[] =>
      activeDjTools(DEFAULT_LOOP_POLICY, cfg).map((t) => t.name)
    assert.ok(!names(DEFAULT_AIDJ_CONFIG).includes('web_search'))
    const on = {
      ...DEFAULT_AIDJ_CONFIG,
      secrets: { api_key: '', tavily: { api_key: 'tvly-x' } },
      preferences: { ...DEFAULT_AIDJ_CONFIG.preferences, web_search: { enabled: true } }
    }
    assert.ok(names(on).includes('web_search'))
    assert.ok(!names({ ...on, secrets: { api_key: '' } }).includes('web_search'))
  })

  it('tavilySearch posts the query with the key and trims results', async () => {
    const orig = globalThis.fetch
    let seen: { url: string; init: RequestInit } | null = null
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(
        JSON.stringify({
          answer: 'A',
          results: [{ title: 'T', url: 'U', content: 'x'.repeat(2000) }]
        })
      )
    }) as typeof fetch
    try {
      const cfg = {
        ...DEFAULT_AIDJ_CONFIG,
        secrets: { api_key: '', tavily: { api_key: 'tvly-x' } },
        preferences: {
          ...DEFAULT_AIDJ_CONFIG.preferences,
          web_search: { enabled: true, max_results: 3 }
        }
      }
      const r = await tavilySearch(cfg, '陈粒 风格')
      assert.equal(r.answer, 'A')
      assert.equal(r.results[0].snippet.length, 600)
      const s = seen as unknown as { url: string; init: RequestInit }
      assert.equal(s.url, 'https://api.tavily.com/search')
      assert.equal((s.init.headers as Record<string, string>).Authorization, 'Bearer tvly-x')
      assert.equal(JSON.parse(String(s.init.body)).max_results, 3)
    } finally {
      globalThis.fetch = orig
    }
  })
})

describe('AIDJ loop — conversation-only turns', () => {
  it('no_music: nothing is queued, no RankAgent, the reply is the answer', async () => {
    const replies: unknown[] = [
      {
        content: '',
        tool_calls: [
          {
            id: 'a',
            type: 'function',
            function: { name: 'no_music', arguments: '{"reason":"chat"}' }
          },
          {
            id: 'b',
            type: 'function',
            function: {
              name: 'queue_tracks',
              arguments: JSON.stringify({ ids: [ids.idOf('toe - Goodbye')] })
            }
          }
        ]
      },
      { content: '据目前公开信息，还没有官方消息。' }
    ]
    let calls = 0
    const client = {
      chat: {
        completions: {
          create: async () => {
            calls++
            return { choices: [{ message: replies.shift() }] }
          }
        }
      }
    } as unknown as OpenAI
    const events: AgentEvent[] = []
    const r = await runAgentWorkflow({
      client,
      config: DEFAULT_AIDJ_CONFIG,
      policy: DEFAULT_LOOP_POLICY,
      plan: planBatch({
        policy: DEFAULT_LOOP_POLICY,
        prompts: DEFAULT_LOOP_PROMPTS,
        mode: 'agent',
        metadata: meta,
        initialPrompt: '不听歌，聊聊时事',
        userDirection: null,
        fetchCount: 0,
        rollingHistory: []
      }),
      helper: new DJSession(client, meta, paths, DEFAULT_AIDJ_CONFIG),
      metadata: meta,
      musicPaths: paths,
      lyrics: new Map(),
      played: [],
      history: [],
      goal: 'x',
      retry: (fn) => fn(),
      emit: (e) => events.push(e)
    })
    assert.equal(r.noMusic, true)
    assert.deepEqual(r.playlist, [])
    assert.equal(r.intro, '据目前公开信息，还没有官方消息。')
    assert.equal(calls, 2) // no RankAgent call
    const queued = events.find(
      (e) => e.type === 'tool_result' && e.name === 'queue_tracks'
    ) as Extract<AgentEvent, { type: 'tool_result' }>
    assert.equal(queued.stats?.accepted, 0)
    const end = events.at(-1) as Extract<AgentEvent, { type: 'workflow_end' }>
    assert.equal(end.noMusic, true)
  })
})

describe('AIDJ loop — sub-agent prompt caching', () => {
  it('library slice stays identical while tracks get queued; exclusions go last', async () => {
    const systems: string[] = []
    const users: string[] = []
    const client = {
      chat: {
        completions: {
          create: async (b: { messages: { content: string }[] }) => {
            systems.push(b.messages[0].content)
            users.push(b.messages[1].content)
            // Tries to return a queued track and a fresh one.
            return {
              choices: [
                { message: { content: `${ids.idOf('C418 - Sweden')}\n${ids.idOf('陈粒 - 小半')}` } }
              ]
            }
          }
        }
      }
    } as unknown as OpenAI
    const c = ctx({ client, formatLibrary: (keys) => (keys ?? []).slice().sort().join('\n') })
    await tool('ask_library_agent').run({ brief: 'x', scope: 'all' }, c)
    await tool('queue_tracks').run({ ids: [ids.idOf('C418 - Sweden')] }, c)
    const r = (await tool('ask_library_agent').run({ brief: 'x', scope: 'all' }, c)) as {
      results: { key: string }[]
    }
    assert.equal(systems[0], systems[1]) // cacheable prefix unchanged
    assert.match(users[1], new RegExp(`Do NOT pick.*${ids.idOf('C418 - Sweden')}`))
    assert.doesNotMatch(users[0], /Do NOT pick/)
    assert.deepEqual(
      r.results.map((x) => x.key),
      ['陈粒 - 小半']
    )
  })
})
