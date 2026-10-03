/**
 * Turns the agent workflow event stream (`workflow_start` / `agent_step` /
 * `tool_call` / `tool_result` / `workflow_end`, see loop/agent/runner.ts) into
 * per-batch view models for `WorkflowCard.vue`. Pure — shared by the chat view
 * and the background-panel chat view.
 */
import { addUsage, emptyUsage, type UsageBreakdown, type UsageTotals } from '../loop/usage'

export type WfAgent = 'loop' | 'dream' | 'lib' | 'rank'
export type WfStatus = 'running' | 'ok' | 'error'

/** One line of a step: an i18n key + template vars (rendered by the card). */
export interface WfText {
  key: string
  vars: Record<string, string | number>
  fallback: string
}

export interface WfStep {
  id: string
  name: string
  agent: WfAgent
  status: WfStatus
  label: WfText
  summary: WfText | null
  args: unknown
  result?: string
  ms?: number
}

export interface WfView {
  batch: string
  goal: string
  phase: string
  startedAt: number
  status: WfStatus
  /** What is running now: the LoopAgent tool loop, the RankAgent, or nothing. */
  stage: 'loop' | 'rank' | 'done'
  playbook: string | null
  /** LoopAgent rounds so far (one LLM round-trip = one round, may call several tools). */
  step: number
  /** Round limit (max_steps + 1 forced final round) — a ceiling, not a target. */
  maxSteps: number
  steps: WfStep[]
  /** Tokens of every LLM call in this batch (kernel + sub-agents). */
  usage: UsageBreakdown
  end: {
    noMusic?: boolean
    candidates: number
    queued: number
    dropped: number
    steps: number
    ms: number
    error?: string
  } | null
}

type Ev = Record<string, unknown>
type Stats = Record<string, number | string | boolean>

const AGENT_OF: Record<string, WfAgent> = {
  dream_from_seeds: 'dream',
  ask_library_agent: 'lib',
  rank_agent: 'rank'
}

/** zh fallback labels — translated via `aidj.wf.tool.<name>`. */
const LABELS: Record<string, string> = {
  use_playbook: '选择范式',
  search_titles: '歌名检索',
  search_lyrics: '歌词检索',
  get_songs: '查看歌曲',
  tag_cloud: '标签云',
  filter_library: '标签过滤',
  search_library: '曲库检索',
  similar_to: '相似检索',
  recent_history: '最近播放',
  queue_tracks: '加入候选',
  unqueue_tracks: '移出候选',
  ask_library_agent: 'LibAgent 选歌',
  dream_from_seeds: 'DreamAgent 扩展',
  rank_agent: 'RankAgent 排序',
  web_search: '联网搜索',
  no_music: '仅对话',
  random_pick: '随机抽取'
}

function list(v: unknown): string[] {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]).map(String).filter(Boolean)
}

function short(s: string, n = 28): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

function quoted(v: unknown): string {
  const q = list(v)
  if (!q.length) return '—'
  const head = q
    .slice(0, 3)
    .map((x) => `“${short(x, 20)}”`)
    .join(' ')
  return q.length > 3 ? `${head} +${q.length - 3}` : head
}

function num(s: Stats | undefined, k: string): number | null {
  const v = s?.[k]
  return typeof v === 'number' ? v : null
}

/** Which filter fields were used: `-emotion(3) +language(1)`. */
function filterSpec(args: Record<string, unknown>): string {
  const parts: string[] = []
  if (args.reset === true) parts.push('reset')
  for (const [k, v] of Object.entries(args)) {
    const m = /^(keep|drop)_(\w+)$/.exec(k)
    if (!m) continue
    const n = list(v).length
    if (!n) continue
    parts.push(`${m[1] === 'keep' ? '+' : '−'}${m[2]}(${n})`)
  }
  return parts.join(' ') || '—'
}

function t(key: string, fallback: string, vars: Record<string, string | number> = {}): WfText {
  return { key: `aidj.wf.sum.${key}`, vars, fallback }
}

