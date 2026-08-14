/**
 * Single-launch (in-memory) session state for the settings page.
 *
 * Lives in its own module so it's truly module-scoped — it survives every
 * component remount. The settings page is NOT keep-alive'd (the keep-alive
 * `include` matches `cockpit-settings`, but the component name is
 * `CockpitSettings`), so component state would reset each visit. The SPA never
 * reloads during a session, so this is per-launch and never persisted to disk.
 */
export const settingsSessionMemory: {
  category: string | null
  scroll: number
} = { category: null, scroll: 0 }
