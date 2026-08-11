/**
 * Startup hook registry — architectural.
 *
 * Framework startup is a fixed sequence in `src/main/index.ts`. Abilities that
 * need to self-start (file watchers, eager bindings) register an async hook
 * here from their own module (loaded via the abilities command loader); the
 * shell runs every hook once after command registration. No central list of
 * ability wiring is ever edited.
 */
type StartupHook = () => void | Promise<void>

const hooks: StartupHook[] = []

export function registerStartupHook(hook: StartupHook): void {
  hooks.push(hook)
}

/** Run every registered startup hook (called once, after commands load). */
export async function runStartupHooks(): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook()
    } catch (e) {
      console.error('[cockpit] startup hook failed:', e)
    }
  }
}
