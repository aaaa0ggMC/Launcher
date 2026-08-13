import { contextBridge, ipcRenderer, webFrame, IpcRendererEvent } from 'electron'

type CommandArgs = Record<string, unknown>

/**
 * window.cockpit.* — every operation is a CLI-first command dispatched through
 * the command registry in the main process (commands.ts). The typed methods
 * below are thin wrappers over `command(...)`, so the UI executes the exact
 * same handlers the CLI uses.
 *
 * NOTE: sandbox: true — preload runs in a restricted context; only Electron
 * built-ins may be required here (no external npm packages).
 */
const cockpit = {
  // -- command dispatcher (CLI-first core) ----------------------------------
  command: (name: string, args: CommandArgs = {}): Promise<unknown> =>
    ipcRenderer.invoke('command:run', name, args),
  listCommands: (): Promise<{ name: string; description: string; usage?: string }[]> =>
    ipcRenderer.invoke('command:list'),

  // config / abilities
  getConfig: (): Promise<Record<string, unknown> | null> =>
    cockpit.command('config.get') as Promise<Record<string, unknown> | null>,
  setConfig: (patch: CommandArgs): Promise<Record<string, unknown>> =>
    cockpit.command('config.set', { patch }) as Promise<Record<string, unknown>>,
  platform: process.platform,
  /** Window-geometry debug heartbeat (COCKPIT_WINDOW_DEBUG=1) — lyrics-window drift diagnosis. */
  windowDebug: process.env.COCKPIT_WINDOW_DEBUG === '1',

  // apps registry
  listApps: (): Promise<unknown> => cockpit.command('apps.list'),
  appsConfig: (): Promise<unknown> => cockpit.command('apps.config'),
  getEntry: (root: string, id: string): Promise<unknown> =>
    cockpit.command('apps.get', { root, id }),
  updateEntry: (root: string, id: string, patch: CommandArgs): Promise<unknown> =>
    cockpit.command('apps.update', { root, id, patch }),
  createEntry: (
    root: string,
    id: string,
    patch: CommandArgs,
    opts?: { mkdir?: boolean }
  ): Promise<unknown> =>
    cockpit.command('apps.create', { root, id, patch, mkdir: opts?.mkdir ?? false }),
  deleteEntry: (root: string, id: string): Promise<unknown> =>
    cockpit.command('apps.delete', { root, id }),
  addRoot: (path: string): Promise<unknown> => cockpit.command('apps.add-root', { path }),
  removeRoot: (path: string): Promise<unknown> => cockpit.command('apps.remove-root', { path }),
  moveRoot: (path: string, dir: -1 | 1): Promise<unknown> =>
    cockpit.command('apps.move-root', { path, dir }),
  rescan: (root: string): Promise<unknown> => cockpit.command('apps.rescan', { root }),

  // background tasks (framework-level)
  btList: (): Promise<unknown> => cockpit.command('background.list'),
  btOutput: (id: string): Promise<unknown> => cockpit.command('background.output', { id }),
  btStart: (opts: Record<string, unknown>): Promise<unknown> =>
    cockpit.command('background.start', opts),
  btJob: (name: string, args: Record<string, unknown>): Promise<unknown> =>
    cockpit.command('background.job', { name, args }),
  btInput: (id: string, data: string): Promise<unknown> =>
    cockpit.command('background.input', { id, data }),
  btSignal: (id: string, signal: string): Promise<unknown> =>
    cockpit.command('background.signal', { id, signal }),
  btStop: (id: string): Promise<unknown> => cockpit.command('background.stop', { id }),
  btKill: (id: string): Promise<unknown> => cockpit.command('background.kill', { id }),
  btRemove: (id: string): Promise<unknown> => cockpit.command('background.remove', { id }),
  btClearFinished: (): Promise<unknown> => cockpit.command('background.clear-finished'),
  btExport: (id: string, path: string): Promise<unknown> =>
    cockpit.command('background.export', { id, path }),

  // mirror
  getMirror: (): Promise<unknown> => cockpit.command('mirror.get'),

  // autostart
  listAutostart: (): Promise<unknown> => cockpit.command('autostart.list'),
  toggleAutostart: (file: string, hidden: boolean): Promise<unknown> =>
    cockpit.command('autostart.toggle', { file, hidden }),

  // systemd
  listSystemd: (): Promise<unknown> => cockpit.command('systemd.list'),
  systemdAction: (name: string, action: string): Promise<unknown> =>
    cockpit.command('systemd.action', { name, action }),

  // docker
  listDocker: (): Promise<unknown> => cockpit.command('docker.list'),
  dockerAction: (name: string, action: string): Promise<unknown> =>
    cockpit.command('docker.action', { name, action }),

  // system / hardware
  stats: (): Promise<unknown> => cockpit.command('system.stats'),
  gpu: (): Promise<unknown> => cockpit.command('hardware.gpu'),
  readPm: (): Promise<unknown> => cockpit.command('hardware.pm'),
  togglePm: (): Promise<unknown> => cockpit.command('hardware.pm-toggle'),

  // display
  wallpapers: (dir: string): Promise<unknown> => cockpit.command('display.wallpapers', { dir }),
  applyWallpaper: (path: string): Promise<unknown> => cockpit.command('display.apply', { path }),
  outputs: (): Promise<unknown> => cockpit.command('display.outputs'),

  // cli
  cliExec: (cmd: string): Promise<string> => ipcRenderer.invoke('cli:exec', cmd),

  // ui zoom (true uniform zoom via Electron webFrame)
  setZoom: (factor: number): void => {
    const clamped = Math.min(Math.max(factor, 0.5), 2.5)
    webFrame.setZoomFactor(clamped)
  },

  // frameless window controls
  windowMinimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  windowToggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
  windowClose: (): Promise<void> => ipcRenderer.invoke('window:close'),
  confirmWindowClose: (): Promise<void> => ipcRenderer.invoke('window:confirm-close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  getWallpaper: (): Promise<string | null> => ipcRenderer.invoke('window:wallpaper'),
  /** Mouse passthrough for the current window (locked desktop lyrics). */
  setWindowLocked: (locked: boolean): Promise<boolean> => ipcRenderer.invoke('window:lock', locked),
  /** Move the current window by a pixel delta (manual drag in a frameless view). */
  moveWindowBy: (dx: number, dy: number): Promise<boolean> =>
    ipcRenderer.invoke('window:move', dx, dy),
  /** Move the current window to an absolute position (anchor/margin placement). */
  moveWindowTo: (x: number, y: number): Promise<boolean> =>
    ipcRenderer.invoke('window:move-to', x, y),
  /** Resize the current window (auto-expand to fit long content). */
  resizeWindow: (w: number, h: number): Promise<boolean> =>
    ipcRenderer.invoke('window:resize', w, h),
  /** Primary display work area ({x, y, width, height}). */
  getWorkArea: (): Promise<{ x: number; y: number; width: number; height: number }> =>
    ipcRenderer.invoke('window:work-area'),
  /** Center horizontally + place per anchor/margin (main-process computed). */
  centerWindow: (anchor: 'top' | 'center' | 'bottom', margin: number): Promise<boolean> =>
    ipcRenderer.invoke('window:center', anchor, margin),
  /** Resize + re-center atomically using the target dims (no stale-bounds drift). */
  autoFitWindow: (
    w: number,
    h: number,
    anchor: 'top' | 'center' | 'bottom',
    margin: number
  ): Promise<boolean> => ipcRenderer.invoke('window:auto-fit', w, h, anchor, margin),

  // child window manager (single-instance per id; the panel controls children
  // cross-window via controlWindow)
  createWindow: (
    spec: Record<string, unknown>
  ): Promise<{ ok: boolean; created?: boolean; error?: string }> =>
    ipcRenderer.invoke('window:create', spec),
  destroyWindow: (id: string): Promise<boolean> => ipcRenderer.invoke('window:destroy', id),
  focusWindow: (id: string): Promise<boolean> => ipcRenderer.invoke('window:focus', id),
  listWindows: (): Promise<unknown> => ipcRenderer.invoke('window:list'),
  controlWindow: (id: string, action: string, patch?: Record<string, unknown>): Promise<boolean> =>
    ipcRenderer.invoke('window:control', id, action, patch),
  pickFile: (opts?: {
    title?: string
    directory?: boolean
    any?: boolean
    filters?: { name: string; extensions: string[] }[]
  }): Promise<string | null> => ipcRenderer.invoke('dialog:pick-file', opts),
  pickSaveFile: (opts?: {
    title?: string
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }): Promise<string | null> => ipcRenderer.invoke('dialog:save-file', opts),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('clipboard:write', text),

  // events (returns unsubscribe)
  on: (channel: string, cb: (...args: unknown[]) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

export type CockpitApi = typeof cockpit

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('cockpit', cockpit)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.cockpit = cockpit
}
