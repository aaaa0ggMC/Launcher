import { markRaw, ref, type Ref } from 'vue'
import type { Component } from 'vue'
import type { Ability } from './ability'
import type { AbilityMeta } from '../../shared/types'

/**
 * Ability loader — the single source of truth for what's loaded. Framework
 * infrastructure owned by the shell; the folder it scans (`abilities/`) holds
 * only the actual abilities.
 *
 * Every `abilities/<id>/index.ts` (the folder's orchestrator) default-exports
 * one `Ability` metadata object — or an ARRAY of them, so a single folder can
 * register several related abilities (e.g. AIDJ registers its main chat page
 * AND a lyrics page). This loader collects them all at build time via
 * `import.meta.glob` and exposes them to the rest of the app. The main process
 * has its own loader (`src/main/process/abilities-loader.ts`) that registers
 * each ability's `commands.ts`; both processes share the same folder layout so
 * an ability is fully self-contained in one place.
 *
 * Sidebar injection is self-contained too: abilities are grouped by their
 * `category` and sorted alphabetically inside each category — no external
 * manifest/order dependency. Platform filtering reads each ability's `meta.ts`
 * (`platforms`); incompatible abilities are filtered out and reported as
 * ignored in the logs.
 */

type AbilityDefault = Ability | Ability[]

const abilityModules = import.meta.glob<{ default: AbilityDefault }>('../../abilities/*/index.ts', {
  eager: true
})

/**
 * Ability folder convention: `meta.ts` holds metadata shared by BOTH processes
 * (e.g. `platforms`, `provides`, `dependencies`), `index.ts` is frontend-only,
 * `commands.ts` backend-only.
 */
const metaModules = import.meta.glob<AbilityMeta>('../../abilities/*/meta.ts', { eager: true })

interface AbilityEntry {
  ability: Ability
  /** folder-level platforms from meta.ts (applies to every ability in the folder). */
  platforms: string[] | undefined
  /** folder-level capability lexicon (`provides`) from meta.ts. */
  provides: string[] | undefined
  /** folder-level required capabilities (`dependencies`) from meta.ts. */
  dependencies: string[] | undefined
}

let _registry: Record<string, AbilityEntry> | null = null

// ---------------------------------------------------------------------------
// Runtime enable/disable (MAddition). TRANSIENT — the disabled set is derived
// from the last `cockpit:abilities-changed` broadcast (which mirrors the main
// process's session-scoped registry); it is deliberately never persisted, so a
// fresh mount re-derives the enabled state from the current registry.
// ---------------------------------------------------------------------------
const disabledAbilities = ref<string[]>([])

/** Reactive list of currently-disabled ability ids. */
export const useDisabledAbilities: Ref<string[]> = disabledAbilities

/** Apply a fresh disabled set (from the main-process broadcast). */
export function applyDisabledAbilities(ids: string[]): void {
  disabledAbilities.value = ids
}

/** Toggle an ability's runtime state via IPC; the `cockpit:abilities-changed`
 *  broadcast round-trips the authoritative list back. */
export async function setAbilityEnabled(id: string, enabled: boolean): Promise<boolean> {
  const r = (await window.cockpit.command('ability.set-enabled', {
    id,
    enabled
  })) as { ok?: boolean } | null
  return r?.ok === true
}

/** Subscribe to the main-process ability enable/disable broadcast. */
export function subscribeAbilityChanges(): (() => void) | null {
  if (!window.cockpit?.on) return null
  return window.cockpit.on('cockpit:abilities-changed', (event: unknown) => {
    const ev = event as Record<string, unknown>
    if (Array.isArray(ev.disabled)) {
      applyDisabledAbilities((ev.disabled as unknown[]).map(String))
    }
  })
}

/**
 * Build the full registry keyed by ability id. Platforms and the capability
 * lexicon (`provides` / `dependencies`) come from the ability FOLDER's
 * `meta.ts` and apply to every ability it exports — so a folder that registers
 * several abilities (e.g. aidj + aidj-lyrics) shares one label.
 */
function loadRegistry(): Record<string, AbilityEntry> {
  if (_registry) return _registry
  const out: Record<string, AbilityEntry> = {}
  for (const key of Object.keys(abilityModules)) {
    const folder = key.split('/').at(-2) ?? key
    const mod = abilityModules[key]
    const def = mod?.default
    if (!def) continue
    const folderMeta = metaModules[`../../abilities/${folder}/meta.ts`]
    const platforms = folderMeta?.platforms
    const provides = folderMeta?.provides
    const dependencies = folderMeta?.dependencies
    for (const a of Array.isArray(def) ? def : [def]) {
      if (out[a.id]) {
        console.warn(`[abilities] duplicate ability id "${a.id}" — overriding (${key})`)
      }
      out[a.id] = { ability: a, platforms, provides, dependencies }
    }
  }
  validateDependencies(out)
  _registry = out
  return out
}