/** One-line human summary of a step (null while running / unknown tool). */
export function summarize(
  name: string,
  rawArgs: unknown,
  stats: Stats | undefined,
  ok: boolean
): WfText | null {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>
  if (!ok) {
    const err = stats?.error
    return t('error', '失败：{error}', { error: short(String(err ?? '?'), 60) })
  }
  if (!stats) return null
  const n = num(stats, 'total_matches') ?? num(stats, 'results') ?? num(stats, 'count') ?? 0
  switch (name) {
    case 'use_playbook':
      return t('playbook', '{id}', { id: String(stats.id ?? args.id ?? '') })
    case 'search_titles':
      return t('search', '{q} → {n} 首', { q: quoted(args.query), n })
    case 'search_lyrics':
      return t('lyrics', '{q} → {n} 首', { q: quoted(args.phrases), n })
    case 'get_songs':
      return args.include_lyrics === true
        ? t('songsLyrics', '{n} 首（含歌词）', { n })
        : t('songs', '{n} 首', { n })
    case 'tag_cloud':
      return t('cloud', '{n} 首候选', { n: num(stats, 'tracks') ?? 0 })
    case 'filter_library':
      return t('filter', '{before} → {after} 首 · {spec}', {
        before: num(stats, 'before') ?? '?',
        after: num(stats, 'after') ?? '?',
        spec: filterSpec(args)
      })
    case 'search_library':
      return t('searchLib', '{n} 首', { n })
    case 'similar_to':
      return t('similar', '{n} 首', { n })
    case 'recent_history':
      return t('recent', '{n} 首', { n })
    case 'queue_tracks':
      return t(args.pin_first === true ? 'queuePin' : 'queue', '+{a} · 拒绝 {r} · 共 {total}', {
        a: num(stats, 'accepted') ?? 0,
        r: num(stats, 'rejected') ?? 0,
        total: num(stats, 'queued_total') ?? 0
      })
    case 'unqueue_tracks':
      return t('unqueue', '−{n} · 共 {total}', {
        n: num(stats, 'removed') ?? 0,
        total: num(stats, 'queued_total') ?? 0
      })
    case 'ask_library_agent':
      return t('lib', '范围 {scope} 首 → {n} 首', { scope: num(stats, 'scope_size') ?? '?', n })
    case 'dream_from_seeds':
      return t('dream', '种子 {seeds} → {n} 首', { seeds: list(args.seeds).length, n })
    case 'no_music':
      return t('noMusic', '这一轮不选歌')
    case 'web_search':
      return t('web', '{q} → {n} 条结果', {
        q: quoted(args.query),
        n: num(stats, 'results') ?? 0
      })
    case 'random_pick':
      return args.queue === true
        ? t('randomQueued', '池内 {pool} 首 → 抽 {n} 首，加入 {a}', {
            pool: num(stats, 'pool_size') ?? '?',
            n: num(stats, 'picked') ?? 0,
            a: num(stats, 'queued.accepted') ?? 0
          })
        : t('random', '池内 {pool} 首 → 抽 {n} 首', {
            pool: num(stats, 'pool_size') ?? '?',
            n: num(stats, 'picked') ?? 0
          })
    case 'rank_agent':
      if (stats.fallback === true) {
        return t('rankFallback', '未解析到 RankAgent 的顺序，沿用前 {o} 首候选', {
          o: num(stats, 'order') ?? 0
        })
      }
      return t('rank', '{c} 选 {o} · 剔除 {d}', {
        c: num(stats, 'candidates') ?? 0,
        o: num(stats, 'order') ?? 0,
        d: num(stats, 'dropped') ?? 0
      })
    default:
      return null
  }
}

function blank(batch: string): WfView {
  return {
    batch,
    goal: '',
    phase: '',
    startedAt: 0,
    status: 'running',
    stage: 'loop',
    playbook: null,
    step: 0,
    maxSteps: 0,
    steps: [],
    usage: emptyUsage(),
    end: null
  }
}

/** Group events by batch, in order of first appearance. Events without a
 *  batch id (older sessions) go to a single implicit batch. */
