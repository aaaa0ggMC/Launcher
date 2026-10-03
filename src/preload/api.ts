/**
 * window.cockpit 的完整定义——与传输层无关。
 * Electron preload 用 ipcRenderer 实现 `CockpitTransport`；网页 / Termux 模式用 HTTP + SSE 实现
 * （src/headless/web-shim.ts）。能力不支持的 IPC 通道由传输层 nop（返回 null / false）。
 */
type CommandArgs = Record<string, unknown>

/**
 * 宿主能力档位：`native` 宿主原生支持 / `web` 浏览器等价或降级实现 / `none` 没有（对应通道被 nop）。
 * 未在表里声明的 id 视为 `native`（Electron 全部原生，不需要声明）。
 * 现有 id：window.frame（最小化/最大化/关闭）、window.child（子窗口）、file.pick、file.save、
 * clipboard、external（打开外部链接）、shortcut.global、screenshot、privacy.consent、
 * host.wallpaper（读取桌面壁纸）。
 */
export type HostCap = 'native' | 'web' | 'none'

export interface CockpitTransport {
  /** 能力档位表（缺省 = 全部 native） */
  caps?: Record<string, HostCap>
  /** 自定义协议 URL → 宿主可访问的 URL（网页模式映射到 /_p/...；缺省原样） */
  hostUrl?(url: string): string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke(channel: string, ...args: unknown[]): Promise<any>
  on(channel: string, cb: (...args: unknown[]) => void): () => void
  platform: string
  wayland: boolean
  windowDebug: boolean
  yarjDebug: boolean
  setZoom(factor: number): void
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function createCockpit(t: CockpitTransport) {
  /**
   * Agent-input window (inspector, docs/agent-access-design.md §2.1): right
   * before injecting a click / key into this page the main process sends
   * `cockpit:agent-input`; IPC commands issued while it is active are tagged so
   * the main process attributes them to the agent (`agent-ui`). The tag can only
   * DOWNGRADE privileges — the main process never trusts a renderer upgrade.
   */
  let agentInput: { session: string; until: number } | null = null
  t.on('cockpit:agent-input', (arg) => {
    const v = arg as { session?: unknown; until?: unknown } | undefined
    agentInput =
      typeof v?.session === 'string' && typeof v?.until === 'number'
        ? { session: v.session, until: v.until }
        : null
  })
  function agentMeta(): { agentSession: string } | undefined {
    return agentInput && Date.now() < agentInput.until
      ? { agentSession: agentInput.session }
      : undefined
  }

  const cockpit = {
    /** 该宿主能力的档位 */
    cap: (id: string): HostCap => t.caps?.[id] ?? 'native',
    /** 宿主能否做这件事（`web` 降级也算能）；UI 用它决定显示 / 隐藏 */
    hasCap: (id: string): boolean => (t.caps?.[id] ?? 'native') !== 'none',
    /** cockpit-icon:// / cockpit-audio:// / cockpit-tile:// → 当前宿主可加载的 URL */
    hostUrl: (url: string): string => t.hostUrl?.(url) ?? url,
    // -- command dispatcher (CLI-first core) ----------------------------------
    command: (name: string, args: CommandArgs = {}): Promise<unknown> =>
      t.invoke('command:run', name, args, agentMeta()),
    listCommands: (): Promise<{ name: string; description: string; usage?: string }[]> =>
      t.invoke('command:list'),

    // config / abilities
    getConfig: (): Promise<Record<string, unknown> | null> =>
      cockpit.command('config.get') as Promise<Record<string, unknown> | null>,
    setConfig: (patch: CommandArgs): Promise<Record<string, unknown>> =>
      cockpit.command('config.set', { patch }) as Promise<Record<string, unknown>>,
    platform: t.platform,
    /** Wayland session (no input passthrough → locked lyrics window shrinks to
     *  the card so it doesn't block a wide strip; other platforms grow-only). */
    wayland: t.platform === 'linux' && t.wayland,
    /** Window-geometry debug heartbeat (COCKPIT_WINDOW_DEBUG=1) — lyrics-window drift diagnosis. */
    windowDebug: t.windowDebug,
    /** yarj 地图能力调试日志 (COCKPIT_YARJ_DEBUG=1) — 输出实际生效的 style/filter/LOD 状态。 */
    yarjDebug: t.yarjDebug,

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
    btRestart: (id: string): Promise<unknown> => cockpit.command('background.restart', { id }),

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
    cliExec: (cmd: string): Promise<string> => t.invoke('cli:exec', cmd, agentMeta()),

    // ui zoom (true uniform zoom via Electron webFrame)
    setZoom: (factor: number): void => {
      t.setZoom(Math.min(Math.max(factor, 0.5), 2.5))
    },

    // frameless window controls
    windowMinimize: (): Promise<void> => t.invoke('window:minimize'),
    windowToggleMaximize: (): Promise<boolean> => t.invoke('window:toggle-maximize'),
    windowClose: (): Promise<void> => t.invoke('window:close'),
    confirmWindowClose: (): Promise<void> => t.invoke('window:confirm-close'),
    isMaximized: (): Promise<boolean> => t.invoke('window:is-maximized'),
    getWallpaper: (): Promise<string | null> => t.invoke('window:wallpaper'),
    /** Mouse passthrough for the current window (locked desktop lyrics). */
    setWindowLocked: (locked: boolean): Promise<boolean> => t.invoke('window:lock', locked),
    /** Move the current window by a pixel delta (manual drag in a frameless view). */
    moveWindowBy: (dx: number, dy: number): Promise<boolean> => t.invoke('window:move', dx, dy),
    /** Move the current window to an absolute position (anchor/margin placement). */
    moveWindowTo: (x: number, y: number): Promise<boolean> => t.invoke('window:move-to', x, y),
    /** Resize the current window (auto-expand to fit long content). */
    resizeWindow: (w: number, h: number): Promise<boolean> => t.invoke('window:resize', w, h),
    /** Primary display work area ({x, y, width, height}). */
    getWorkArea: (): Promise<{ x: number; y: number; width: number; height: number }> =>
      t.invoke('window:work-area'),
    /** Center horizontally + place per anchor/margin (main-process computed). */
    centerWindow: (anchor: 'top' | 'center' | 'bottom', margin: number): Promise<boolean> =>
      t.invoke('window:center', anchor, margin),
    /** Resize + re-center atomically using the target dims (no stale-bounds drift). */
    autoFitWindow: (
      w: number,
      h: number,
      anchor: 'top' | 'center' | 'bottom',
      margin: number
    ): Promise<boolean> => t.invoke('window:auto-fit', w, h, anchor, margin),

    // child window manager (single-instance per id; the panel controls children
    // cross-window via controlWindow)
    createWindow: (
      spec: Record<string, unknown>
    ): Promise<{ ok: boolean; created?: boolean; error?: string }> =>
      t.invoke('window:create', spec),
    destroyWindow: (id: string): Promise<boolean> => t.invoke('window:destroy', id),
    focusWindow: (id: string): Promise<boolean> => t.invoke('window:focus', id),
    listWindows: (): Promise<unknown> => t.invoke('window:list'),
    controlWindow: (
      id: string,
      action: string,
      patch?: Record<string, unknown>
    ): Promise<boolean> => t.invoke('window:control', id, action, patch),
    pickFile: (opts?: {
      title?: string
      directory?: boolean
      any?: boolean
      filters?: { name: string; extensions: string[] }[]
    }): Promise<string | null> => t.invoke('dialog:pick-file', opts),
    pickSaveFile: (opts?: {
      title?: string
      defaultPath?: string
      filters?: { name: string; extensions: string[] }[]
    }): Promise<string | null> => t.invoke('dialog:save-file', opts),
    copyText: (text: string): Promise<void> => t.invoke('clipboard:write', text),
    /** 同步系统级全局快捷键（仅用户界面；返回每个 id 的注册结果） */
    syncGlobalShortcuts: (
      entries: { id: string; combo: string }[]
    ): Promise<Record<string, { ok: boolean; error?: 'invalid' | 'taken' | 'unsupported' }>> =>
      t.invoke('shortcut:sync-global', entries),
    /** 截图模式（仅用户界面；agent 视图被主进程拒绝） */
    screenshotCapture: (): Promise<string | null> => t.invoke('screenshot:capture'),
    screenshotSave: (dataUrl: string): Promise<{ file: string; copied: boolean } | null> =>
      t.invoke('screenshot:save', dataUrl),
    openExternal: (url: string): Promise<void> => t.invoke('shell:open-external', url),

    // privacy consent window ONLY — the main process rejects these from any other
    // sender (privacy-consent.ts), so exposing them everywhere grants nothing.
    privacyPending: (): Promise<unknown[]> => t.invoke('privacy:pending'),
    privacyDecide: (id: string, decision: 'deny' | 'once' | 'session'): Promise<boolean> =>
      t.invoke('privacy:decide', id, decision),
    privacyDenyAll: (): Promise<number> => t.invoke('privacy:deny-all'),

    /** agent 视图里 App 外壳的「返回我的界面 / 关闭」——只有 agent 视图发来的才会被主进程接受 */
    agentViewControl: (
      action: 'back' | 'close-app' | 'take-over',
      payload?: { scope: string; key: string }
    ): Promise<boolean> => t.invoke('agent-view:control', action, payload),

    // events (returns unsubscribe)
    on: (channel: string, cb: (...args: unknown[]) => void): (() => void) => t.on(channel, cb)
  }

  return cockpit
}

export type CockpitApi = ReturnType<typeof createCockpit>
