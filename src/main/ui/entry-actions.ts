import type { AppEntry, AppAction } from '@abilities/apps/types'

/**
 * Entry action injection — framework-level, generic.
 *
 * The quick-launch context menu (and any future surface that shows "what can I
 * do with this app") collects actions from every ability, exactly like settings
 * injection. Each ability registers a provider via `registerEntryActionProvider`
 * (called from its index.ts at load); App.vue aggregates and executes the
 * results through the same risk-aware launch pipeline.
 *
 * Three action kinds, all declarative (no closures → stays CLI-first):
 *  - `launch`  — run the entry's main exec (entry.exec)
 *  - `action`  — run one of the entry's clustered actions (entry.actions[id])
 *  - `command` — invoke any registered ability command, for external buttons
 */
export type EntryAction =
  | { kind: 'launch'; id: string; label: string; icon?: string }
  | { kind: 'action'; id: string; label: string; icon?: string; action: AppAction }
  | {
      kind: 'command'
      id: string
      label: string
      icon?: string
      command: string
      args?: Record<string, unknown>
    }

export interface EntryActionContext {
  root: string
  id: string
  entry: AppEntry
}

type Provider = (ctx: EntryActionContext) => EntryAction[]

const providers: Provider[] = []

/** Register a provider of entry actions (call once, from an ability's index.ts). */
export function registerEntryActionProvider(provider: Provider): void {
  providers.push(provider)
}

/** All actions contributed by every ability for the given entry (deduped by id). */
export function getEntryActions(ctx: EntryActionContext): EntryAction[] {
  const seen = new Set<string>()
  const out: EntryAction[] = []
  for (const provider of providers) {
    for (const action of provider(ctx)) {
      if (seen.has(action.id)) continue
      seen.add(action.id)
      out.push(action)
    }
  }
  return out
}
