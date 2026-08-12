import type { CommandSpec } from './commands/types'
import type { AbilityMeta } from '../../shared/types'
import { registerAll, listCommands } from './commands/registry'
import { makeLogger } from './logger'

const log = makeLogger('abilities-loader')

/**
 * Built-in ability command loader.
 *
 * Ability folder convention:
 *  - `meta.ts`     — metadata shared by BOTH processes (`platforms`, `provides`, `dependencies`)
 *  - `index.ts`    — frontend-only Ability metadata (component / settings)
 *  - `commands.ts` — backend-only CommandSpec[]
 *
 * This loader globs `commands.ts` (specs) and `meta.ts` (platforms + capability
 * lexicon), joined by the ability folder id. Two filters happen HERE, before
 * registration:
 *
 *  1. Platform — an ability whose `meta.ts` declares `platforms` excluding the
 *     running platform is not loaded at all (same rule the renderer applies to
 *     the sidebar), so its commands never enter the registry.
 *  2. Capabilities — each ability tells the system the capabilities it provides
 *     (`provides`, its 能力辞典) and the ones it requires (`dependencies`). An
 *     ability is only registered when every required capability is provided by
 *     at least one resolvable ability. Removing the provider (e.g. the
 *     `background` ability behind `background-tasks`) therefore automatically
 *     disables every ability built on that capability, and the violation is
 *     reported.
 *
 * Dependencies are COMMAND dependencies, not initialization dependencies:
 * commands are flat specs in a registry, so a cycle (A needs cap provided by B,
 * B needs cap provided by A) is benign and simply ignored — both still load.
 */
const commandModules = import.meta.glob<{ default?: CommandSpec[] }>(
  '../../abilities/*/commands.ts',
  { eager: true }
)

const metaModules = import.meta.glob<AbilityMeta>('../../abilities/*/meta.ts', { eager: true })

/** Resolve the shared meta for an ability folder id. */
function abilityMeta(id: string): AbilityMeta {
  return metaModules[`../../abilities/${id}/meta.ts`] ?? {}
}

/** Platform eligibility of an ability folder for the running platform. */
function platformOk(id: string): boolean {
  const ps = abilityMeta(id).platforms
  return !(ps && ps.length > 0 && !ps.includes(process.platform))
}

/**
 * Path-based satisfiability with cycle-ignore: an ability resolves when every
 * required capability has at least one *resolvable* provider. Following a
 * dependency back into the current path (a cycle) is treated as satisfied —
 * command-only deps make cycles harmless.
 */
function resolveAvailable(allIds: string[]): {
  available: Set<string>
  resolvable: (id: string) => boolean
} {
  const memo = new Map<string, boolean>()
  const path = new Set<string>()
  const canResolve = (id: string): boolean => {
    if (memo.has(id)) return memo.get(id)!
    if (!platformOk(id)) {
      memo.set(id, false)
      return false
    }
    if (path.has(id)) return true // cycle — cmd-only dep, ignore
    path.add(id)
    const meta = abilityMeta(id)
    const ok = (meta.dependencies ?? []).every((cap) => {
      const providers = allIds.filter(
        (p) => p !== id && platformOk(p) && (abilityMeta(p).provides ?? []).includes(cap)
      )
      return providers.some((p) => canResolve(p))
    })
    path.delete(id)
    memo.set(id, ok)
    return ok
  }
  for (const id of allIds) canResolve(id)
  return { available: new Set(allIds.filter((id) => memo.get(id))), resolvable: canResolve }
}

/** Unsatisfied capabilities of an ability (for the warning message). */
function missingCaps(id: string, resolvable: (id: string) => boolean): string[] {
  return (abilityMeta(id).dependencies ?? []).filter((cap) => {
    const providers = Object.keys(commandModules)
      .map((k) => k.split('/').at(-2) ?? k)
      .filter((p) => p !== id && platformOk(p) && (abilityMeta(p).provides ?? []).includes(cap))
    return !providers.some((p) => resolvable(p))
  })
}

/**
 * Dependency-aware registration order: providers before dependents (topological,
 * Kahn's algorithm). Cycle members never reach indegree 0, so they are appended
 * in alphabetical order — load order is organizational only (commands are flat
 * specs), not a hard requirement.
 */
function dependencyOrder(available: Set<string>): string[] {
  const ids = [...available]
  const order: string[] = []
  const depsOf = (id: string): string[] => {
    const meta = abilityMeta(id)
    const deps: string[] = []
    for (const cap of meta.dependencies ?? []) {
      for (const p of ids) {
        if (p !== id && (abilityMeta(p).provides ?? []).includes(cap) && !deps.includes(p)) {
          deps.push(p)
        }
      }
    }
    return deps
  }
  const indegree = new Map<string, number>()
  for (const id of ids) {
    indegree.set(id, depsOf(id).filter((d) => available.has(d)).length)
  }
  const queue = ids.filter((id) => indegree.get(id) === 0).sort()
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const d of ids) {
      if (d === id || !depsOf(d).includes(id)) continue
      indegree.set(d, indegree.get(d)! - 1)
      if (indegree.get(d) === 0) {
        queue.push(d)
        queue.sort()
      }
    }
  }
  // leftovers = cycle members; append alphabetically (cycle ignored)
  for (const id of [...available].sort()) if (!order.includes(id)) order.push(id)
  return order
}

/** Register every built-in ability's commands. Call once at startup. */
export function registerAbilityCommands(): void {
  const loaded: string[] = []
  const failed: string[] = []
  const ignoredPlatform: string[] = []
  const ignoredDependency: string[] = []

  const allIds = Object.keys(commandModules).map((key) => key.split('/').at(-2) ?? key)
  const { available, resolvable } = resolveAvailable(allIds)

  const badSpec = new Set<string>()
  for (const [key, mod] of Object.entries(commandModules)) {
    if (!Array.isArray(mod?.default)) {
      log.warn('missing default CommandSpec[] export, skip', { key })
      badSpec.add(key.split('/').at(-2) ?? key)
    }
  }

  for (const id of allIds) {
    const ps = abilityMeta(id).platforms
    if (ps && ps.length > 0 && !ps.includes(process.platform)) {
      log.info('ability commands skipped (platform mismatch)', { ability: id, platforms: ps })
      ignoredPlatform.push(id)
    } else if (!available.has(id)) {
      log.warn('ability commands skipped (missing capabilities)', {
        ability: id,
        capabilities: missingCaps(id, resolvable)
      })
      ignoredDependency.push(id)
    } else if (badSpec.has(id)) {
      failed.push(id)
    }
  }

  for (const id of dependencyOrder(available)) {
    if (badSpec.has(id)) continue
    const key = `../../abilities/${id}/commands.ts`
    const specs = commandModules[key]?.default ?? []
    try {
      registerAll(specs)
      loaded.push(id)
    } catch (e) {
      log.error('register failed', { key, error: e instanceof Error ? e.message : String(e) })
      failed.push(id)
    }
  }

  const total = loaded.length + failed.length + ignoredPlatform.length + ignoredDependency.length
  log.info(`ability commands registered (${loaded.length}/${total})`, {
    abilities: loaded,
    failed,
    ignoredPlatform,
    ignoredDependency
  })
  log.info(`total ${listCommands().length} commands across ${loaded.length} abilities`)
}