export function buildWorkflows(events: Ev[]): WfView[] {
  const order: string[] = []
  const map = new Map<string, WfView>()
  const get = (b: string): WfView => {
    let v = map.get(b)
    if (!v) {
      v = blank(b)
      map.set(b, v)
      order.push(b)
    }
    return v
  }
  for (const e of events) {
    const type = e.type
    if (
      type !== 'workflow_start' &&
      type !== 'agent_step' &&
      type !== 'tool_call' &&
      type !== 'tool_result' &&
      type !== 'workflow_end' &&
      type !== 'usage'
    ) {
      continue
    }
    const v = get(typeof e.batch === 'string' ? e.batch : '_')
    if (type === 'usage') {
      addUsage(v.usage, String(e.agent ?? 'loop'), {
        prompt: Number(e.prompt) || 0,
        completion: Number(e.completion) || 0,
        cached: Number(e.cached) || 0
      })
    } else if (type === 'workflow_start') {
      v.goal = String(e.goal ?? '')
      v.phase = String(e.phase ?? '')
      v.startedAt = Number(e.startedAt) || 0
    } else if (type === 'agent_step') {
      v.step = Number(e.step) || 0
      v.maxSteps = Number(e.max) || 0
    } else if (type === 'tool_call') {
      const name = String(e.name ?? '')
      v.steps.push({
        id: String(e.id ?? v.steps.length),
        name,
        agent: AGENT_OF[name] ?? 'loop',
        status: 'running',
        label: {
          key: `aidj.wf.tool.${name}`,
          vars: {},
          fallback: LABELS[name] ?? name
        },
        summary: null,
        args: e.args
      })
      if (name === 'use_playbook') {
        const id = (e.args as Record<string, unknown> | undefined)?.id
        if (typeof id === 'string') v.playbook = id
      }
    } else if (type === 'tool_result') {
      const step = [...v.steps].reverse().find((s) => s.id === String(e.id))
      if (step) {
        const ok = e.ok !== false
        step.status = ok ? 'ok' : 'error'
        step.result = typeof e.result === 'string' ? e.result : undefined
        step.ms = Number(e.ms) || 0
        step.summary = summarize(step.name, step.args, e.stats as Stats | undefined, ok)
      }
    } else {
      v.status = e.ok === false ? 'error' : 'ok'
      v.end = {
        noMusic: e.noMusic === true,
        candidates: Number(e.candidates) || 0,
        queued: Number(e.queued) || 0,
        dropped: Number(e.dropped) || 0,
        steps: Number(e.steps) || 0,
        ms: Number(e.ms) || 0,
        error: typeof e.error === 'string' ? e.error : undefined
      }
      // Any step still "running" when the batch ended never got a result.
      for (const s of v.steps) if (s.status === 'running') s.status = 'error'
    }
  }
  for (const v of map.values()) {
    v.stage = v.end
      ? 'done'
      : v.steps.some((s) => s.agent === 'rank' && s.status === 'running')
        ? 'rank'
        : 'loop'
  }
  return order.map((b) => map.get(b)!)
}

/** The batch currently running (latest), if any. */
export function runningWorkflow(list: WfView[]): WfView | null {
  for (let i = list.length - 1; i >= 0; i--) if (list[i].status === 'running') return list[i]
  return null
}

/** Is this bt / chat data object a workflow event? */
export function isWorkflowEvent(d: unknown): boolean {
  const type = (d as Ev | null)?.type
  return (
    type === 'workflow_start' ||
    type === 'agent_step' ||
    type === 'tool_call' ||
    type === 'tool_result' ||
    type === 'workflow_end' ||
    type === 'usage'
  )
}

/** Usage of a list of workflow events, and the latest LoopAgent call (= context). */
export function usageOfEvents(events: Ev[]): {
  total: UsageBreakdown
  lastLoop: UsageTotals | null
} {
  const total = emptyUsage()
  let lastLoop: UsageTotals | null = null
  for (const e of events) {
    if (e.type !== 'usage') continue
    const u = {
      prompt: Number(e.prompt) || 0,
      completion: Number(e.completion) || 0,
      cached: Number(e.cached) || 0
    }
    addUsage(total, String(e.agent ?? 'loop'), u)
    if (e.agent === 'loop') lastLoop = u
  }
  return { total, lastLoop }
}

