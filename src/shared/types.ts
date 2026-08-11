// Shared framework contract types used across main / preload / renderer.
//
// These are contracts the framework (`src/main`) genuinely needs while staying
// ability-agnostic: the framework never imports from `abilities/<id>/`, so any
// shape it must consume (log pipeline entries, app-entry launch model,
// structured task output, ...) lives here. The owning ability imports/re-exports
// them from its own `types.ts` so the ability stays self-contained. Anything
// used only inside a single ability belongs in that ability's `types.ts`.

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

/**
 * How a background task's output should be rendered in the global panel.
 * `log` is the built-in console (lines + stdin); any other value maps to a
 * view registered by the task's owner (e.g. `response` for playground).
 * The lifecycle toolbar (stop/kill/remove) is NOT part of the view.
 */
export type BtTaskView = 'log' | string

/**
 * A message emitted by a background task. The task's view decides how each
 * kind is rendered:
 *  - `line`  — a console line (stdout/stderr) for the default log view
 *  - `data`  — arbitrary structured payload (object/string/number...); binary
 *    can be transported as `{ data, encoding: 'base64', mime }`
 */
export interface BtOutputMessage {
  stream?: 'stdout' | 'stderr'
  line?: string
  data?: unknown
  /** when data is binary (e.g. base64), the encoding + mime for decoding */
  encoding?: 'base64' | 'utf8' | 'json'
  mime?: string
  /** 0–100 progress carried inside a message (view may show a bar) */
  progress?: number
  /** optional label for structured data blocks */
  label?: string
}

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
  /** how the panel renders this task's output; default 'log' */
  view: BtTaskView
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
  | { id: string; type: 'message'; message: BtOutputMessage }
  | { id: string; type: 'exit'; code: number | null }

/**
 * Managed child window snapshot (src/main/process/windows.ts → renderer).
 *
 * Child windows are extra BrowserWindows (e.g. a floating lyrics view) created
 * via `window.create`. They are single-instance per `id`, loaded from the same
 * renderer with a `?view=` query that picks the root component (windows/ glob),
 * and surfaced in the background-task panel under the 「子窗口」filter category.
 */
export interface ChildWindowInfo {
  /** unique window id — the single-instance key. */
  id: string
  /** renderer view key resolved against the windows/ glob (e.g. `LyricsWindow`). */
  view: string
  frameless: boolean
  rounded: boolean
  alwaysOnTop: boolean
  /** mouse passthrough — `setIgnoreMouseEvents(true)`, unlock via the BT panel. */
  locked: boolean
  minimized: boolean
  maximized: boolean
  width: number
  height: number
  startedAt: number
}

/** Window manager change event (`cockpit:windows` broadcast). */
export type WindowChangedEvent = { type: 'changed'; windows: ChildWindowInfo[] }

// ---------------------------------------------------------------------------
// Log pipeline contract (owned by the framework logger in src/main/process;
// consumed by the `logs` ability).
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** One structured log entry (produced by the main-process logger). */
export interface LogEntry {
  /** Monotonic sequence id — the renderer uses it for paging ("before"). */
  id: number
  /** Epoch milliseconds. */
  ts: number
  level: LogLevel
  /** Owning module scope, e.g. `mirror`, `launcher`, `renderer`. */
  scope: string
  message: string
  data?: unknown
  /**
   * Consecutive duplicates merged into this entry (1 = unique). The UI shows
   * `*N` for counts > 1; the on-disk file still keeps every raw line.
   */
  count?: number
}

export interface LogQueryResult {
  entries: LogEntry[]
  total: number
}

// ---------------------------------------------------------------------------
// App-entry launch contract — the shell's search/quick-launch pipeline and the
// entry-action framework operate on these shapes without importing the `apps`
// ability. The `apps` ability owns the registry/launcher implementations and
// re-exports these types from its own `types.ts`.
// ---------------------------------------------------------------------------

export type ExecType =
  'uv' | 'python' | 'node' | 'docker' | 'systemd' | 'script' | 'desktop' | 'custom'

export interface AppExecSpec {
  type: ExecType
  /** entry point, e.g. ["bili-viewer"] for uv, ["app.js"] for node */
  command: string[]
  args?: string[]
  /** "{self}" = entry's own dir; default = path's parent dir */
  cwd?: string
  env?: Record<string, string>
  terminal?: boolean
  root?: boolean
  /**
   * run as a managed background task instead of a terminal window — the app is
   * spawned with piped stdio and attached to the framework task service, so it
   * appears in the global Background Tasks panel (live console + stdin/signals).
   */
  background?: boolean
  /** override the script/desktop target for this spec (default: entry.path) */
  path?: string
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface AppSecurity {
  risk: RiskLevel
  auto_note?: string
  note?: string
  acknowledged?: boolean
}

/**
 * One additional operation on an app entry (e.g. new-api: start/stop/recreate).
 * Each action renders as its own button on the app card; the button background
 * color encodes the (effective) risk level — darker = more dangerous.
 */
export interface AppAction {
  /** button label, e.g. "开始" / "停止" */
  name: string
  description?: string
  localized?: Record<string, { name?: string; description?: string }>
  icon?: string
  /** per-action risk override; falls back to entry.security.risk for coloring */
  risk?: RiskLevel
  /** primary exec (single-step action) */
  exec: AppExecSpec
  /**
   * multi-step sequence. Steps are run one by one in order; intermediate
   * steps run headless and are awaited, the LAST step launches detached
   * (honors its own terminal/root flags). Overrides `exec` when present.
   */
  steps?: AppExecSpec[]
}

export interface AppEntry {
  alias?: string
  name: string
  description?: string
  localized?: Record<string, { name?: string; description?: string; alias?: string }>
  path: string
  icon?: string
  /** primary launch spec — rendered as the default「启动」button */
  exec: AppExecSpec
  /** additional clustered operations, keyed by action id */
  actions?: Record<string, AppAction>
  tags?: string[]
  tags_auto?: string[]
  security?: AppSecurity
  managed?: boolean
  missing?: boolean
  /**
   * optional JS source: a constructor with `onNewLine(e, ui)` — e is each line
   * of the process output, ui is a component factory (ui.NewAlign/NewBar/...).
   * Combined with transformer_display, a live 80% modal renders the output.
   */
  transformer?: string
  transformer_display?: boolean
  /** search root this entry lives in (runtime info, not persisted) */
  root?: string
}

export interface AppRegistryFile {
  version: number
  apps: Record<string, AppEntry>
}
