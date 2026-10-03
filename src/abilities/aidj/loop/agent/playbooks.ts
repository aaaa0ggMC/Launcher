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

export interface DjPlaybook {
  id: string
  title: string
  /** When the kernel should choose it (shown in the catalogue). */
  when: string
  /** The procedure, returned by `use_playbook`. */
  steps: string
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
  return { id, title: head.title || id, when: head.when || '', steps }
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
  policy: LoopPolicy
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
      if (valid(p)) all.set(p.id, { ...p, title: p.title || p.id, when: p.when || '' })
    }
  }
  const off = new Set(policy.disabled_playbooks)
  return [...all.values()].filter((p) => !off.has(p.id))
}

/** Catalogue lines for the system prompt. */
export function playbookCatalogue(list: DjPlaybook[]): string {
  if (!list.length) return '(none)'
  return list.map((p) => `- ${p.id} — ${p.title}: ${p.when}`).join('\n')
}
