/** Composer SDK: extensions own their UI/state; the host owns text, focus and submission. */
import type { Ref } from 'vue'

export interface InputTrigger {
  /** Literal prefix, e.g. @, / or a keyword. */
  prefix: string
  /** Defaults to true: only match at the start or after whitespace. */
  boundary?: boolean
  maxQueryLength?: number
}

export interface InputTriggerMatch {
  prefix: string
  query: string
  start: number
  end: number
}

export function matchInputTrigger(
  text: string,
  caret: number,
  triggers: InputTrigger[]
): InputTriggerMatch | null {
  const before = text.slice(0, caret)
  for (const trigger of triggers) {
    if (!trigger.prefix) continue
    const start = before.lastIndexOf(trigger.prefix)
    if (start < 0) continue
    if (trigger.boundary !== false && start > 0 && !/\s/.test(before[start - 1])) continue
    const query = before.slice(start + trigger.prefix.length)
    if (/\s/.test(query) || query.includes(trigger.prefix)) continue
    if (query.length > (trigger.maxQueryLength ?? 64)) continue
    return { prefix: trigger.prefix, query, start, end: caret }
  }
  return null
}

export interface PluginInputHooks {
  triggers?: InputTrigger[]
  onTrigger?: (match: InputTriggerMatch | null) => void
  /** Return true to consume the event before the composer's Enter handling. */
  onKeyDown?: (event: KeyboardEvent) => boolean
  /** Add existing transport references, without bypassing backend permissions. */
  collect?: () => { mentions?: string[] }
  hasContent?: () => boolean
  reset?: () => void
  /**
   * Load references back into the composer (editing a sent message). Records are what the
   * message stored in `meta.mentions`; each extension picks the ones it understands.
   */
  restore?: (state: { mentions?: { ref: string; label: string; kind: string }[] }) => void
}

export interface PluginInputContext {
  draft: Ref<string>
  sessionId: Readonly<Ref<string>>
  /** Mount toolbar controls using Teleport after this target becomes available. */
  toolbarTarget: Ref<HTMLElement | null>
  focus: () => void
  selection: () => { start: number; end: number }
  replaceRange: (start: number, end: number, text: string) => void
  /** One registration per mounted extension; dispose on unmount. */
  register: (hooks: PluginInputHooks) => () => void
}

export interface PluginInputProps {
  context: PluginInputContext
}