/** Active stage of a running batch, for the "thinking" bubble (`tr` renders WfText). */
export function runningStage(w: WfView, tr: (x: WfText) => string): string {
  if (w.stage === 'rank') {
    return tr({ key: 'aidj.wf.stage_rank', vars: {}, fallback: 'RankAgent 排序中…' })
  }
  const step = [...w.steps].reverse().find((s) => s.status === 'running')
  if (step) {
    // Sub-agent labels already name the agent ("DreamAgent 扩展").
    if (step.agent !== 'loop') return `${tr(step.label)}…`
    return tr({
      key: 'aidj.wf.stage_tool',
      vars: { agent: AGENT_LABEL[step.agent], tool: tr(step.label) },
      fallback: '{agent} · {tool}…'
    })
  }
  return tr({
    key: 'aidj.wf.stage_loop',
    vars: { n: w.step || 1 },
    fallback: 'LoopAgent 思考中 · 第 {n} 轮'
  })
}

export const AGENT_LABEL: Record<WfAgent, string> = {
  loop: 'LoopAgent',
  dream: 'DreamAgent',
  lib: 'LibAgent',
  rank: 'RankAgent'
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })}k`
  return n.toLocaleString()
}

export type ExportDetail = 'basic' | 'detailed' | 'advanced'

function fence(text: string): string {
  let body = text
  try {
    body = JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    /* keep raw (e.g. a truncated result) */
  }
  // The fence must be longer than any backtick run inside, or the content would close it.
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length))
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}json\n${body}\n${f}`
}

/**
 * Markdown of one batch for "copy / export as Markdown".
 * - detailed: header (playbook, rounds, calls, candidates → chosen, tokens, time) + one line per step
 * - advanced: + goal, per-agent tokens, and every step's arguments / result as JSON
 *   (RankAgent's result carries the drop reasons — review data, not shown elsewhere)
 * `tr` renders a WfText in the UI language.
 */
export function workflowToMarkdown(
  w: WfView,
  level: Exclude<ExportDetail, 'basic'>,
  tr: (x: WfText) => string
): string {
  const parts: string[] = []
  if (w.playbook) parts.push(w.playbook)
  if (w.end?.noMusic) {
    parts.push(
      tr({
        key: 'aidj.wf.result_chat',
        vars: { rounds: w.end.steps, tools: w.steps.length },
        fallback: '仅对话 · {rounds} 轮 · {tools} 次调用'
      })
    )
  } else if (w.end) {
    parts.push(
      tr({
        key: 'aidj.wf.result',
        vars: {
          rounds: w.end.steps,
          tools: w.steps.length,
          c: w.end.candidates,
          q: w.end.queued,
          d: w.end.dropped
        },
        fallback: '{rounds} 轮 · {tools} 次调用 · 候选 {c} → 入选 {q} · 剔除 {d}'
      })
    )
    if (w.end.error) parts.push(`⚠ ${w.end.error}`)
  }
  const tokens = w.usage.prompt + w.usage.completion
  if (tokens) parts.push(`${formatTokens(tokens)} tokens`)
  if (w.end) parts.push(formatMs(w.end.ms))

  const out: string[] = []
  out.push(`> **Workflow** · ${parts.join(' · ')}`)
  if (level === 'advanced' && w.goal) out.push(`> ${w.goal.replace(/\n+/g, ' ')}`)
  out.push('>')
  w.steps.forEach((s, i) => {
    const agent = AGENT_LABEL[s.agent]
    const summary = s.summary ? `：${tr(s.summary)}` : ''
    const ms = s.ms != null ? ` (${formatMs(s.ms)})` : ''
    const mark = s.status === 'error' ? ' ✗' : ''
    out.push(`> ${i + 1}. ${agent} · ${tr(s.label)}${summary}${ms}${mark}`)
  })
  if (level === 'advanced') {
    const agents = Object.entries(w.usage.byAgent)
    if (agents.length) {
      out.push('>')
      out.push(
        `> Tokens: ${agents
          .map(
            ([a, u]) =>
              `${a} ${formatTokens(u.prompt)} in (${formatTokens(u.cached)} cached) / ${formatTokens(u.completion)} out`
          )
          .join(' · ')}`
      )
    }
    out.push('')
    w.steps.forEach((s, i) => {
      out.push(`**${i + 1}. ${AGENT_LABEL[s.agent]} · ${s.name}**`)
      out.push('')
      out.push(fence(JSON.stringify(s.args ?? null)))
      if (s.result != null) {
        out.push('')
        out.push(fence(s.result))
      }
      out.push('')
    })
  }
  return out.join('\n').trim()
}
