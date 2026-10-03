/**
 * One agent-mode batch, end to end: LoopAgent (tool loop) → RankAgent.
 * Shared by the persistent chat (`PersistentSession`) and the instant chat
 * (`aidj.generate`). Every event carries the batch id so views can draw one
 * workflow card per batch.
 */
import type OpenAI from 'openai'
import type { AidjConfig, PlaylistEntry, SongMeta } from '../../types'
import type { LoopPolicy } from '../policy'
import { resolveLoopPrompts } from '../prompts'
import type { BatchPlan } from '../planner'
import { runAgentBatch, type AgentEvent } from './runner'
import { runRankAgent } from './rank'
import { resolvePlaybooks, type DjPlaybook } from './playbooks'
import { buildIdIndex, type IdIndex } from './ids'
import { buildLyricsIndex, type LyricsIndex } from './lyrics-index'
import type { DjToolContext } from './tools'
import { agentModel } from '../models'
import { addUsage, emptyUsage, mergeUsage, type UsageBreakdown } from '../usage'

/** The bits of DJSession the workflow needs (structural, avoids an import cycle). */
export interface WorkflowHelper {
  bestMatch: (query: string) => string | null
  formatLibrary: (subset: string[] | null, idOf?: (key: string) => string) => string
  buildAgentSystemPrompt: (playbooks: DjPlaybook[]) => string
  buildRankSystemPrompt: () => string
}

export interface WorkflowOptions {
  client: OpenAI
  config: AidjConfig
  policy: LoopPolicy
  plan: BatchPlan
  helper: WorkflowHelper
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  lyrics: Map<string, string>
  /** Played / queued keys, oldest first. */
  played: string[]
  /** Prior conversation (user / assistant text). */
  history: { role: 'user' | 'assistant'; content: string }[]
  /** Short goal shown on the workflow card. */
  goal: string
  retry: <T>(fn: (signal?: AbortSignal) => Promise<T>) => Promise<T>
  signal?: AbortSignal
  emit?: (e: AgentEvent) => void
  log?: { info: (m: string, d?: unknown) => void; warn: (m: string, d?: unknown) => void }
}

export interface WorkflowResult {
  playlist: PlaylistEntry[]
  intro: string
  /** The user wanted to talk, not listen (`no_music`): playlist is empty, intro is the reply. */
  noMusic: boolean
  /** True when the run failed (intro then carries the error). */
  failed: boolean
  /** Every LLM call of this batch, per agent. */
  usage: UsageBreakdown
  promptTokens: number
  completionTokens: number
  lastPromptTokens: number
  lastCompletionTokens: number
}

// -- per-library caches (shared by every session over the same library) ------

const idCache = new WeakMap<Map<string, string>, { sig: string; index: IdIndex }>()
const lyricsCache = new WeakMap<Map<string, string>, { sig: string; index: LyricsIndex }>()

export function getIdIndex(metadata: Map<string, SongMeta>, paths: Map<string, string>): IdIndex {
  const sig = `${metadata.size}:${paths.size}`
  const hit = idCache.get(paths)
  if (hit?.sig === sig) return hit.index
  const index = buildIdIndex([...metadata.keys()].filter((k) => paths.has(k)))
  idCache.set(paths, { sig, index })
  return index
}

export function getLyricsIndex(
  paths: Map<string, string>,
  lyrics: Map<string, string>
): LyricsIndex {
  const sig = `${paths.size}:${lyrics.size}`
  const hit = lyricsCache.get(lyrics)
  if (hit?.sig === sig) return hit.index
  const index = buildLyricsIndex(paths.keys(), paths, lyrics)
  lyricsCache.set(lyrics, { sig, index })
  return index
}

let batchSeq = 0

