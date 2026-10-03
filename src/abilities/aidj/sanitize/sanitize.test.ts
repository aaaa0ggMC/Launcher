import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type OpenAI from 'openai'
import type { SongMeta } from '../types'
import { DEFAULT_AIDJ_CONFIG } from '../types'
import {
  applyVocab,
  buildClouds,
  repairFieldVocab,
  validateAgentFields,
  vocabPromptHint,
  type TagVocab
} from './vocab'
import { parseJsonObject, proposeFieldVocab, sanitizeSongs, SINGLE_CALL_MAX_TAGS } from './agents'

const songs: Record<string, SongMeta> = {
  a: {
    emotion: ['Melancholic', 'nostalgic'],
    genre: 'Mandopop',
    language: 'Chinese',
    loudness: 'soft'
  },
  b: {
    emotion: ['melancholy'],
    genre: ['C-Pop', 'ballad'],
    language: 'unknown',
    loudness: 'medium'
  },
  c: { emotion: ['vaporwave-ish'], genre: 'pop', language: '中文' }
}

function vocabFor(): TagVocab {
  const clouds = buildClouds(Object.values(songs))
  return {
    version: 1,
    createdAt: 1,
    requirement: '使用中文',
    fields: {
      emotion: repairFieldVocab(
        'emotion',
        {
          canonical: ['忧郁', '怀旧'],
          map: { Melancholic: ['忧郁'], melancholy: ['忧郁'], nostalgic: ['怀旧'] }
        },
        clouds.emotion
      ).vocab,
      language: repairFieldVocab(
        'language',
        { canonical: ['中文', '英语'], map: { Chinese: ['中文'], 中文: ['中文'] } },
        clouds.language
      ).vocab
    }
  }
}

describe('AIDJ sanitize — vocabulary', () => {
  it('clouds merge case variants and keep the common spelling', () => {
    const c = buildClouds([...Object.values(songs), { emotion: 'melancholic' }])
    assert.deepEqual(c.emotion[0], { tag: 'Melancholic', count: 2 })
    assert.equal(c.language.find((e) => e.tag === 'unknown')?.count, 1)
  })

  it('repair: drops invented targets, maps canonical to itself, adds Unknown to language', () => {
    const r = repairFieldVocab(
      'emotion',
      { canonical: ['忧郁', '忧郁 '], map: { melancholy: ['忧郁', '悲伤'] } },
      [
        { tag: 'melancholy', count: 1 },
        { tag: 'happy', count: 2 }
      ]
    )
    assert.deepEqual(r.vocab.canonical, ['忧郁'])
    assert.deepEqual(r.vocab.map.melancholy, ['忧郁'])
    assert.deepEqual(r.badTargets, ['melancholy → 悲伤'])
    assert.deepEqual(r.unmapped, ['happy'])
    const l = repairFieldVocab('language', { canonical: ['中文'], map: {} }, [])
    assert.ok(l.vocab.canonical.includes('Unknown'))
    assert.deepEqual(l.vocab.map.unknown, ['Unknown'])
  })

  it('applyVocab maps cleanly, flags unmapped tags and (optionally) unknown language', () => {
    const v = vocabFor()
    const a = applyVocab(songs.a, v)
    assert.deepEqual(a.meta.emotion, ['忧郁', '怀旧'])
    assert.equal(a.meta.language, '中文')
    assert.equal(a.meta.genre, 'Mandopop') // field not in the vocabulary → untouched
    assert.deepEqual(a.needs, [])
    const b = applyVocab(songs.b, v, { fillUnknownLanguage: true })
    assert.equal(b.meta.emotion, '忧郁')
    assert.equal(b.meta.language, 'Unknown')
    assert.deepEqual(b.needs, ['language:unknown'])
    assert.deepEqual(applyVocab(songs.b, v).needs, []) // unknown is acceptable
    const c = applyVocab(songs.c, v)
    assert.deepEqual(c.needs, ['emotion:vaporwave-ish'])
  })

  it('validates agent output against the vocabulary', () => {
    const r = validateAgentFields(
      { emotion: ['忧郁', 'melancholy', '狂喜'], language: 'unknown', genre: 'x' },
      vocabFor(),
      ['emotion', 'language']
    )
    assert.deepEqual(r.meta, { emotion: '忧郁', language: 'Unknown' })
    assert.deepEqual(r.invalid, ['emotion:狂喜'])
  })

  it('forward prompt hint lists the allowed tags', () => {
    const h = vocabPromptHint(vocabFor())
    assert.match(h, /"emotion": choose ONLY from \[忧郁, 怀旧\]/)
    assert.equal(vocabPromptHint(null), '')
  })
})

function fake(replies: string[]): {
  client: OpenAI
  bodies: { messages: { content: string }[] }[]
} {
  const bodies: { messages: { content: string }[] }[] = []
  const client = {
    chat: {
      completions: {
        create: async (b: { messages: { content: string }[] }) => {
          bodies.push(b)
          return { choices: [{ message: { content: replies.shift() ?? '' } }] }
        }
      }
    }
  } as unknown as OpenAI
  return { client, bodies }
}

