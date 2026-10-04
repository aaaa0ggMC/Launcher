/**
 * DJ loop kernel — a standard tool-calling agent loop for ONE batch:
 *   LLM → tool calls → results fed back → … until a reply without tool calls
 *   (the DJ intro). The batch is whatever `queue_tracks` staged.
 * Every step is reported through `onEvent` so the chat view can show it.
 */
import type OpenAI from 'openai'
import { activeDjTools, toOpenAiTools, type DjToolContext } from './tools'
import { addUsage, emptyUsage, readUsage, type UsageBreakdown, type UsageTotals } from '../usage'
import './builtin-tools'
import './listening-tools'
import './web-search'

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam

/**
 * Workflow events (one batch = one `workflow_start` … `workflow_end`). `batch`
 * is stamped by `runAgentWorkflow` so views can group the events per batch.
 */
export type AgentEvent = { batch?: string } & (
  | {
      type: 'workflow_start'
      phase: string
      goal: string
      startedAt: number
    }
  | { type: 'agent_step'; step: number; max: number }
  /** Token usage of one LLM call (kernel or sub-agent), for live totals. */
  | { type: 'usage'; agent: string; prompt: number; completion: number; cached: number }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | {
      type: 'tool_result'
      id: string
      name: string
      ok: boolean
      /** Raw JSON (may be truncated). */
      result: string
      /** Untruncated summary numbers for the workflow card (see `resultStats`). */
      stats?: ResultStats
      ms: number
    }
  | {
      type: 'workflow_end'
      ok: boolean
      /** The turn was conversation only (`no_music`). */
      noMusic?: boolean
      candidates: number
      queued: number
      dropped: number
      steps: number
      ms: number
      error?: string
    }
)

export interface AgentRunOptions {
  ctx: DjToolContext
  model: string
  system: string
  /** Prior conversation (user / assistant text only). */
  history: { role: 'user' | 'assistant'; content: string }[]
  userPrompt: string
  maxSteps: number
  timeoutMs: number
  /** Wraps each LLM request (network retry). */
  retry: <T>(fn: (signal?: AbortSignal) => Promise<T>) => Promise<T>
  onEvent?: (e: AgentEvent) => void
}

export interface AgentRunResult {
  intro: string
  promptTokens: number
  completionTokens: number
  lastPromptTokens: number
  lastCompletionTokens: number
  steps: number
  /** All calls of this run (kernel + sub-agents), per agent. */
  usage: UsageBreakdown
}

export type ResultStats = Record<string, number | string | boolean>

/**
 * Compact, never-truncated facts about a tool result for the workflow card:
 * numbers / booleans / short strings as-is, arrays as their length. Nested
 * objects one level deep (e.g. `cloud.tracks` → `cloud.tracks`).
 */
export function resultStats(result: unknown): ResultStats {
  const out: ResultStats = {}
  if (Array.isArray(result)) {
    out.count = result.length
    return out
  }
  if (!result || typeof result !== 'object') return out
  const visit = (obj: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix + k
      if (typeof v === 'number' || typeof v === 'boolean') out[key] = v
      else if (typeof v === 'string') {
        if (v.length <= 80) out[key] = v
      } else if (Array.isArray(v)) out[key] = v.length
      else if (v && typeof v === 'object' && depth < 1) {
        visit(v as Record<string, unknown>, `${key}.`, depth + 1)
      }
    }
  }
  visit(result as Record<string, unknown>, '', 0)
  return out
}

/** Max chars of a tool result fed back to the model / shown in the UI. */
const RESULT_LIMIT = 12_000
const UI_RESULT_LIMIT = 4_000

function stripThink(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*/g, '')
    .trim()
}

