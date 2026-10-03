/**
 * RankAgent — the final stage of an agent batch. Gets every candidate the
 * kernel queued (with tags, review and lyric excerpt) plus the kernel's
 * handoff note; orders them, drops weak fits and writes the DJ intro.
 * Pinned tracks always open the batch (enforced in code, not just asked).
 */
import { SEPARATOR, type PlaylistEntry } from '../../types'
import { renderTemplate } from '../prompts'
import { describeTrack } from './builtin-tools'
import type { DjToolContext } from './tools'
import { readUsage, type UsageTotals } from '../usage'
import { makeLogger } from '../../../../main/process/logger'

const log = makeLogger('aidj-rank')

export interface RankInput {
  ctx: DjToolContext
  model: string
  /** Persona + extra rules + rank instructions. */
  system: string
  /** The batch instruction the kernel got (goal, phase, language rule). */
  instruction: string
  /** The kernel's final reply. */
  note: string
  candidates: PlaylistEntry[]
  /** Target batch length: the fallback keeps this many; a reply keeps at most 1.5×. */
  batchSize: number
  timeoutMs: number
  retry: <T>(fn: (signal?: AbortSignal) => Promise<T>) => Promise<T>
}

export interface RankResult {
  intro: string
  playlist: PlaylistEntry[]
  dropped: string[]
  promptTokens: number
  completionTokens: number
  usage: UsageTotals
  /** The reply had no usable order — the kernel's order was kept (capped). */
  fallback: boolean
  /** Why each dropped candidate was dropped (review only, never shown to the listener). */
  dropReasons: Record<string, string>
}

/** The separator, tolerating the usual model variations (`--- SONG LIST ---`, no brackets…). */
const SEPARATOR_RE = /\[?\s*-{2,}\s*SONG[_ ]?LIST\s*-{2,}\s*\]?/i
const DROPPED_RE = /\[?\s*-{2,}\s*DROPPED\s*-{2,}\s*\]?/i
const HASH_ID = /#([0-9a-z]{4})\b/gi
const BARE_ID = /(?:^|[^0-9a-z#])([0-9a-z]{4})(?![0-9a-z])/gi

function stripThink(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*/g, '')
    .trim()
}

/**
 * Parse "intro … SEPARATOR … ids" into intro + ordered candidate keys.
 * Tolerant: separator variants, several IDs per line, bare IDs (only when they
 * are a candidate's ID), titles; without any separator, the lines that name
 * candidates are taken as the list and removed from the intro.
 */
export function parseRankOutput(
  text: string,
  ctx: DjToolContext,
  candidates: PlaylistEntry[]
): { intro: string; order: string[]; reasons: Record<string, string> } {
  // Part 3 (drop reasons) is cut off first so its IDs never count as the order.
  const full = stripThink(text).replace(SEPARATOR, '[---SONG_LIST---]')
  const dm = DROPPED_RE.exec(full)
  const clean = dm ? full.slice(0, dm.index) : full
  const reasons: Record<string, string> = {}
  const allowed = new Set(candidates.map((c) => c.name))
  const keysIn = (line: string): string[] => {
    const out: string[] = []
    for (const m of line.matchAll(HASH_ID)) {
      const k = ctx.ids.keyOf(m[1])
      if (k && allowed.has(k)) out.push(k)
    }
    if (!out.length) {
      for (const m of line.matchAll(BARE_ID)) {
        const k = ctx.ids.keyOf(m[1])
        if (k && allowed.has(k)) out.push(k)
      }
    }
    if (!out.length) {
      const k = ctx.resolveKey(
        line
          .replace(/^[\s\-*\d.)]+/, '')
          .replace(/[`*]/g, '')
          .trim()
      )
      if (k && allowed.has(k)) out.push(k)
    }
    return out
  }
  const m = SEPARATOR_RE.exec(clean)
  let intro: string
  let lines: string[]
  if (m) {
    intro = clean.slice(0, m.index).trim()
    lines = clean.slice(m.index + m[0].length).split('\n')
  } else {
    // No separator: the lines naming candidates are the list.
    const all = clean.split('\n')
    lines = all.filter((l) => keysIn(l).length > 0)
    intro = all
      .filter((l) => !lines.includes(l))
      .join('\n')
      .trim()
  }
  const order: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    for (const k of keysIn(line)) if (!order.includes(k)) order.push(k)
  }
  if (dm) {
    for (const line of full.slice(dm.index + dm[0].length).split('\n')) {
      const k = keysIn(line)[0]
      if (!k) continue
      const reason = line
        .replace(/^[\s\-*\d.)]+/, '')
        .replace(HASH_ID, '')
        .replace(/^[\s|:：—–-]+/, '')
        .trim()
      if (reason) reasons[k] = reason.slice(0, 200)
    }
  }
  return { intro, order, reasons }
}

export async function runRankAgent(o: RankInput): Promise<RankResult> {
  const { ctx } = o
  const pinned = ctx.pinned.filter((k) => o.candidates.some((c) => c.name === k))
  const user = renderTemplate(ctx.prompts.rank_agent_brief, {
    instruction: o.instruction,
    note: o.note || '(none)',
    pinned: pinned.length ? pinned.map((k) => `- ${ctx.ids.idOf(k)} ${k}`).join('\n') : '(none)',
    candidates: o.candidates.map((c) => `- ${describeTrack(ctx, c.name, 6)}`).join('\n')
  })
  const res = await o.retry((sig) =>
    ctx.client.chat.completions.create(
      {
        model: o.model,
        messages: [
          { role: 'system', content: o.system },
          { role: 'user', content: user }
        ]
      },
      { timeout: o.timeoutMs, signal: sig }
    )
  )
  const reply = res.choices?.[0]?.message?.content ?? ''
  const { intro, order, reasons } = parseRankOutput(reply, ctx, o.candidates)
  const fallback = order.length === 0
  if (fallback) {
    log.warn('rank agent: no usable order, keeping the kernel order', {
      candidates: o.candidates.length,
      replyTail: reply.slice(-400)
    })
  }
  // An unparseable list must not lose the batch: the kernel's order, capped to
  // one batch. A parsed list is capped at 1.5× the batch (it was asked for ~1×).
  const cap = Math.max(1, fallback ? o.batchSize : Math.ceil(o.batchSize * 1.5))
  const chosen = fallback ? o.candidates.map((c) => c.name) : order
  const final = [...pinned, ...chosen.filter((k) => !pinned.includes(k))].slice(
    0,
    Math.max(cap, pinned.length)
  )
  const byName = new Map(o.candidates.map((c) => [c.name, c]))
  return {
    intro,
    playlist: final.map((k) => byName.get(k)!).filter(Boolean),
    dropped: o.candidates.map((c) => c.name).filter((k) => !final.includes(k)),
    promptTokens: res.usage?.prompt_tokens ?? 0,
    completionTokens: res.usage?.completion_tokens ?? 0,
    usage: readUsage(res.usage),
    fallback,
    dropReasons: Object.fromEntries(
      o.candidates
        .map((c) => c.name)
        .filter((k) => !final.includes(k))
        .map((k) => [
          k,
          reasons[k] ??
            (fallback
              ? '(RankAgent gave no usable order — not kept)'
              : order.includes(k)
                ? '(cut by the batch-size cap)'
                : '(no reason given)')
        ])
    )
  }
}