describe('AIDJ sanitize — agents', () => {
  it('parses JSON wrapped in chatter / think blocks', () => {
    assert.deepEqual(parseJsonObject('<think>{x}</think>sure: ```json\n{"a":1}\n```'), { a: 1 })
    assert.equal(parseJsonObject('nope'), null)
  })

  it('VocabAgent: sends the cloud + requirement, repairs the reply', async () => {
    const { client, bodies } = fake([
      JSON.stringify({ canonical: ['忧郁'], map: { Melancholic: ['忧郁'], melancholy: ['忧郁'] } })
    ])
    const r = await proposeFieldVocab({
      client,
      config: DEFAULT_AIDJ_CONFIG,
      field: 'emotion',
      cloud: buildClouds(Object.values(songs)).emotion,
      requirement: '使用中文',
      timeoutMs: 1000
    })
    assert.match(bodies[0].messages[1].content, /Melancholic — 1/)
    assert.match(bodies[0].messages[1].content, /使用中文/)
    assert.deepEqual(r.unmapped.sort(), ['nostalgic', 'vaporwave-ish'])
  })

  it('VocabAgent: reads a streamed reply and reports progress', async () => {
    const body = JSON.stringify({ canonical: ['忧郁'], map: { Melancholic: ['忧郁'] } })
    const chunks = [
      { choices: [{ delta: { reasoning_content: 'hmm…' } }] },
      { choices: [{ delta: { content: body.slice(0, 10) } }] },
      { choices: [{ delta: { content: body.slice(10) } }] },
      { choices: [], usage: { prompt_tokens: 7, completion_tokens: 9 } }
    ]
    const client = {
      chat: {
        completions: {
          create: async () => ({
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) yield c
            }
          })
        }
      }
    } as unknown as OpenAI
    const progress: [number, number][] = []
    const r = await proposeFieldVocab({
      client,
      config: DEFAULT_AIDJ_CONFIG,
      field: 'emotion',
      cloud: [{ tag: 'Melancholic', count: 1 }],
      requirement: '',
      timeoutMs: 1000,
      onProgress: (c, th) => progress.push([c, th])
    })
    assert.deepEqual(r.vocab.canonical, ['忧郁'])
    assert.equal(r.completionTokens, 9)
    assert.deepEqual(progress.at(-1), [body.length, 'hmm…'.length])
  })

  it('VocabAgent: large fields go canonical-first, then the map in parallel chunks', async () => {
    const cloud = Array.from({ length: SINGLE_CALL_MAX_TAGS * 2 + 5 }, (_, i) => ({
      tag: `Pop${i}`,
      count: 1
    }))
    const calls: string[] = []
    const client = {
      chat: {
        completions: {
          create: async (b: { messages: { content: string }[] }) => {
            const sys = b.messages[0].content
            calls.push(sys.includes('Map old tags') ? 'map' : 'canonical')
            if (!sys.includes('Map old tags')) {
              return { choices: [{ message: { content: '{"canonical":["pop"]}' } }] }
            }
            const tags = [...b.messages[1].content.matchAll(/^(Pop\d+) — /gm)].map((m) => m[1])
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      map: Object.fromEntries(tags.map((t) => [t, ['pop']]))
                    })
                  }
                }
              ]
            }
          }
        }
      }
    } as unknown as OpenAI
    const r = await proposeFieldVocab({
      client,
      config: DEFAULT_AIDJ_CONFIG,
      field: 'genre',
      cloud,
      requirement: '',
      timeoutMs: 1000
    })
    assert.deepEqual(calls, ['canonical', 'map', 'map', 'map'])
    assert.deepEqual(r.vocab.canonical, ['pop'])
    assert.deepEqual(r.unmapped, [])
    assert.deepEqual(r.vocab.map.pop244, ['pop'])
  })

  it('VocabAgent: a truncated reply is reported as truncated', async () => {
    const client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: '{"canonical":["a",' }, finish_reason: 'length' }]
          })
        }
      }
    } as unknown as OpenAI
    await assert.rejects(
      proposeFieldVocab({
        client,
        config: DEFAULT_AIDJ_CONFIG,
        field: 'emotion',
        cloud: [{ tag: 'a', count: 1 }],
        requirement: '',
        timeoutMs: 1000
      }),
      /截断/
    )
  })

  it('SanitizeAgent: validates, retries the invalid song once, drops what stays invalid', async () => {
    const { client, bodies } = fake([
      JSON.stringify({
        songs: [
          { id: 's1', emotion: ['忧郁'], language: '中文' },
          { id: 's2', emotion: ['狂喜'], language: '英语' }
        ]
      }),
      JSON.stringify({ songs: [{ id: 's2', emotion: ['怀旧'], language: 'Unknown' }] })
    ])
    const out = await sanitizeSongs({
      client,
      config: DEFAULT_AIDJ_CONFIG,
      vocab: vocabFor(),
      fields: ['emotion', 'language'],
      songs: [
        { id: 's1', name: 'A - a', meta: songs.a, lyrics: '走在辽阔的森林里' },
        { id: 's2', name: 'C - c', meta: songs.c, lyrics: null }
      ],
      timeoutMs: 1000
    })
    assert.deepEqual(out[0].meta, { emotion: '忧郁', language: '中文' })
    assert.deepEqual(out[1].meta, { emotion: '怀旧', language: 'Unknown' })
    assert.equal(bodies.length, 2)
    assert.match(bodies[0].messages[1].content, /走在辽阔的森林里/)
    assert.match(bodies[1].messages[1].content, /s2: emotion:狂喜/)
    assert.doesNotMatch(bodies[1].messages[1].content, /"id":"s1"/)
  })
})