/**
 * Registry-wide capability contract check (independent of platform): every
 * required capability must be provided by at least one ability in the registry.
 * Unprovided capabilities are reported through the main log + console; they
 * also make the dependent ability unavailable in `resolveSidebarAbilities`.
 */
function validateDependencies(registry: Record<string, AbilityEntry>): void {
  const allProvided = new Set<string>()
  for (const entry of Object.values(registry)) {
    for (const cap of entry.provides ?? []) allProvided.add(cap)
  }
  for (const [id, entry] of Object.entries(registry)) {
    const missing = (entry.dependencies ?? []).filter((cap) => !allProvided.has(cap))
    if (!missing.length) continue
    const message = `ability "${id}" requires unprovided capabilities: ${missing.join(', ')}`
    console.warn(`[abilities] ${message}`)
    postAbilityLog('warn', message)
  }
}

/** All ability metadata keyed by their id (last duplicate wins). */
export function loadAbilityModules(): Record<string, Ability> {
  const out: Record<string, Ability> = {}
  for (const [id, entry] of Object.entries(loadRegistry())) out[id] = entry.ability
  return out
}

export function getAbility(id: string): Ability | undefined {
  return loadRegistry()[id]?.ability
}

/** The flattened module table keyed by ability id (for iteration / settings). */
export function getAbilityModules(): Record<string, Ability> {
  return loadAbilityModules()
}

/** Forward an ability-loader report line into the main-process log pipeline. */
function postAbilityLog(level: 'info' | 'warn', message: string): void {
  window.cockpit.command('logs.post', { level, scope: 'abilities', message }).catch(() => {})
}

/** One sidebar-eligible ability, resolved against the running platform. */
export interface SidebarAbilityMeta {
  id: string
  name: string
  icon: string | null
  category: string
  keepAlive: boolean
  component?: Component
}

export interface AbilityLoadReport {
  /** sidebar-eligible abilities for this platform (component present + platform OK) */
  loaded: SidebarAbilityMeta[]
  /** ids filtered out because they don't support the current platform */
  ignoredPlatform: string[]
  /** ids filtered out because a declared dependency is unavailable/missing */
  ignoredDependency: string[]
  /** backend-only abilities (commands but no sidebar page) */
  backendOnly: string[]
}

/** Platform eligibility of an ability folder. */
function platformOk(platforms: string[] | undefined, platform: string): boolean {
  return !(platforms && platforms.length > 0 && !platforms.includes(platform))
}

/**
 * Path-based satisfiability with cycle-ignore, mirroring the main-process
 * loader: an ability resolves on this platform when every required capability
 * has at least one *resolvable* provider. Following a dependency back into the
 * current path (a cycle) is treated as satisfied — command-only deps make
 * cycles harmless. Shared (backend-only) abilities like `background` resolve
 * normally even though they never enter the sidebar.
 */
