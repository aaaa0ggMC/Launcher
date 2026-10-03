/**
 * Tunable knobs of the persistent DJ loop — read from `preferences.loop` in
 * `~/.config/LinuxCockpit/aidj/config.json`, every field optional. Always go
 * through `resolveLoopPolicy` (defaults + clamping) instead of the raw config.
 */
import type { AidjConfig } from '../types'
import type { LibraryOrder } from './diversity'

export type LoopMode = 'agent' | 'text'
export type FilterStrength = 'light' | 'medium' | 'strong'

export interface LoopPolicy {
  /** `agent`: tool-calling kernel that explores the library via tools (default).
   *  `text`: legacy single call with the whole library in the system prompt. */
  mode: LoopMode
  /** Max LLM round-trips (tool steps) per batch in agent mode. */
  max_steps: number
  /** Offer the `ask_library_agent` sub-agent tool (kernel picks its library scope). */
  library_agent: boolean
  /** Tool names to hide from the kernel. */
  disabled_tools: string[]
  /** Playbook ids to hide from the kernel. */
  disabled_playbooks: string[]
  /** Run the RankAgent after the kernel: orders / trims candidates and writes the DJ intro. */
  rank_agent: boolean
  /** With the RankAgent on, the kernel gathers batch_size × this many candidates. */
  candidate_factor: number
  /** How aggressively the kernel narrows the pool by tags. */
  filter_strength: FilterStrength
  /** Fetch the next batch when fewer than this many tracks remain queued. */
  refill_threshold: number
  /** Tracks requested per batch ("at least N"). */
  batch_size: number
  /** Abort a single LLM request after this many seconds. */
  fetch_timeout_sec: number
  /** How many recently played tracks (with their tags) the AI sees as context. */
  recent_window: number
  /** Played keys kept in memory (forbidden list for repeats). */
  memory_size: number
  /** From this batch number on (1-based), the original exclusions may relax. */
  relax_after: number
  /** Max tracks per artist in one autonomous batch (0 = unlimited). */
  max_per_artist: number
  /** Library order in the system prompt. */
  library_order: LibraryOrder
}

export const DEFAULT_LOOP_POLICY: LoopPolicy = {
  mode: 'agent',
  max_steps: 14,
  library_agent: true,
  disabled_tools: [],
  disabled_playbooks: [],
  rank_agent: true,
  candidate_factor: 2,
  filter_strength: 'medium',
  refill_threshold: 8,
  batch_size: 8,
  fetch_timeout_sec: 180,
  recent_window: 15,
  memory_size: 100,
  relax_after: 3,
  max_per_artist: 2,
  library_order: 'emotion'
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Candidates the kernel should gather for one batch. */
export function candidateTarget(p: LoopPolicy): number {
  return p.mode === 'agent' && p.rank_agent
    ? Math.ceil(p.batch_size * p.candidate_factor)
    : p.batch_size
}

function int(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.max(min, Math.min(max, Math.round(n)))
}

export function resolveLoopPolicy(config: AidjConfig | null | undefined): LoopPolicy {
  const raw = (config?.preferences?.loop ?? {}) as Partial<LoopPolicy>
  const d = DEFAULT_LOOP_POLICY
  const order: LibraryOrder =
    raw.library_order === 'genre' ||
    raw.library_order === 'alpha' ||
    raw.library_order === 'emotion'
      ? raw.library_order
      : d.library_order
  return {
    mode: raw.mode === 'text' || raw.mode === 'agent' ? raw.mode : d.mode,
    max_steps: int(raw.max_steps, d.max_steps, 1, 40),
    library_agent: typeof raw.library_agent === 'boolean' ? raw.library_agent : d.library_agent,
    disabled_tools: strings(raw.disabled_tools),
    disabled_playbooks: strings(raw.disabled_playbooks),
    rank_agent: typeof raw.rank_agent === 'boolean' ? raw.rank_agent : d.rank_agent,
    candidate_factor: Math.max(1, Math.min(4, Number(raw.candidate_factor) || d.candidate_factor)),
    filter_strength:
      raw.filter_strength === 'light' ||
      raw.filter_strength === 'medium' ||
      raw.filter_strength === 'strong'
        ? raw.filter_strength
        : d.filter_strength,
    refill_threshold: int(raw.refill_threshold, d.refill_threshold, 1, 50),
    batch_size: int(raw.batch_size, d.batch_size, 1, 50),
    fetch_timeout_sec: int(raw.fetch_timeout_sec, d.fetch_timeout_sec, 10, 1800),
    recent_window: int(raw.recent_window, d.recent_window, 0, 100),
    memory_size: int(raw.memory_size, d.memory_size, 10, 2000),
    relax_after: int(raw.relax_after, d.relax_after, 1, 100),
    max_per_artist: int(raw.max_per_artist, d.max_per_artist, 0, 50),
    library_order: order
  }
}
