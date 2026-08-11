/**
 * Quick-action registry — framework-level, generic.
 *
 * Search/quick-launch (the nav-drawer search box + right-click context menu)
 * surface actions contributed by abilities, exactly like settings injection.
 * Each ability registers a provider via `registerQuickActionProvider` (called
 * from its index.ts at load); the shell aggregates the results and shows them
 * as searchable entries. Clicking one just asks the shell to `activate` the
 * owning ability with the action's opaque `target` — the ability decides what
 * the id means (e.g. "launch app X", "run action Y") and renders its own
 * confirm/transformer UI.
 *
 * A quick action may carry `children` (e.g. an app's clustered actions) that
 * surface in the right-click menu of a search result.
 */
export interface QuickAction {
  /** unique id within the ability (used for menu keys). */
  id: string
  /** owning ability id — the shell navigates there on activate. */
  ability: string
  label: string
  description?: string
  icon?: string
  /** display-only risk hint (darker = more dangerous). */
  risk?: 'low' | 'medium' | 'high'
  /** extra searchable terms (aliases, tags, ...). */
  keywords?: string[]
  /** opaque payload handed to the owning ability's activate handler. */
  target: Record<string, unknown>
  /** additional actions shown in the right-click menu. */
  children?: QuickAction[]
}

type QuickActionProvider = () => QuickAction[] | Promise<QuickAction[]>

const providers: QuickActionProvider[] = []

/** Register a provider of quick actions (call once, from an ability's index.ts). */
export function registerQuickActionProvider(provider: QuickActionProvider): void {
  providers.push(provider)
}

/** Collect every quick action contributed by all abilities. */
export async function getAllQuickActions(): Promise<QuickAction[]> {
  const out: QuickAction[] = []
  for (const provider of providers) {
    const items = await provider()
    out.push(...items)
  }
  return out
}
