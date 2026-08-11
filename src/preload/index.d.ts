import type {
  AbilitiesManifest,
  LaunchResult,
  BtOutputMessage,
  BtTaskInfo,
  ChildWindowInfo
} from '../shared/types'
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
  btList: () => Promise<BtTaskInfo[]>
  btOutput: (id: string) => Promise<{ ok: boolean; id: string; messages: BtOutputMessage[] }>
  btStart: (
    opts: Record<string, unknown>
  ) => Promise<{ ok: boolean; task?: BtTaskInfo; error?: string }>
  btJob: (
    name: string,
    args: Record<string, unknown>
  ) => Promise<{ ok: boolean; task?: BtTaskInfo; error?: string }>
  btInput: (id: string, data: string) => Promise<{ ok: boolean; error?: string }>
  btSignal: (id: string, signal: string) => Promise<{ ok: boolean; error?: string }>
  btStop: (id: string) => Promise<{ ok: boolean; error?: string }>
  btKill: (id: string) => Promise<{ ok: boolean; error?: string }>
  btRemove: (id: string) => Promise<{ ok: boolean; error?: string }>
  btClearFinished: () => Promise<{ ok: boolean; removed?: number; error?: string }>
  btExport: (id: string, path: string) => Promise<{ ok: boolean; lines?: number; error?: string }>
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
  confirmWindowClose: () => Promise<void>
  isMaximized: () => Promise<boolean>
  getWallpaper: () => Promise<string | null>
  setWindowLocked: (locked: boolean) => Promise<boolean>
  moveWindowBy: (dx: number, dy: number) => Promise<boolean>
  moveWindowTo: (x: number, y: number) => Promise<boolean>
  resizeWindow: (w: number, h: number) => Promise<boolean>
  getWorkArea: () => Promise<{ x: number; y: number; width: number; height: number }>
  createWindow: (
    spec: Record<string, unknown>
  ) => Promise<{ ok: boolean; created?: boolean; error?: string }>
  destroyWindow: (id: string) => Promise<boolean>
  focusWindow: (id: string) => Promise<boolean>
  listWindows: () => Promise<ChildWindowInfo[]>
  controlWindow: (id: string, action: string, patch?: Record<string, unknown>) => Promise<boolean>
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
