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
  /** when the launch was converted into a managed background task */
  taskId?: string
}

/** Streamed process output event (line-split stdout/stderr + exit). */
export type ProcOutputEvent =
  | { pid: number; type: 'line'; stream: 'stdout' | 'stderr'; line: string }
  | { pid: number; type: 'exit'; code: number | null }

/**
 * Background task framework contract.
 *
 * Background tasks are a framework-level facility (src/main/process/
 * background-tasks.ts): any ability/module can open a task that outlives the
 * current page and keeps running in the app's shadow, visible from a global
 * panel. Two kinds:
 *  - `process` — a real child process (spawned argv); gets resource stats,
 *    console output, and interactive stdin/signal control.
 *  - `job` — an abstract long-running operation (no process). The creator
 *    pushes output lines / progress and can be cancelled; perfect for
 *    downloads, transforms, or any work that must survive page switches.
 */

export type BtTaskKind = 'process' | 'job'
export type BtTaskStatus = 'running' | 'exited' | 'error' | 'cancelled' | 'stopped'

/** Rough resource snapshot for a background task (best-effort, Linux /proc). */
export interface BtStats {
  /** CPU usage percent (approx, single-core normalized). */
  cpu?: number
  /** Resident memory in MB. */
  mem?: number
  /** GPU memory in MB used by the task's process (nvidia-smi compute-apps). */
  gpu?: number
}

/** Public snapshot of one background task, safe to ship to the renderer. */
export interface BtTaskInfo {
  id: string
  name: string
  description?: string
  kind: BtTaskKind
  status: BtTaskStatus
  /** pid of the underlying process (process tasks only). */
  pid?: number
  /** argv join for process tasks. */
  command?: string
  startedAt: number
  /** set when the task stops/exits/errors — freezes the elapsed time display. */
  endedAt?: number
  exitCode?: number | null
  stats: BtStats
  /** number of output lines buffered (details via `background.output`). */
  outputCount: number
  /** true when the task accepts stdin writes. */
  canInput: boolean
  /** true when the task can be signalled (process tasks). */
  canSignal: boolean
  /** job tasks only: 0–100 progress, undefined when indeterminate. */
  progress?: number
}

/** Live output event from a background task. */
export type BtOutputEvent =
  | { id: string; type: 'line'; stream: 'stdout' | 'stderr'; line: string }
  | { id: string; type: 'exit'; code: number | null }
