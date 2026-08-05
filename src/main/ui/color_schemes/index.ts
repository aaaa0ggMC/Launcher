import type { ThemeDefinition } from 'vuetify'

/**
 * Color scheme registry — the single source of truth for every theme.
 *
 * Each scheme lives in this folder as a standalone JSON file (see
 * `dark.json`, `light.json`, ...). The registry globs them all, exposes
 * metadata for the settings UI, and builds the Vuetify `ThemeDefinition`
 * map consumed at startup (`main.ts`) and during live switching (`App.vue`).
 *
 * Unknown / missing configured ids always fall back to `DEFAULT_SCHEME_ID`,
 * so a stale config value can never leave the UI in a broken state.
 */

export interface ColorSchemeMeta {
  id: string
  /** Translation key for the display name (theme.<id>). */
  name: string
  /** True when the scheme is a dark palette. */
  dark: boolean
  /** Meta scheme that follows the OS color scheme (no concrete colors). */
  system?: boolean
  colors: Record<string, string>
}

export const DEFAULT_SCHEME_ID = 'dark'

/** Globs every scheme JSON in this folder (eager: embedded at build time). */
const modules = import.meta.glob<ColorSchemeMeta>('./*.json', {
  eager: true,
  import: 'default'
})

export const schemeList: ColorSchemeMeta[] = Object.values(modules)
  .filter((s) => s && typeof s.id === 'string')
  .sort((a, b) => (a.system ? 1 : 0) - (b.system ? 1 : 0))

export const schemeMap: Record<string, ColorSchemeMeta> = Object.fromEntries(
  schemeList.map((s) => [s.id, s])
)

export function getSchemeMeta(id: string | null | undefined): ColorSchemeMeta | null {
  if (!id) return null
  return schemeMap[id] ?? null
}

/**
 * Resolve a configured theme value to a concrete, registered scheme id.
 * - unknown / missing id  → `DEFAULT_SCHEME_ID`
 * - `system`              → `dark` / `light` from the OS preference
 */
export function resolveSchemeId(
  configured: string | null | undefined,
  systemPrefersDark: boolean
): string {
  const id = configured ?? DEFAULT_SCHEME_ID
  const meta = getSchemeMeta(id)
  if (!meta) return DEFAULT_SCHEME_ID
  if (meta.system) {
    const light = schemeMap.light ? 'light' : DEFAULT_SCHEME_ID
    return systemPrefersDark ? (schemeMap.dark ? 'dark' : DEFAULT_SCHEME_ID) : light
  }
  return meta.id
}

/** Build the Vuetify theme map from every concrete (non-system) scheme. */
export function buildThemeDefinitions(): Record<string, ThemeDefinition> {
  const out: Record<string, ThemeDefinition> = {}
  for (const s of schemeList) {
    if (s.system) continue
    out[s.id] = { dark: s.dark, colors: s.colors }
  }
  return out
}
