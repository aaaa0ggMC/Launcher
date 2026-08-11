import type { AppEntry } from './types'

/**
 * Resolve a localized field of an app entry.
 * Fallback chain: preferred language → en-US/en_US → first available → base field.
 */
export function localize(
  entry: AppEntry,
  field: 'name' | 'description' | 'alias',
  lang: string
): string | undefined {
  const direct = entry.localized?.[lang]?.[field]
  if (direct) return direct
  const fallback = entry.localized?.['en-US']?.[field] ?? entry.localized?.['en_US']?.[field]
  if (fallback) return fallback
  if (entry.localized) {
    for (const val of Object.values(entry.localized)) {
      const v = val[field]
      if (v) return v
    }
  }
  return entry[field]
}
