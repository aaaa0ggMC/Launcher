/**
 * Command contract — the ability-injected command registry.
 *
 * Every ability owns a set of commands (`src/abilities/<id>/commands.ts`),
 * each exporting a `CommandSpec[]`. The main-process abilities loader
 * (`src/main/process/abilities-loader.ts`) globs those files and registers
 * them here, so adding a new ability only means adding a folder — never
 * editing a central switchboard.
 */

export interface CommandContext {
  /** --key value pairs (CLI) or structured object (UI via IPC). */
  named: Record<string, unknown>
  /** bare positional tokens (CLI). */
  positional: string[]
}

export interface CommandSpec {
  /** kebab-case, namespaced `<ability>.<command>` */
  name: string
  description: string
  usage?: string
  run: (ctx: CommandContext) => unknown | Promise<unknown>
  /**
   * Optional runtime gate — when it resolves false the command behaves as NOT
   * registered (the CLI/UI report an unknown command). Used for mode-gated
   * commands (e.g. MPRIS-only commands hidden in web-player mode) instead of
   * per-command `if` guards. Shared commands that exist in both modes keep the
   * normal dispatch (the gate is evaluated at every dispatch).
   */
  enabled?: () => boolean | Promise<boolean>
}
