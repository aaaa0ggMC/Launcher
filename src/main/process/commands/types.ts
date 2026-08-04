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
}
