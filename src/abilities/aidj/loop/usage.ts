/**
 * Token usage accounting shared by the agents and the views (pure — the
 * renderer imports it too). Cached = prompt tokens served from the provider's
 * prompt cache (DeepSeek `prompt_cache_hit_tokens`, OpenAI
 * `prompt_tokens_details.cached_tokens`).
 */

export interface UsageTotals {
  prompt: number
  completion: number
  cached: number
}

/** Cumulative usage, plus the same split per agent role (loop / lib / dream / rank / text …). */
export interface UsageBreakdown extends UsageTotals {
  byAgent: Record<string, UsageTotals>
}

export function emptyUsage(): UsageBreakdown {
  return { prompt: 0, completion: 0, cached: 0, byAgent: {} }
}

/** Read an OpenAI-compatible `usage` object (any provider dialect). */
export function readUsage(u: unknown): UsageTotals {
  const x = (u ?? {}) as {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number } | null
  }
  return {
    prompt: Number(x.prompt_tokens) || 0,
    completion: Number(x.completion_tokens) || 0,
    cached: Number(x.prompt_tokens_details?.cached_tokens ?? x.prompt_cache_hit_tokens) || 0
  }
}

/** Add `u` (for `agent`) into `into` — mutates and returns it. */
export function addUsage(into: UsageBreakdown, agent: string, u: UsageTotals): UsageBreakdown {
  into.prompt += u.prompt
  into.completion += u.completion
  into.cached += u.cached
  const a = (into.byAgent[agent] ??= { prompt: 0, completion: 0, cached: 0 })
  a.prompt += u.prompt
  a.completion += u.completion
  a.cached += u.cached
  return into
}

export function mergeUsage(a: UsageBreakdown, b: UsageBreakdown): UsageBreakdown {
  const out = JSON.parse(JSON.stringify(a)) as UsageBreakdown
  for (const [agent, u] of Object.entries(b.byAgent)) addUsage(out, agent, u)
  return out
}

/** `after − before` (one turn's usage). */
export function diffUsage(after: UsageBreakdown, before: UsageBreakdown): UsageBreakdown {
  const out = emptyUsage()
  for (const [agent, a] of Object.entries(after.byAgent)) {
    const b = before.byAgent[agent] ?? { prompt: 0, completion: 0, cached: 0 }
    const d = {
      prompt: Math.max(0, a.prompt - b.prompt),
      completion: Math.max(0, a.completion - b.completion),
      cached: Math.max(0, a.cached - b.cached)
    }
    if (d.prompt || d.completion || d.cached) addUsage(out, agent, d)
  }
  return out
}

export interface TurnContext {
  prompt: number
  completion: number
}

/**
 * Rebuild a session's usage from its history lines: each assistant line's own
 * `usage` (+ `context`); lines written before that existed fall back to the
 * usage events of the workflow line in front of them (agent mode).
 */
export function usageFromHistory(
  raw: {
    type?: string
    usage?: UsageBreakdown
    context?: TurnContext
    workflow?: Record<string, unknown>[]
  }[]
): { usage: UsageBreakdown; context: TurnContext } {
  let usage = emptyUsage()
  let context: TurnContext = { prompt: 0, completion: 0 }
  let pending: { usage: UsageBreakdown; lastLoop: TurnContext | null } | null = null
  for (const m of raw) {
    if (m.type === 'workflow' && Array.isArray(m.workflow)) {
      const u = emptyUsage()
      let lastLoop: TurnContext | null = null
      for (const e of m.workflow) {
        if (e.type !== 'usage') continue
        const t = {
          prompt: Number(e.prompt) || 0,
          completion: Number(e.completion) || 0,
          cached: Number(e.cached) || 0
        }
        addUsage(u, String(e.agent ?? 'loop'), t)
        if (e.agent === 'loop') lastLoop = { prompt: t.prompt, completion: t.completion }
      }
      pending = { usage: u, lastLoop }
      continue
    }
    if (m.type !== 'both') continue
    if (m.usage) usage = mergeUsage(usage, m.usage)
    else if (pending) usage = mergeUsage(usage, pending.usage)
    const ctx = m.context ?? pending?.lastLoop
    if (ctx) context = { prompt: ctx.prompt, completion: ctx.completion }
    pending = null
  }
  return { usage, context }
}
