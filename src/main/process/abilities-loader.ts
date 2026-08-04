import type { CommandSpec } from './commands/types'
import { registerAll, listCommands } from './commands/registry'
import { makeLogger } from './logger'

const log = makeLogger('abilities-loader')

/**
 * Built-in ability command loader.
 *
 * Every ability owns its commands in `src/abilities/<id>/commands.ts` (a
 * `CommandSpec[]` default export). This loader globs those files at build time
 * and registers them into the central command registry — so adding/removing an
 * ability is a pure folder operation, no central switchboard to edit.
 */
const commandModules = import.meta.glob<{ default?: CommandSpec[] }>(
  '../../abilities/*/commands.ts',
  { eager: true }
)

/** Register every built-in ability's commands. Call once at startup. */
export function registerAbilityCommands(): void {
  const loaded: string[] = []
  for (const key of Object.keys(commandModules).sort()) {
    const mod = commandModules[key]
    const specs = mod?.default
    if (!Array.isArray(specs)) {
      log.warn('missing default CommandSpec[] export, skip', { key })
      continue
    }
    try {
      registerAll(specs)
      loaded.push(key)
    } catch (e) {
      log.error('register failed', { key, error: e instanceof Error ? e.message : String(e) })
    }
  }
  log.info(`registered ${listCommands().length} commands (${loaded.length} abilities)`)
}