export async function runAgentWorkflow(o: WorkflowOptions): Promise<WorkflowResult> {
  const batch = `wf-${Date.now().toString(36)}-${++batchSeq}`
  const startedAt = Date.now()
  const emit = (e: AgentEvent): void => o.emit?.({ ...e, batch })
  const ids = getIdIndex(o.metadata, o.musicPaths)
  const staged: PlaylistEntry[] = []
  const playbooks = resolvePlaybooks(o.config, o.policy)
  const ctx: DjToolContext = {
    config: o.config,
    client: o.client,
    policy: o.policy,
    prompts: resolveLoopPrompts(o.config),
    metadata: o.metadata,
    musicPaths: o.musicPaths,
    played: new Set(o.played),
    staged,
    pinned: [],
    playbooks,
    recent: o.played,
    capArtists: o.plan.capArtists,
    resolveKey: (q) => o.helper.bestMatch(q),
    ids,
    pool: null,
    lyrics: () => getLyricsIndex(o.musicPaths, o.lyrics),
    // Same fields as the text-mode library (library_injects), ID-prefixed.
    formatLibrary: (keys) => o.helper.formatLibrary(keys, ids.idOf),
    addUsage: () => {},
    signal: o.signal
  }
  const out: WorkflowResult = {
    playlist: [],
    intro: '',
    noMusic: false,
    failed: false,
    usage: emptyUsage(),
    promptTokens: 0,
    completionTokens: 0,
    lastPromptTokens: 0,
    lastCompletionTokens: 0
  }
  let steps = 0
  let dropped = 0

  emit({ type: 'workflow_start', phase: o.plan.phase, goal: o.goal, startedAt })
  try {
    const r = await runAgentBatch({
      ctx,
      model: agentModel(o.config, 'loop'),
      system: o.helper.buildAgentSystemPrompt(playbooks),
      history: o.history,
      userPrompt: o.plan.prompt,
      maxSteps: o.policy.max_steps,
      timeoutMs: o.policy.fetch_timeout_sec * 1000,
      retry: o.retry,
      onEvent: emit
    })
    steps = r.steps
    out.usage = mergeUsage(out.usage, r.usage)
    out.lastPromptTokens = r.lastPromptTokens
    out.lastCompletionTokens = r.lastCompletionTokens
    out.promptTokens += r.promptTokens
    out.completionTokens += r.completionTokens
    out.playlist = staged
    out.intro = r.intro

    out.noMusic = !!ctx.noMusic
    // No tracks (conversation turn) → no RankAgent; the kernel's reply is the answer.
    if (o.policy.rank_agent && staged.length && !ctx.noMusic && !o.signal?.aborted) {
      const id = `rank-${batch}`
      const started = Date.now()
      emit({
        type: 'tool_call',
        id,
        name: 'rank_agent',
        args: { candidates: staged.length, pinned: ctx.pinned.length, note: r.intro }
      })
      try {
        const ranked = await runRankAgent({
          ctx,
          model: agentModel(o.config, 'rank'),
          system: o.helper.buildRankSystemPrompt(),
          instruction: o.plan.prompt,
          note: r.intro,
          candidates: staged,
          batchSize: o.policy.batch_size,
          timeoutMs: o.policy.fetch_timeout_sec * 1000,
          retry: o.retry
        })
        out.promptTokens += ranked.promptTokens
        out.completionTokens += ranked.completionTokens
        if (ranked.usage.prompt || ranked.usage.completion) {
          addUsage(out.usage, 'rank', ranked.usage)
          emit({ type: 'usage', agent: 'rank', ...ranked.usage })
        }
        out.playlist = ranked.playlist
        out.intro = ranked.intro
        dropped = ranked.dropped.length
        emit({
          type: 'tool_result',
          id,
          name: 'rank_agent',
          ok: true,
          // Drop reasons live here only — for review, never rendered as text.
          result: JSON.stringify({
            order: ranked.playlist.map((p) => `${ids.idOf(p.name)} ${p.name}`),
            dropped: ranked.dropped.map((k) => ({
              track: `${ids.idOf(k)} ${k}`,
              reason: ranked.dropReasons[k] ?? ''
            }))
          }),
          stats: {
            candidates: staged.length,
            order: ranked.playlist.length,
            dropped: ranked.dropped.length,
            fallback: ranked.fallback
          },
          ms: Date.now() - started
        })
      } catch (e) {
        if (o.signal?.aborted) throw e
        // Keep the kernel's candidates (pinned first) rather than losing the batch.
        o.log?.warn('rank agent failed', { error: String(e) })
        out.playlist = staged.slice(0, o.policy.batch_size)
        out.intro = ''
        emit({
          type: 'tool_result',
          id,
          name: 'rank_agent',
          ok: false,
          result: JSON.stringify({ error: String(e) }),
          stats: { error: String(e).slice(0, 80) },
          ms: Date.now() - started
        })
      }
    }
    o.log?.info('agent workflow done', {
      batch,
      steps,
      candidates: staged.length,
      queued: out.playlist.length,
      phase: o.plan.phase
    })
    emit({
      type: 'workflow_end',
      ok: true,
      noMusic: out.noMusic,
      candidates: staged.length,
      queued: out.playlist.length,
      dropped,
      steps,
      ms: Date.now() - startedAt
    })
    return out
  } catch (e) {
    const aborted = !!o.signal?.aborted
    emit({
      type: 'workflow_end',
      ok: false,
      candidates: staged.length,
      queued: aborted ? 0 : Math.min(staged.length, o.policy.batch_size),
      dropped: 0,
      steps,
      ms: Date.now() - startedAt,
      error: aborted ? 'aborted' : String(e)
    })
    if (aborted) return { ...out, playlist: [], intro: '' }
    // Keep what was staged before the failure — it was validated.
    return {
      ...out,
      playlist: staged.slice(0, o.policy.batch_size),
      intro: `⚠️ API 错误: ${String(e)}`,
      failed: true
    }
  }
}

/** Raw tool results longer than this are cut when a workflow is saved to history. */
const SAVED_RESULT_LIMIT = 1500

/**
 * A workflow as saved in history.jsonl (`type: 'workflow'`): the events with
 * long raw results cut. Summaries come from `stats`, which are kept intact.
 */
export function compactWorkflow(events: AgentEvent[]): Record<string, unknown>[] {
  return events.map((e) => {
    // RankAgent's result (order + drop reasons) is kept whole for later review.
    const limit = e.type === 'tool_result' && e.name === 'rank_agent' ? 20_000 : SAVED_RESULT_LIMIT
    if (e.type === 'tool_result' && e.result.length > limit) {
      return { ...e, result: `${e.result.slice(0, limit)}…` }
    }
    return { ...e }
  })
}

/** The history line for a workflow (or null when there were no events). */
export function workflowHistoryLine(events: AgentEvent[]): {
  role: 'system'
  content: string
  ts: number
  type: 'workflow'
  workflow: Record<string, unknown>[]
} | null {
  if (!events.length) return null
  return {
    role: 'system',
    content: '',
    ts: Date.now(),
    type: 'workflow',
    workflow: compactWorkflow(events)
  }
}