function resolveAvailable(
  registry: Record<string, AbilityEntry>,
  platform: string
): { available: Set<string>; resolvable: (id: string) => boolean } {
  const allIds = Object.keys(registry)
  const memo = new Map<string, boolean>()
  const path = new Set<string>()
  const canResolve = (id: string): boolean => {
    if (memo.has(id)) return memo.get(id)!
    if (!platformOk(registry[id].platforms, platform)) {
      memo.set(id, false)
      return false
    }
    if (path.has(id)) return true // cycle — cmd-only dep, ignore
    path.add(id)
    const entry = registry[id]
    const ok = (entry.dependencies ?? []).every((cap) => {
      const providers = allIds.filter(
        (p) =>
          p !== id &&
          platformOk(registry[p].platforms, platform) &&
          (registry[p].provides ?? []).includes(cap)
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
function missingCaps(
  registry: Record<string, AbilityEntry>,
  platform: string,
  id: string,
  resolvable: (id: string) => boolean
): string[] {
  return (registry[id].dependencies ?? []).filter((cap) => {
    const providers = Object.keys(registry).filter(
      (p) =>
        p !== id &&
        platformOk(registry[p].platforms, platform) &&
        (registry[p].provides ?? []).includes(cap)
    )
    return !providers.some((p) => resolvable(p))
  })
}

/**
 * Resolve the sidebar list for a platform. Backend-only abilities (no
 * `component`) never enter the sidebar; abilities whose `platforms` list
 * excludes the running platform are filtered out; abilities whose required
 * capabilities have no resolvable provider (missing, platform-filtered, or
 * transitively unsatisfied) are filtered out as well. All sets are reported
 * through the main log (`logs.post`).
 */
export function resolveSidebarAbilities(platform: string): AbilityLoadReport {
  const registry = loadRegistry()
  const loaded: SidebarAbilityMeta[] = []
  const ignoredPlatform: string[] = []
  const ignoredDependency: string[] = []
  const backendOnly: string[] = []

  const { available, resolvable } = resolveAvailable(registry, platform)

  for (const [id, { ability: meta, platforms }] of Object.entries(registry)) {
    if (!meta.component) {
      backendOnly.push(id)
      continue
    }
    if (!platformOk(platforms, platform)) {
      ignoredPlatform.push(id)
      continue
    }
    if (disabledAbilities.value.includes(id)) {
      continue
    }
    if (!available.has(id)) {
      const caps = missingCaps(registry, platform, id, resolvable)
      postAbilityLog('warn', `ability "${id}" ignored (missing capabilities: ${caps.join(', ')})`)
      ignoredDependency.push(id)
      continue
    }
    loaded.push({
      id,
      name: meta.name,
      icon: meta.icon,
      category: meta.category,
      keepAlive: meta.keepAlive !== false,
      component: meta.component
    })
  }
  loaded.sort((a, b) => {
    const c = a.category.localeCompare(b.category)
    return c !== 0 ? c : a.name.localeCompare(b.name)
  })
  postAbilityLog(
    'info',
    `abilities resolved (platform=${platform}): ${loaded.map((a) => a.id).join(', ') || '(none)'}`
  )
  if (ignoredPlatform.length) {
    postAbilityLog('warn', `abilities ignored (platform mismatch): ${ignoredPlatform.join(', ')}`)
  }
  if (ignoredDependency.length) {
    postAbilityLog(
      'warn',
      `abilities ignored (missing capabilities): ${ignoredDependency.join(', ')}`
    )
  }
  if (backendOnly.length) {
    postAbilityLog(
      'info',
      `backend-only abilities (commands, no sidebar page): ${backendOnly.join(', ')}`
    )
  }
  return { loaded, ignoredPlatform, ignoredDependency, backendOnly }
}

// ---------------------------------------------------------------------------
// Settings injection aggregation — cross-scope: every ability's `settings`
// array is collected here and handed to the settings page.
// ---------------------------------------------------------------------------

export interface SettingsItem {
  /** Composite id `${categoryId}.${key}`. */
  id: string
  key: string
  categoryId: string
  label: string
  description: string
  icon: string
  keywords: string[]
  fullWidth: boolean
  component: Component
  /** Lowercased label + description + keywords, used for search. */
  haystack: string
}

export interface SettingsCategory {
  /** Composite id `${abilityId}.${key}`. */
  id: string
  abilityId: string
  abilityName: string
  label: string
  icon: string
  description: string
  keywords: string[]
  items: SettingsItem[]
  haystack: string
}

export interface AbilityModuleEntry {
  id: string
  name: string
}

/**
 * Collect every enabled ability's injected settings categories. Ordering: the
 * settings ability's own sections come first (they are the built-in base), the
 * rest follow the sidebar order of their owning ability (alphabetical).
 */
export function buildSettingsSections(
  abilities: AbilityModuleEntry[],
  modules: Record<string, Ability>
): SettingsCategory[] {
  const order = new Map<string, number>()
  abilities.forEach((a, i) => order.set(a.id, i))

  const list: SettingsCategory[] = []
  for (const a of abilities) {
    const meta = modules[a.id]
    const injected = meta?.settings
    if (!injected?.length) continue
    for (const s of injected) {
      const categoryId = `${a.id}.${s.key}`
      const catKeywords = s.keywords ?? []
      const items: SettingsItem[] = (s.items ?? []).map((item) => {
        const ik = item.keywords ?? []
        return {
          id: `${categoryId}.${item.key}`,
          key: item.key,
          categoryId,
          label: item.label,
          description: item.description ?? '',
          icon: item.icon ?? 'mdi-toggle-switch-outline',
          keywords: ik,
          fullWidth: item.fullWidth === true,
          component: markRaw(item.component),
          haystack: `${item.label} ${item.description ?? ''} ${ik.join(' ')}`.toLowerCase()
        }
      })
      list.push({
        id: categoryId,
        abilityId: a.id,
        abilityName: a.name,
        label: s.label,
        icon: s.icon ?? 'mdi-tune-variant',
        description: s.description ?? '',
        keywords: catKeywords,
        items,
        haystack: `${s.label} ${s.description ?? ''} ${catKeywords.join(' ')}`.toLowerCase()
      })
    }
  }

  list.sort((x, y) => {
    const xSelf = x.abilityId === 'settings' ? 0 : 1
    const ySelf = y.abilityId === 'settings' ? 0 : 1
    if (xSelf !== ySelf) return xSelf - ySelf
    return (order.get(x.abilityId) ?? 99) - (order.get(y.abilityId) ?? 99)
  })
  return list
}
