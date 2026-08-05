// Apps ability domain types — the app registry + launch model.

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
