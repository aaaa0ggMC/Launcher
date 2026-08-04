import { markRaw } from 'vue'
import type { Component } from 'vue'
import type { Ability } from './types'

/**
 * Ability loader — the single source of truth for what's loaded.
 *
 * Every `abilities/<id>/index.ts` (the folder's orchestrator) default-exports
 * an `Ability` metadata object; this loader collects them all at build time
 * via `import.meta.glob` and exposes them to the rest of the app. The main
 * process has its own loader (`src/main/process/abilities-loader.ts`) that
 * registers each ability's `commands.ts`; both processes share the same folder
 * layout so an ability is fully self-contained in one place.
 */

const abilityModules = import.meta.glob<{ default: Ability }>('./*/index.ts', { eager: true })

/** All ability metadata modules keyed by their folder id. */
export function loadAbilityModules(): Record<string, Ability> {
  const out: Record<string, Ability> = {}
  for (const key of Object.keys(abilityModules)) {
    const mod = abilityModules[key]
    if (mod?.default) out[mod.default.id] = mod.default
  }
  return out
}

export function getAbility(id: string): Ability | undefined {
  return loadAbilityModules()[id]
}

/** The raw module table keyed by `./<id>/index.ts` (for iteration / settings). */
export function getAbilityModuleEntries(): Record<string, { default: Ability }> {
  return abilityModules
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
 * rest follow the sidebar order of their owning ability.
 */
export function buildSettingsSections(
  abilities: AbilityModuleEntry[],
  modules: Record<string, { default: Ability }>
): SettingsCategory[] {
  const order = new Map<string, number>()
  abilities.forEach((a, i) => order.set(a.id, i))

  const list: SettingsCategory[] = []
  for (const a of abilities) {
    const meta = modules[`./${a.id}/index.ts`]?.default
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
