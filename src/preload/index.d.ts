import type { AbilitiesManifest, LaunchResult } from '../shared/types'
import type { AppEntry } from '../abilities/apps/types'
import type { AutostartEntry } from '../abilities/autostart/types'
import type { DisplayOutput } from '../abilities/display/types'
import type { DockerContainer, GpuInfo, SystemStats } from '../abilities/dashboard/types'
import type { MirrorInfo } from '../abilities/mirror/types'
import type { SystemdUnit } from '../abilities/systemd/types'
import type { WallpaperFile } from '../abilities/display/types'

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
  createEntry: (
    root: string,
    id: string,
    patch: Partial<AppEntry>,
    opts?: { mkdir?: boolean }
  ) => Promise<AppEntry>
  deleteEntry: (root: string, id: string) => Promise<void>
  addRoot: (path: string) => Promise<AppsConfig['searchRoots']>
  removeRoot: (path: string) => Promise<AppsConfig['searchRoots']>
  appsConfig: () => Promise<AppsConfig>
  rescan: (root: string) => Promise<unknown>
  launch: (root: string, id: string) => Promise<LaunchResult>
  launchAction: (root: string, id: string, action: string) => Promise<LaunchResult>
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
  windowMinimize: () => Promise<void>
  windowToggleMaximize: () => Promise<boolean>
  windowClose: () => Promise<void>
  isMaximized: () => Promise<boolean>
  getWallpaper: () => Promise<string | null>
  pickFile: (opts?: {
    title?: string
    directory?: boolean
    any?: boolean
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<string | null>
  pickSaveFile: (opts?: {
    title?: string
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }) => Promise<string | null>
  copyText: (text: string) => Promise<void>
  on: (channel: string, cb: (...args: unknown[]) => void) => () => void
}

declare global {
  interface Window {
    cockpit: CockpitApi
  }
}

export type { CockpitApi }
export {}
