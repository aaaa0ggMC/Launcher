// Shared framework contract types used across main / preload / renderer.
// Ability-specific domain types live in each ability's own `types.ts` —
// shared should NOT accumulate per-ability models.

/** Per-ability manifest entry from config/abilities.yaml. */
export interface AbilityConfig {
  id: string
  order: number
  enabled: boolean
  config?: Record<string, unknown>
}

export interface AbilitiesManifest {
  sidebar: {
    default: string
    showLabels: boolean
    searchBox: boolean
  }
  abilities: AbilityConfig[]
}

/** Result of a process launch — the framework launch service contract. */
export interface LaunchResult {
  ok: boolean
  pid?: number
  error?: string
  terminal?: boolean
  /** true when the process output is being streamed to the renderer */
  monitor?: boolean
}

/** Streamed process output event (line-split stdout/stderr + exit). */
export type ProcOutputEvent =
  | { pid: number; type: 'line'; stream: 'stdout' | 'stderr'; line: string }
  | { pid: number; type: 'exit'; code: number | null }
