/**
 * Tool registry of the DJ loop kernel (agent mode).
 *
 * Any module can inject a tool with `registerDjTool` — it becomes an OpenAI
 * function the kernel may call. Tools run in the main process with a
 * `DjToolContext` describing the current batch; they return plain JSON.
 * `preferences.loop.disabled_tools` hides tools by name.
 */
import type OpenAI from 'openai'
import type { AidjConfig, PlaylistEntry, SongMeta } from '../../types'
import type { LoopPolicy } from '../policy'
import type { LoopPrompts } from '../prompts'
import type { IdIndex } from './ids'
import type { LyricsIndex } from './lyrics-index'
import type { DjPlaybook } from './playbooks'
import type { UsageTotals } from '../usage'

export interface DjToolContext {
  config: AidjConfig
  client: OpenAI
  policy: LoopPolicy
  prompts: LoopPrompts
  metadata: Map<string, SongMeta>
  musicPaths: Map<string, string>
  /** Already played / queued in earlier batches (never requeue). */
  played: Set<string>
  /** Tracks queued for THIS batch, in order. Tools mutate it. */
  staged: PlaylistEntry[]
  /** Recently played keys, oldest first. */
  recent: string[]
  /** Track keys pinned to open the batch (queue_tracks pin_first), in order. */
  pinned: string[]
  /** Active playbooks (use_playbook). */
  playbooks: DjPlaybook[]
  /** Set by `no_music`: the user does not want music this turn (nothing gets queued). */
  noMusic?: boolean
  /** Whether the per-artist cap applies to this batch. */
  capArtists: boolean
  /** Fuzzy-resolve a (possibly slightly wrong) key to an exact library key. */
  resolveKey: (query: string) => string | null
  /** Short stable IDs (`#k3f9`) — tools return them, the model passes them back. */
  ids: IdIndex
  /**
   * This batch's candidate pool, narrowed by `filter_library` (null = every
   * unplayed track). search / similar / library agent work inside it.
   */
  pool: Set<string> | null
  /** Lyrics full-text index (built lazily on first use). */
  lyrics: () => LyricsIndex
  /** Mood-ordered library text of a subset (null = whole library), lines prefixed with IDs. */
  formatLibrary: (keys: string[] | null) => string
  /** Report token usage of sub-requests (agent role: lib / dream / …). */
  addUsage: (agent: string, usage: UsageTotals) => void
  signal?: AbortSignal
}

export interface DjTool {
  name: string
  description: string
  /** JSON schema of the arguments object. */
  parameters: Record<string, unknown>
  /** Hide the tool when this returns false (feature flag off, missing key…). */
  enabled?: (policy: LoopPolicy, config?: AidjConfig) => boolean
  run: (args: Record<string, unknown>, ctx: DjToolContext) => unknown | Promise<unknown>
}

const registry = new Map<string, DjTool>()

/** Inject a tool into the DJ kernel. Re-registering a name replaces it. */
export function registerDjTool(tool: DjTool): void {
  registry.set(tool.name, tool)
}

export function unregisterDjTool(name: string): void {
  registry.delete(name)
}

/** Tools available under `policy` / `config` (enabled and not disabled by config). */
export function activeDjTools(policy: LoopPolicy, config?: AidjConfig): DjTool[] {
  const off = new Set(policy.disabled_tools)
  return [...registry.values()].filter(
    (t) => !off.has(t.name) && (t.enabled?.(policy, config) ?? true)
  )
}

export function toOpenAiTools(tools: DjTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}
