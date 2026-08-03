import type { Component } from 'vue'

/**
 * Ability contract — every `abilities/<id>/index.ts` default-exports an object
 * satisfying this interface. The sidebar is driven by config/abilities.yaml;
 * components load dynamically (code-split) on first show.
 */
export interface Ability {
  /** Ability id, must match the folder name. */
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
  /** Page component. */
  component: Component
  /**
   * Keep the page instance alive across sidebar switches (default true).
   * Polling/fast-loading snapshot pages should set false to always reload fresh.
   */
  keepAlive?: boolean
}

export const FALLBACK_ICON = '😎'
