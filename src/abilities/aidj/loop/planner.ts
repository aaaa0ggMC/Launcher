/**
 * Builds the per-batch instruction of the persistent DJ loop. Pure: the same
 * function serves the real fetch and `aidj.loop-preview`.
 */
import type { SongMeta } from '../types'
import { candidateTarget, type LoopPolicy, type LoopMode } from './policy'
import { renderTemplate, type LoopPrompts } from './prompts'

export type BatchPhase = 'initial' | 'directed' | 'autonomous'

export interface BatchPlanInput {
  policy: LoopPolicy
  prompts: LoopPrompts
  /** Mode the session runs in (fixed at session start). */
  mode: LoopMode
  metadata: Map<string, SongMeta>
  initialPrompt: string
  /** Pending user direction (takes priority), or null. */
  userDirection: string | null
  /** Successful batches so far. */
  fetchCount: number
  /** Already played / queued keys, oldest first. */
  rollingHistory: string[]
}

export interface BatchPlan {
  phase: BatchPhase
  prompt: string
  /** Enforce the per-artist cap in code on this batch's result. */
  capArtists: boolean
}

function tags(v: string | string[] | undefined): string {
  if (!v) return '-'
  return Array.isArray(v) ? v.join('/') : v
}

/** Recent tracks with their mood tags, so the AI continues the MOOD, not the artist. */
export function formatRecent(names: string[], metadata: Map<string, SongMeta>): string {
  if (!names.length) return '(none)'
  return names
    .map((n) => {
      const m = metadata.get(n)
      return `- ${n} | ${tags(m?.emotion)} | ${tags(m?.genre)}`
    })
    .join('\n')
}

export function planBatch(input: BatchPlanInput): BatchPlan {
  const { policy, prompts } = input
  const phase: BatchPhase = input.userDirection
    ? 'directed'
    : input.fetchCount === 0
      ? 'initial'
      : 'autonomous'

  const vars = {
    goal: phase === 'directed' ? (input.userDirection ?? '') : input.initialPrompt,
    phase: input.fetchCount + 1,
    batchSize: policy.batch_size,
    maxPerArtist: policy.max_per_artist,
    recent: formatRecent(
      policy.recent_window > 0 ? input.rollingHistory.slice(-policy.recent_window) : [],
      input.metadata
    ),
    relaxHint: input.fetchCount < policy.relax_after ? prompts.relax_keep : prompts.relax_loose,
    played: input.rollingHistory.join(', '),
    candidateTarget: candidateTarget(policy),
    finishWhat:
      input.mode === 'agent' && policy.rank_agent
        ? 'the short handoff note for the RankAgent'
        : 'the DJ intro only',
    artistRule: ''
  }
  vars.artistRule = policy.max_per_artist > 0 ? renderTemplate(prompts.artist_rule, vars) : ''

  const head = renderTemplate(prompts[phase], vars)
  const rules = renderTemplate(
    input.mode === 'agent' ? prompts.agent_rules : prompts.rules,
    vars
  ).trimEnd()
  return {
    phase,
    prompt: `${head}\n\n${rules}`,
    // A user explicitly asking "only Jay Chou" must not be overridden by code;
    // the cap only guards the AI's own autonomous choices.
    capArtists: phase === 'autonomous' && policy.max_per_artist > 0
  }
}
