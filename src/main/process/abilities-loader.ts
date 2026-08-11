import type { CommandSpec } from './commands/types'
import { registerAll, listCommands } from './commands/registry'
import { makeLogger } from './logger'

const log = makeLogger('abilities-loader')

/**
 * Built-in ability command loader.
 *
 * Every ability owns its commands in `src/abilities/<id>/commands.ts` (a
 * `CommandSpec[]` default export, plus an optional `platforms?: string[]`
 * named export mirroring the ability metadata). This loader globs those files
 * at build time and registers them into the central command registry — so
 * adding/removing an ability is a pure folder operation, no central
 * switchboard to edit.
 *
 * Platform filtering happens HERE, before registration: an ability that
 * declares `platforms` excluding the running platform is not loaded at all
 * (same rule the renderer applies to the sidebar), so its commands never
 * enter the registry and stay unreachable on incompatible platforms.
 */
const commandModules = import.meta.glob<{ default?: CommandSpec[]; platforms?: string[] }>(
  '../../abilities/*/commands.ts',
  { eager: true }
)

/** Register every built-in ability's commands. Call once at startup. */
export function registerAbilityCommands(): void {
  const loaded: string[] = []
  const failed: string[] = []
  const ignoredPlatform: string[] = []
  for (const key of Object.keys(commandModules).sort()) {
    const id = key.split('/').at(-2) ?? key
    const mod = commandModules[key]
    const specs = mod?.default
    if (!Array.isArray(specs)) {
      log.warn('missing default CommandSpec[] export, skip', { key })
      failed.push(id || key)
      continue
    }
    const ps = mod.platforms
    if (ps && ps.length > 0 && !ps.includes(process.platform)) {
      log.info('ability commands skipped (platform mismatch)', { ability: id, platforms: ps })
      ignoredPlatform.push(id)
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
  const total = loaded.length + failed.length + ignoredPlatform.length
  log.info(`ability commands registered (${loaded.length}/${total})`, {
    abilities: loaded,
    failed,
    ignoredPlatform
  })
  log.info(`total ${listCommands().length} commands across ${loaded.length} abilities`)
}
