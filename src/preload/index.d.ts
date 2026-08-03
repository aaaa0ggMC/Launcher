import type {
  AbilitiesManifest,
  AppEntry,
  AutostartEntry,
  DisplayOutput,
  DockerContainer,
  GpuInfo,
  LaunchResult,
  MirrorInfo,
  SystemStats,
  SystemdUnit,
  WallpaperFile
} from '../shared/types'

export interface AppsListResult {
  roots: { path: string; watch: boolean }[]
  apps: Record<string, AppEntry>
}

export interface AppsConfig {
  searchRoots: { path: string; watch: boolean }[]
  confirmBeforeLaunch: boolean
}

export interface CockpitApi {
  /** CLI-first dispatcher: run any registered ability command. */
  command: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  listCommands: () => Promise<{ name: string; description: string; usage?: string }[]>
  getConfig: () => Promise<Record<string, unknown> | null>
  setConfig: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>
  getManifest: () => Promise<AbilitiesManifest | null>
  listApps: () => Promise<AppsListResult>
  getEntry: (root: string, id: string) => Promise<AppEntry | null>
  updateEntry: (root: string, id: string, patch: Partial<AppEntry>) => Promise<AppEntry>
  deleteEntry: (root: string, id: string) => Promise<void>
  addRoot: (path: string) => Promise<AppsConfig['searchRoots']>
  removeRoot: (path: string) => Promise<AppsConfig['searchRoots']>
  appsConfig: () => Promise<AppsConfig>
  rescan: (root: string) => Promise<unknown>
  launch: (root: string, id: string) => Promise<LaunchResult>
  getMirror: () => Promise<MirrorInfo>
  listAutostart: () => Promise<AutostartEntry[]>
  toggleAutostart: (file: string, hidden: boolean) => Promise<AutostartEntry[]>
  listSystemd: () => Promise<SystemdUnit[]>
  systemdAction: (name: string, action: 'start' | 'stop' | 'restart') => Promise<SystemdUnit[]>
  listDocker: () => Promise<DockerContainer[]>
  dockerAction: (name: string, action: 'start' | 'stop' | 'restart') => Promise<DockerContainer[]>
  stats: () => Promise<SystemStats>
  gpu: () => Promise<GpuInfo[]>
  readPm: () => Promise<0 | 1 | null>
  togglePm: () => Promise<0 | 1 | null>
  wallpapers: (dir: string) => Promise<WallpaperFile[]>
  applyWallpaper: (path: string) => Promise<boolean>
  outputs: () => Promise<DisplayOutput[]>
  cliExec: (cmd: string) => Promise<string>
  setZoom: (factor: number) => void
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void
}

declare global {
  interface Window {
    cockpit: CockpitApi
  }
}

export type { CockpitApi }
export {}
