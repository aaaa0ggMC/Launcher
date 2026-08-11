import { markRaw } from 'vue'
import type { Component } from 'vue'
import type { Ability } from './types'

/**
 * Ability loader — the single source of truth for what's loaded.
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
 * manifest/order dependency. Each ability can declare `platforms`; when the
 * running platform isn't among them the ability is filtered out and reported
 * as ignored in the logs.
 */

type AbilityDefault = Ability | Ability[]

const abilityModules = import.meta.glob<{ default: AbilityDefault }>('./*/index.ts', {
  eager: true
})

let _modulesCache: Record<string, Ability> | null = null

/** All ability metadata keyed by their id (last duplicate wins). */
export function loadAbilityModules(): Record<string, Ability> {
  if (_modulesCache) return _modulesCache
  const out: Record<string, Ability> = {}
  for (const key of Object.keys(abilityModules)) {
    const mod = abilityModules[key]
    const def = mod?.default
    if (!def) continue
    for (const a of Array.isArray(def) ? def : [def]) {
      if (out[a.id]) {
        console.warn(`[abilities] duplicate ability id "${a.id}" — overriding (${key})`)
      }
      out[a.id] = a
    }
  }
  _modulesCache = out
  return out
}

export function getAbility(id: string): Ability | undefined {
  return loadAbilityModules()[id]
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
  /** backend-only abilities (commands but no sidebar page) */
  backendOnly: string[]
}

/**
 * Resolve the sidebar list for a platform. Backend-only abilities (no
 * `component`) never enter the sidebar; abilities whose `platforms` list
 * excludes the running platform are filtered out. Both the loaded and the
 * ignored sets are reported through the main log (`logs.post`).
 */
export function resolveSidebarAbilities(platform: string): AbilityLoadReport {
  const modules = loadAbilityModules()
  const loaded: SidebarAbilityMeta[] = []
  const ignoredPlatform: string[] = []
  const backendOnly: string[] = []
  for (const [id, meta] of Object.entries(modules)) {
    if (!meta.component) {
      backendOnly.push(id)
      continue
    }
    const ps = meta.platforms
    if (ps && ps.length > 0 && !ps.includes(platform)) {
      ignoredPlatform.push(id)
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
  if (backendOnly.length) {
    postAbilityLog(
      'info',
      `backend-only abilities (commands, no sidebar page): ${backendOnly.join(', ')}`
    )
  }
  return { loaded, ignoredPlatform, backendOnly }
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
