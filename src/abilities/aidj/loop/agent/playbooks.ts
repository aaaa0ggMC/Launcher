/**
 * Playbooks (范式) of the DJ loop kernel — reusable procedures such as
 * "start from a lyric / song" or "an artist's songs".
 *
 * The kernel's system prompt only lists the catalogue (`id — when`); it calls
 * `use_playbook(id)` to fetch the full steps, so adding playbooks does not
 * bloat every request.
 *
 * Sources, later wins (same id replaces):
 *   1. built-ins — `loop/playbooks/*.md` (frontmatter `id` / `title` / `when`, body = steps)
 *   2. code — `registerDjPlaybook()`
 *   3. user — `preferences.loop_playbooks` in the AIDJ config
 * `preferences.loop.disabled_playbooks` hides ids.
 */
import type { AidjConfig } from '../../types'
import type { LoopPolicy } from '../policy'
import { loopAssets } from '../assets'

/** 批次阶段（与 planner 的 BatchPhase 一致）：initial = 用户的首次请求，directed = 用户的新方向，autonomous = 无人干预的续播 */
export type PlaybookPhase = 'initial' | 'directed' | 'autonomous'
const PHASES: readonly PlaybookPhase[] = ['initial', 'directed', 'autonomous']

export interface DjPlaybook {
  id: string
  title: string
  /** When the kernel should choose it (shown in the catalogue). */
  when: string
  /** The procedure, returned by `use_playbook`. */
  steps: string
  /**
   * 只在这些批次阶段列给 LLM（缺省 = 所有阶段）。例如 radio_flow 只适合 `autonomous`：
   * 描述里写了「无新要求时才用」，但 LLM 对「随便来点」这类没有锚点的用户请求仍会挑它，
   * 所以由代码把不适用的范式直接藏起来，而不是指望 LLM 守住描述。
   */
  phases?: PlaybookPhase[]
}

/** `phases: initial, directed` → ['initial','directed']；全是非法值 / 空 → undefined（= 所有阶段） */
function parsePhases(raw: unknown): PlaybookPhase[] | undefined {
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
    .map((x) => String(x).trim())
    .filter((x): x is PlaybookPhase => (PHASES as readonly string[]).includes(x))
  return list.length ? list : undefined
}

/** Parse `---\nid: x\ntitle: y\nwhen: z\n---\nbody`. */
export function parsePlaybook(text: string, fallbackId: string): DjPlaybook | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'))
  const head: Record<string, string> = {}
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':')
      if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  }
  const steps = (m ? m[2] : text).trim()
  const id = head.id || fallbackId
  if (!id || !steps) return null
  const phases = parsePhases(head.phases)
  return {
    id,
    title: head.title || id,
    when: head.when || '',
    steps,
    ...(phases ? { phases } : {})
  }
}

const registered = new Map<string, DjPlaybook>()

/** Inject a playbook from code. Re-registering an id replaces it. */
export function registerDjPlaybook(p: DjPlaybook): void {
  registered.set(p.id, p)
}

function valid(p: unknown): p is DjPlaybook {
  const o = p as Partial<DjPlaybook> | null
  return !!o && typeof o.id === 'string' && !!o.id && typeof o.steps === 'string' && !!o.steps
}

/** Every active playbook, built-in → code → config, minus disabled ids. */
export function resolvePlaybooks(
  config: AidjConfig | null | undefined,
  policy: LoopPolicy,
  /** 当前批次阶段；给了就按各范式的 `phases` 过滤，缺省 = 不过滤（预览 / 设置页用） */
  phase?: PlaybookPhase
): DjPlaybook[] {
  const all = new Map<string, DjPlaybook>()
  for (const [name, text] of Object.entries(loopAssets('playbooks'))) {
    const p = parsePlaybook(text, name)
    if (p) all.set(p.id, p)
  }
  for (const p of registered.values()) all.set(p.id, p)
  const user = config?.preferences?.loop_playbooks
  if (Array.isArray(user)) {
    for (const p of user) {
      if (valid(p)) {
        const phases = parsePhases((p as { phases?: unknown }).phases)
        all.set(p.id, { ...p, title: p.title || p.id, when: p.when || '', phases })
      }
    }
  }
  const off = new Set(policy.disabled_playbooks)
  return [...all.values()].filter(
    (p) => !off.has(p.id) && (!phase || !p.phases || p.phases.includes(phase))
  )
}

/** Catalogue lines for the system prompt. */
export function playbookCatalogue(list: DjPlaybook[]): string {
  if (!list.length) return '(none)'
  return list.map((p) => `- ${p.id} — ${p.title}: ${p.when}`).join('\n')
}
