/**
 * VocabAgent (one call per field: tag cloud → canonical vocabulary + map) and
 * SanitizeAgent (songs that the map alone cannot fix → tags from the vocabulary).
 * Every output is validated in code (vocab.ts); nothing the model invents
 * outside the vocabulary is written.
 */
import type OpenAI from 'openai'
import type { AidjConfig, SongMeta } from '../types'
import { resolveLoopPrompts, renderTemplate } from '../loop/prompts'
import { agentModel } from '../loop/models'
import {
  repairFieldVocab,
  validateAgentFields,
  valuesOf,
  type CloudEntry,
  type FieldVocab,
  type SanitizeField,
  type TagVocab
} from './vocab'

const FIELD_RULES: Record<SanitizeField, string> = {
  emotion:
    'mood / feeling words (e.g. melancholic, nostalgic, energetic). Aim for a compact set that still separates moods well.',
  genre:
    'musical genres / styles. Merge sub-genre spellings, keep genuinely different styles apart.',
  language:
    'the sung language of a song, one value per song (e.g. Chinese, Cantonese, Japanese, English, Instrumental). Keep an explicit unknown value (e.g. "Unknown").',
  loudness: 'a coarse intensity scale, typically soft / medium / loud.'
}

/** Pull the first JSON object out of a reply (tolerates code fences / chatter). */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(clean.slice(start, end + 1))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface ProposeResult {
  field: SanitizeField
  vocab: FieldVocab
  unmapped: string[]
  badTargets: string[]
  promptTokens: number
  completionTokens: number
}

/** Fields with more tags than this are proposed in two phases (canonical, then chunked map). */
export const SINGLE_CALL_MAX_TAGS = 120
const MAP_CHUNK = 120
const MAP_PARALLEL = 4

export async function proposeFieldVocab(o: {
  client: OpenAI
  config: AidjConfig
  field: SanitizeField
  cloud: CloudEntry[]
  requirement: string
  /** Re-run with the user's review comments on the previous proposal. */
  feedback?: string
  previous?: FieldVocab
  timeoutMs: number
  signal?: AbortSignal
  /** Streaming progress: answer chars / reasoning chars so far (all calls of this field). */
  onProgress?: (chars: number, thinking: number) => void
}): Promise<ProposeResult> {
  const prompts = resolveLoopPrompts(o.config)
  const requirement = o.requirement.trim() || '(none — use English)'
  const feedback = o.feedback?.trim()
    ? `\n### PREVIOUS PROPOSAL\n${JSON.stringify({ canonical: o.previous?.canonical ?? [] })}\n\n### USER FEEDBACK ON IT\n${o.feedback.trim()}\n(Revise the vocabulary accordingly.)`
    : ''
  const fieldRule = FIELD_RULES[o.field]
  const cloudText = (list: CloudEntry[]): string =>
    list.map((e) => `${e.tag} — ${e.count}`).join('\n')

  // Progress across several (parallel) calls of this field.
  const parts = new Map<number, [number, number]>()
  const progressOf = (id: number) => (chars: number, thinking: number) => {
    parts.set(id, [chars, thinking])
    let c = 0
    let th = 0
    for (const [a, b] of parts.values()) {
      c += a
      th += b
    }
    o.onProgress?.(c, th)
  }
  let promptTokens = 0
  let completionTokens = 0
  let callId = 0
  const ask = async (
    system: string,
    user: string,
    what: string
  ): Promise<Record<string, unknown>> => {
    const res = await o.client.chat.completions.create(
      {
        model: agentModel(o.config, 'vocab'),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        response_format: { type: 'json_object' },
        // Streamed so the UI can show that a long field is progressing.
        stream: true,
        stream_options: { include_usage: true }
      },
      { timeout: o.timeoutMs, signal: o.signal }
    )
    const r = await collect(res, progressOf(callId++))
    promptTokens += r.promptTokens
    completionTokens += r.completionTokens
    if (r.finishReason === 'length') {
      throw new Error(`VocabAgent (${o.field}, ${what}): 输出超过模型单次输出上限被截断`)
    }
    const json = parseJsonObject(r.text)
    if (!json) {
      throw new Error(
        `VocabAgent (${o.field}, ${what}): 回复不是合法 JSON（结尾: ${r.text.slice(-80).replace(/\s+/g, ' ')}）`
      )
    }
    return json
  }

  let raw: { canonical?: unknown; map?: unknown }
  if (o.cloud.length <= SINGLE_CALL_MAX_TAGS) {
    raw = await ask(
      renderTemplate(prompts.tag_vocab, { field: o.field, fieldRule }),
      renderTemplate(prompts.tag_vocab_user, {
        requirement,
        field: o.field,
        cloud: cloudText(o.cloud),
        feedback
      }),
      'vocabulary'
    )
  } else {
    // Phase 1: the canonical set alone (short output).
    const head = await ask(
      renderTemplate(prompts.tag_vocab_canonical, { field: o.field, fieldRule }),
      renderTemplate(prompts.tag_vocab_user, {
        requirement,
        field: o.field,
        cloud: cloudText(o.cloud),
        feedback
      }),
      'canonical'
    )
    const canonical = Array.isArray(head.canonical) ? head.canonical.map(String) : []
    if (!canonical.length) throw new Error(`VocabAgent (${o.field}): empty vocabulary`)
    // Phase 2: map the old tags in chunks, a few in parallel.
    const chunks: CloudEntry[][] = []
    for (let i = 0; i < o.cloud.length; i += MAP_CHUNK) chunks.push(o.cloud.slice(i, i + MAP_CHUNK))
    const system = renderTemplate(prompts.tag_vocab_map, {
      field: o.field,
      fieldRule,
      canonical: canonical.join(', ')
    })
    const map: Record<string, unknown> = {}
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(MAP_PARALLEL, chunks.length) }, async () => {
        for (;;) {
          const i = next++
          if (i >= chunks.length) return
          const part = await ask(
            system,
            renderTemplate(prompts.tag_vocab_map_user, { requirement, tags: cloudText(chunks[i]) }),
            `map ${i + 1}/${chunks.length}`
          )
          const m = part.map && typeof part.map === 'object' ? part.map : {}
          Object.assign(map, m)
        }
      })
    )
    raw = { canonical, map }
  }

  const { vocab, unmapped, badTargets } = repairFieldVocab(o.field, raw, o.cloud)
  if (!vocab.canonical.length) throw new Error(`VocabAgent (${o.field}): empty vocabulary`)
  return { field: o.field, vocab, unmapped, badTargets, promptTokens, completionTokens }
}

