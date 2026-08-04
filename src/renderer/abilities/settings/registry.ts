import { markRaw } from 'vue'
import type { Component } from 'vue'
import type { Ability } from '../types'

/**
 * Resolved settings structure — built ONCE by the upper layer (App.vue) from
 * every enabled ability's `settings` export, then provided to the settings
 * page. The settings page never re-scans ability modules or re-reads the
 * manifest, and nothing here gives the settings ability special powers: it is
 * just another ability whose `index.ts` injects a `settings` array.
 */

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
    const meta = modules[`./abilities/${a.id}/index.ts`]?.default
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
