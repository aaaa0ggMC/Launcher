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
 *
 * The sidebar/presence filtering (`platforms`, alphabetical order) lives in
 * the renderer loader (`src/abilities/index.ts`), which owns the ability
 * metadata. This loader only reports which ability command modules were found
 * and registered.
 */
const commandModules = import.meta.glob<{ default?: CommandSpec[] }>(
  '../../abilities/*/commands.ts',
  { eager: true }
)

/** Register every built-in ability's commands. Call once at startup. */
export function registerAbilityCommands(): void {
  const loaded: string[] = []
  const failed: string[] = []
  for (const key of Object.keys(commandModules).sort()) {
    const id = key.split('/').at(-2) ?? key
    const mod = commandModules[key]
    const specs = mod?.default
    if (!Array.isArray(specs)) {
      log.warn('missing default CommandSpec[] export, skip', { key })
      failed.push(id || key)
      continue
    }
    try {
      registerAll(specs)
      loaded.push(id || key)
    } catch (e) {
      log.error('register failed', { key, error: e instanceof Error ? e.message : String(e) })
      failed.push(id || key)
    }
  }
  log.info(`ability commands registered (${loaded.length}/${loaded.length + failed.length})`, {
    abilities: loaded,
    failed
  })
  log.info(`total ${listCommands().length} commands across ${loaded.length} abilities`)
}