/** Read a streamed (or, from test doubles, plain) chat completion. */
async function collect(
  res: unknown,
  onProgress?: (chars: number, thinking: number) => void
): Promise<{
  text: string
  promptTokens: number
  completionTokens: number
  finishReason: string | null
}> {
  type Chunk = {
    choices?: {
      delta?: { content?: string | null; reasoning_content?: string | null }
      finish_reason?: string | null
    }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  }
  if (res && typeof (res as AsyncIterable<Chunk>)[Symbol.asyncIterator] === 'function') {
    let text = ''
    let thinking = 0
    let promptTokens = 0
    let completionTokens = 0
    let finishReason: string | null = null
    let last = 0
    for await (const chunk of res as AsyncIterable<Chunk>) {
      const c = chunk.choices?.[0]
      const d = c?.delta
      if (d?.content) text += d.content
      if (d?.reasoning_content) thinking += d.reasoning_content.length
      if (c?.finish_reason) finishReason = c.finish_reason
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? 0
        completionTokens = chunk.usage.completion_tokens ?? 0
      }
      if (onProgress && Date.now() - last > 500) {
        last = Date.now()
        onProgress(text.length, thinking)
      }
    }
    onProgress?.(text.length, thinking)
    return { text, promptTokens, completionTokens, finishReason }
  }
  const r = res as {
    choices?: { message?: { content?: string | null }; finish_reason?: string | null }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  return {
    text: r.choices?.[0]?.message?.content ?? '',
    promptTokens: r.usage?.prompt_tokens ?? 0,
    completionTokens: r.usage?.completion_tokens ?? 0,
    finishReason: r.choices?.[0]?.finish_reason ?? null
  }
}

export interface SanitizeInput {
  id: string
  name: string
  meta: SongMeta | undefined
  lyrics: string | null
}

