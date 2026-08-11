import type { Component } from 'vue'

/**
 * Ability contract — framework-owned (lives in the shell, not in any ability).
 *
 * Every `abilities/<id>/index.ts` default-exports an object (or an array of
 * objects, so one folder can register several abilities) that satisfies this
 * interface. Abilities are self-injecting: the loader (`@ui/ability-registry`)
 * scans the folders at build time, so the sidebar no longer depends on
 * config/abilities.yaml ordering. Components load dynamically (code-split).
 */
export interface Ability {
  /** Ability id. With a single export it must match the folder name. */
  id: string
  /** Display name (Chinese UI). */
  name: string
  /**
   * Sidebar icon. Accepted formats:
   *  - `gi:<name>`  → game-icon-pack SVG from `assets/icons/<name>.svg`
   *  - emoji string (legacy / app entries)
   *  - null → falls back to FALLBACK_ICON
   */
  icon: string | null
  /** Sidebar group label. */
  category: string
  /**
   * Applicable platforms — `process.platform` values (`'linux' | 'darwin' |
   * 'win32'`). Omitted / empty means the ability works everywhere. When set,
   * the ability is only injected on a matching platform; on other platforms it
   * is filtered out and reported as ignored in the logs.
   */
  platforms?: string[]
  /**
   * Page component. Optional — a backend-only ability (commands but no UI
   * page, e.g. `display`) omits it and stays hidden from the sidebar.
   */
  component?: Component
  /**
   * Keep the page instance alive across sidebar switches (default true).
   * Polling/fast-loading snapshot pages should set false to always reload fresh.
   */
  keepAlive?: boolean
  /**
   * Settings page contributions. Each entry becomes one category in the
   * settings ability (top chip + item menu). Abilities with no settings to
   * contribute can omit this entirely.
   */
  settings?: AbilitySetting[]
}

/**
 * One section/category injected into the settings page. The settings shell
 * groups all enabled abilities' contributions into a multi-level UI:
 *
 *   level 1  category chip (this)      — top row, horizontally scrollable
 *   level 2  item menu list            — the category's `items`
 *   level 3  item content component    — one item's actual settings form
 */
export interface AbilitySetting {
  /** Unique key within this ability (e.g. `'appearance'`). */
  key: string
  /** Display label shown on the category chip. */
  label: string
  /**
   * Icon for the category chip. mdi name (e.g. `mdi-palette-outline`), or any
   * icon the app's unified `AbilityIcon` understands (`gi:<name>` / emoji).
   */
  icon?: string
  /** One-line description, shown in search results. */
  description?: string
  /** Extra searchable terms for the category as a whole. */
  keywords?: string[]
  /** Level-2 menu entries rendered inside this category. */
  items: AbilitySettingItem[]
}

/**
 * One menu entry inside a settings category. Its `component` holds the actual
 * controls; the settings shell renders a category's items inline (grid) when
 * that category is active or matched by search.
 */
export interface AbilitySettingItem {
  /** Unique key within its category. */
  key: string
  /** Menu row label. */
  label: string
  /** Menu row subtitle — also searchable. */
  description?: string
  /** mdi icon name (or unified AbilityIcon format) for the menu row. */
  icon?: string
  /** Extra searchable terms describing the concrete setting content. */
  keywords?: string[]
  /** Content component rendered for this item. */
  component: Component
  /** Span the full row width instead of sharing a half-width column. */
  fullWidth?: boolean
}

export const FALLBACK_ICON = '😎'
