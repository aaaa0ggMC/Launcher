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
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface AppSecurity {
  risk: RiskLevel
  auto_note?: string
  note?: string
  acknowledged?: boolean
}

export interface AppEntry {
  alias?: string
  name: string
  description?: string
  path: string
  icon?: string
  exec: AppExecSpec
  tags?: string[]
  tags_auto?: string[]
  security?: AppSecurity
  managed?: boolean
  missing?: boolean
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
}

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