export async function runAgentBatch(o: AgentRunOptions): Promise<AgentRunResult> {
  const tools = activeDjTools(o.ctx.policy, o.ctx.config)
  const byName = new Map(tools.map((t) => [t.name, t]))
  const oaTools = toOpenAiTools(tools)
  const messages: Msg[] = [
    { role: 'system', content: o.system },
    ...o.history.map((m) => ({ role: m.role, content: m.content }) as Msg),
    { role: 'user', content: o.userPrompt }
  ]
  const r: AgentRunResult = {
    intro: '',
    promptTokens: 0,
    completionTokens: 0,
    lastPromptTokens: 0,
    lastCompletionTokens: 0,
    steps: 0,
    usage: emptyUsage()
  }
  const count = (agent: string, u: UsageTotals): void => {
    addUsage(r.usage, agent, u)
    r.promptTokens = r.usage.prompt
    r.completionTokens = r.usage.completion
    o.onEvent?.({ type: 'usage', agent, ...u })
  }
  // Sub-requests (LibAgent / DreamAgent) count towards the same totals.
  const parentAdd = o.ctx.addUsage
  o.ctx.addUsage = (agent, u) => {
    count(agent, u)
    parentAdd(agent, u)
  }

  try {
    for (let step = 0; step <= o.maxSteps; step++) {
      if (o.ctx.signal?.aborted) break
      const last = step === o.maxSteps
      r.steps = step + 1
      o.onEvent?.({ type: 'agent_step', step: step + 1, max: o.maxSteps + 1 })
      const res = await o.retry((sig) =>
        o.ctx.client.chat.completions.create(
          {
            model: o.model,
            messages,
            tools: oaTools,
            // Out of steps: force the final reply.
            tool_choice: last ? 'none' : 'auto'
          },
          { timeout: o.timeoutMs, signal: sig }
        )
      )
      if (res.usage) {
        const u = readUsage(res.usage)
        r.lastPromptTokens = u.prompt
        r.lastCompletionTokens = u.completion
        count('loop', u)
      }
      const msg = res.choices?.[0]?.message
      if (!msg) break
      const calls = (msg.tool_calls ?? []).filter(
        (c): c is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
          c.type === 'function'
      )
      if (!calls.length || last) {
        r.intro = stripThink(msg.content ?? '')
        break
      }

      const assistant: Msg & Record<string, unknown> = {
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: calls
      }
      // DeepSeek thinking mode requires reasoning_content to be echoed back
      // inside a tool loop.
      const rc = (msg as unknown as { reasoning_content?: string }).reasoning_content
      if (rc) assistant.reasoning_content = rc
      messages.push(assistant)

      for (const call of calls) {
        const started = Date.now()
        let args: Record<string, unknown> = {}
        let result: unknown
        let ok = true
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
        } catch {
          ok = false
          result = { error: 'arguments are not valid JSON' }
        }
        o.onEvent?.({ type: 'tool_call', id: call.id, name: call.function.name, args })
        if (ok) {
          const tool = byName.get(call.function.name)
          if (!tool) {
            ok = false
            result = { error: `unknown tool: ${call.function.name}` }
          } else {
            try {
              result = await tool.run(args, o.ctx)
              if (result && typeof result === 'object' && 'error' in result) ok = false
            } catch (e) {
              if (o.ctx.signal?.aborted) throw e
              ok = false
              result = { error: String(e instanceof Error ? e.message : e) }
            }
          }
        }
        const text = JSON.stringify(result ?? null)
        const fed = text.length > RESULT_LIMIT ? `${text.slice(0, RESULT_LIMIT)}…(truncated)` : text
        messages.push({ role: 'tool', tool_call_id: call.id, content: fed })
        o.onEvent?.({
          type: 'tool_result',
          id: call.id,
          name: call.function.name,
          ok,
          result: text.length > UI_RESULT_LIMIT ? `${text.slice(0, UI_RESULT_LIMIT)}…` : text,
          stats: resultStats(result),
          ms: Date.now() - started
        })
      }
    }
  } finally {
    o.ctx.addUsage = parentAdd
  }
  return r
}