export interface SanitizeOutput {
  id: string
  meta: Partial<SongMeta> | null
  invalid: string[]
}

function vocabBlock(vocab: TagVocab, fields: readonly SanitizeField[]): string {
  return fields
    .map((f) => {
      const fv = vocab.fields[f]
      return fv ? `- ${f}: ${fv.canonical.join(', ')}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

function songBlock(s: SanitizeInput, fields: readonly SanitizeField[]): string {
  const current: Record<string, string[]> = {}
  for (const f of fields) current[f] = valuesOf(s.meta, f)
  return JSON.stringify({
    id: s.id,
    title: s.name,
    current,
    review: s.meta?.review ?? null,
    lyrics_excerpt: s.lyrics ?? null
  })
}

/**
 * One SanitizeAgent call for 1+ songs. Invalid tags trigger ONE retry for the
 * affected songs (told what was wrong); still-invalid tags are dropped.
 */
export async function sanitizeSongs(o: {
  client: OpenAI
  config: AidjConfig
  vocab: TagVocab
  fields: readonly SanitizeField[]
  songs: SanitizeInput[]
  timeoutMs: number
  signal?: AbortSignal
  onUsage?: (prompt: number, completion: number) => void
}): Promise<SanitizeOutput[]> {
  const prompts = resolveLoopPrompts(o.config)
  const system = renderTemplate(prompts.sanitize_agent, {
    requirement: o.vocab.requirement.trim() || '(none — use English)',
    vocab: vocabBlock(o.vocab, o.fields)
  })
  const call = async (songs: SanitizeInput[], retry: string): Promise<Map<string, unknown>> => {
    const res = await o.client.chat.completions.create(
      {
        model: agentModel(o.config, 'sanitize'),
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: renderTemplate(prompts.sanitize_agent_user, {
              fields: o.fields.join(', '),
              songs: songs.map((s) => songBlock(s, o.fields)).join('\n'),
              retry
            })
          }
        ],
        response_format: { type: 'json_object' }
      },
      { timeout: o.timeoutMs, signal: o.signal }
    )
    o.onUsage?.(res.usage?.prompt_tokens ?? 0, res.usage?.completion_tokens ?? 0)
    const obj = parseJsonObject(res.choices?.[0]?.message?.content ?? '')
    const list = Array.isArray(obj?.songs) ? (obj!.songs as unknown[]) : obj ? [obj] : []
    const byId = new Map<string, unknown>()
    for (const item of list) {
      const id = String((item as Record<string, unknown> | null)?.id ?? '')
      if (id) byId.set(id, item)
    }
    // A single-song reply without an id still belongs to that song.
    if (songs.length === 1 && !byId.size && list[0]) byId.set(songs[0].id, list[0])
    return byId
  }

  const results = new Map<string, SanitizeOutput>()
  const first = await call(o.songs, '')
  const again: SanitizeInput[] = []
  const notes: string[] = []
  for (const s of o.songs) {
    const raw = first.get(s.id) as Record<string, unknown> | undefined
    const v = raw ? validateAgentFields(raw, o.vocab, o.fields) : null
    const missing = !v || o.fields.some((f) => o.vocab.fields[f] && !(f in v.meta))
    if (!v || v.invalid.length || missing) {
      again.push(s)
      notes.push(
        `- ${s.id}: ${!raw ? 'missing from your reply' : [...(v?.invalid ?? []), ...(missing ? ['some fields missing'] : [])].join('; ')}`
      )
    }
    results.set(s.id, { id: s.id, meta: v?.meta ?? null, invalid: v?.invalid ?? [] })
  }
  if (again.length && !o.signal?.aborted) {
    const second = await call(
      again,
      `\n### FIX THESE (previous answer was invalid — use only vocabulary tags)\n${notes.join('\n')}`
    )
    for (const s of again) {
      const raw = second.get(s.id) as Record<string, unknown> | undefined
      if (!raw) continue
      const v = validateAgentFields(raw, o.vocab, o.fields)
      const prev = results.get(s.id)!
      results.set(s.id, { id: s.id, meta: { ...(prev.meta ?? {}), ...v.meta }, invalid: v.invalid })
    }
  }
  return o.songs.map((s) => results.get(s.id)!)
}
