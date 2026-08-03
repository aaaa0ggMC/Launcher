// Shared domain types used across main / preload / renderer.

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

export interface GpuInfo {
  name: string
  driver: string
  vram: string
  vramTotal?: string
  vramUsed?: string
  vramPercent?: number
  usage: string
  temp: string
  fanSpeed?: string
  power?: string
  powerLimit?: string
}

export interface DockerContainer {
  id: string
  name: string
  image: string
  status: string
  state: string
  ports: string
}

export interface SystemStats {
  hostname: string
  platform: string
  arch: string
  release: string
  uptime: number
  username?: string
  shell?: string
  de?: string
  packages?: { pacman: number; flatpak: number }
  loadAvg?: [number, number, number]
  cpu: {
    model: string
    cores: number
    usage: number
    temp?: number
    freq?: number
  }
  mem: { total: number; used: number; free: number; percent: number }
  swap?: { total: number; used: number; free: number; percent: number }
  disk: { path: string; total: number; used: number; free: number; percent: number }[]
  gpu: GpuInfo[]
  docker: DockerContainer[]
}

export interface MirrorEntry {
  name: string
  url: string
  enabled: boolean
}

export interface MirrorInfo {
  mirrors: MirrorEntry[]
  lastError?: string
}

export interface AutostartEntry {
  file: string
  name: string
  exec: string
  comment?: string
  hidden: boolean
}

export interface SystemdUnit {
  name: string
  description: string
  active: string
  sub: string
  loaded: boolean
}

export interface WallpaperFile {
  name: string
  path: string
}

export interface DisplayOutput {
  name: string
  description: string
  connected: boolean
  enabled: boolean
}
