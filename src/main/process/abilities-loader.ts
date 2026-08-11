import type { CommandSpec } from './commands/types'
import { registerAll, listCommands } from './commands/registry'
import { makeLogger } from './logger'

const log = makeLogger('abilities-loader')

/**
 * Built-in ability command loader.
 *
 * Ability folder convention:
 *  - `meta.ts`     — metadata shared by BOTH processes (e.g. `platforms`)
 *  - `index.ts`    — frontend-only Ability metadata (component / settings)
 *  - `commands.ts` — backend-only CommandSpec[]
 *
 * This loader globs `commands.ts` (specs) and `meta.ts` (platforms), joined by
 * the ability folder id. Platform filtering happens HERE, before registration:
 * an ability whose `meta.ts` declares `platforms` excluding the running
 * platform is not loaded at all (same rule the renderer applies to the
 * sidebar), so its commands never enter the registry and stay unreachable on
 * incompatible platforms.
 */
const commandModules = import.meta.glob<{ default?: CommandSpec[] }>(
  '../../abilities/*/commands.ts',
  { eager: true }
)

const metaModules = import.meta.glob<{ platforms?: string[] }>('../../abilities/*/meta.ts', {
  eager: true
})

/** Resolve the shared meta for an ability folder id. */
function abilityMeta(id: string): { platforms?: string[] } {
  return metaModules[`../../abilities/${id}/meta.ts`] ?? {}
}

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
    const ps = abilityMeta(id).platforms
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
