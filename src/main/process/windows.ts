import { BrowserWindow } from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeFile, unlink } from 'fs/promises'
import { is } from '@electron-toolkit/utils'
import { makeLogger } from './logger'
import type { ChildWindowInfo, WindowChangedEvent } from '../../shared/types'

/**
 * Window manager — architectural, not tied to any ability.
 *
 * BrowserWindows can only be created by the main process, so the renderer
 * never builds windows directly: it sends a `window.create` spec and this
 * module owns the full lifecycle (create/focus/destroy, geometry memory,
 * close-all-on-main-close). The renderer only renders the content: a child
 * window loads the SAME renderer entry with `?view=<key>`, and the renderer's
 * root switch mounts the matching component from the `windows/` glob.
 *
 * Every live child window is broadcast as `cockpit:windows` and surfaces in
 * the background-task panel under the 「子窗口」 filter category, where the
 * user can toggle always-on-top / frameless / rounded or minimize / maximize /
 * close it (window controls CANNOT change frame/transparent at runtime, so a
 * style change recreates the window preserving bounds + always-on-top).
 */

const log = makeLogger('windows')

export interface WindowSpec {
  /** unique window id — the single-instance key. */
  id: string
  /** renderer view key resolved against the windows/ glob. */
  view: string
  width?: number
  height?: number
  /** explicit position (when set, `center` is disabled). */
  x?: number
  y?: number
  frameless?: boolean
  rounded?: boolean
  shadow?: boolean
  transparent?: boolean
  resizable?: boolean
  alwaysOnTop?: boolean
  skipTaskbar?: boolean
  center?: boolean
}

export type WindowControlAction =
  'minimize' | 'toggle-maximize' | 'restore' | 'close' | 'pin' | 'style' | 'lock'

type Broadcast = (event: WindowChangedEvent) => void

let broadcast: Broadcast = () => {}

export function setWindowBroadcast(fn: Broadcast): void {
  broadcast = fn
}

let main: BrowserWindow | null = null
const children = new Map<
  string,
  { win: BrowserWindow; spec: WindowSpec; startedAt: number; locked: boolean; alwaysOnTop: boolean }
>()

export function setMainWindow(win: BrowserWindow): void {
  main = win
}

export function getMainWindow(): BrowserWindow | null {
  return main
}

/** True when the window is a managed child window (not the main shell). */
export function isChildWindow(win: BrowserWindow | null): boolean {
  return win !== null && win !== main
}

function snapshot(
  id: string,
  entry: { win: BrowserWindow; spec: WindowSpec; startedAt: number; locked: boolean; alwaysOnTop: boolean }
): ChildWindowInfo {
  const b = entry.win.getBounds()
  return {
    id,
    view: entry.spec.view,
    frameless: entry.spec.frameless === true,
    rounded: entry.spec.rounded === true,
    alwaysOnTop: entry.alwaysOnTop,
    locked: entry.locked,
    minimized: entry.win.isMinimized(),
    maximized: entry.win.isMaximized(),
    width: b.width,
    height: b.height,
    startedAt: entry.startedAt
  }
}

export function listChildWindows(): ChildWindowInfo[] {
  const out: ChildWindowInfo[] = []
  for (const [id, entry] of children) {
    if (entry.win.isDestroyed()) continue
    out.push(snapshot(id, entry))
  }
  return out
}

function broadcastChanged(): void {
  try {
    broadcast({ type: 'changed', windows: listChildWindows() })
  } catch {
    // never break the window pipeline on broadcast errors
  }
}

/** Throttled republish on resize/move so the BT window panel stays in sync. */
let geomTimer: NodeJS.Timeout | null = null
function scheduleGeomChanged(): void {
  if (geomTimer) return
  geomTimer = setTimeout(() => {
    geomTimer = null
    broadcastChanged()
  }, 300)
}

function loadView(win: BrowserWindow, view: string, id: string): void {
  const q = `?view=${encodeURIComponent(view)}&id=${encodeURIComponent(id)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + q)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { search: q })
  }
}

/**
 * Apply always-on-top state. Tracks the desired state on the entry
 * (isAlwaysOnTop() can be unreliable on Wayland) and uses the native
 * setAlwaysOnTop — on KDE Wayland the compositor owns stacking order, so
 * users pin such windows manually there.
 */
function applyAlwaysOnTop(win: BrowserWindow, on: boolean): void {
  for (const entry of children.values()) {
    if (entry.win === win) entry.alwaysOnTop = on
  }
  try {
    win.setAlwaysOnTop(on)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// KDE Wayland window placement. Electron's x/y / setPosition are ignored by
// the compositor on Wayland (it owns window positions), so to honor anchor /
// margin placement we push the move through KWin's scripting D-Bus API after
// the window is mapped. X11 / Windows / macOS use the native x/y alone.
//
// NOTE: in KWin 6, `Client.move(x, y)` is GONE — `move` is now a boolean
// property ("being moved interactively"). Position is set via `frameGeometry`:
//   w.frameGeometry = Qt.rect(x, y, w.width, w.height)
// ---------------------------------------------------------------------------

function isKdeWayland(): boolean {
  return (
    process.platform === 'linux' &&
    (process.env.XDG_SESSION_TYPE ?? '').toLowerCase() === 'wayland' &&
    (process.env.KDE_FULL_SESSION ?? '') !== ''
  )
}

function escapeJs(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')
}

/**
 * Run a one-off KWin script (org.kde.kwin.Scripting); errors are swallowed.
 *
 * `loadScript` in current KWin takes a SINGLE string arg and treats it as a
 * FILE PATH (passing script content yields "Could not open <content>"), so we
 * write the script to a temp file first, hand KWin the path, run it, unload,
 * then delete the file.
 */
async function kwinRunScript(script: string): Promise<void> {
  if (!isKdeWayland()) return
  const tmpFile = join(tmpdir(), `cockpit-kwin-${Date.now().toString(36)}.js`)
  try {
    await writeFile(tmpFile, script, 'utf-8')
    const { sessionBus } = await import('dbus-next')
    const bus = sessionBus()
    try {
      const scripting = (
        await bus.getProxyObject('org.kde.KWin', '/Scripting')
      ).getInterface('org.kde.kwin.Scripting') as unknown as {
        loadScript: (filePath: string) => Promise<number>
        unloadScript: (id: number) => Promise<void>
      }
      const id = await scripting.loadScript(tmpFile)
      // KWin returns the script id (int) on Plasma 6 / an object path on older
      // versions — handle both.
      const scriptPath = typeof id === 'number' ? `/Scripting/Script${id}` : String(id)
      const scriptIface = (
        await bus.getProxyObject('org.kde.KWin', scriptPath)
      ).getInterface('org.kde.kwin.Script') as unknown as { run: () => Promise<void> }
      await scriptIface.run()
      try {
        await scripting.unloadScript(id)
      } catch {
        // a lingering one-liner is harmless
      }
      log.info('kwin script ran', { id })
    } finally {
      try {
        bus.disconnect()
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    log.debug('kwin scripting unavailable', { error: String(e) })
  } finally {
    try {
      await unlink(tmpFile)
    } catch {
      /* ignore */
    }
  }
}

/**
 * KWin 6 move script. `move()` is a bool property and there's no `Qt` global in
 * plain-JS scripts — the working pattern is to set the frameGeometry x/y:
 *   w.frameGeometry.x = X; w.frameGeometry.y = Y;
 */
function kwinMoveScript(title: string, x: number, y: number): string {
  const id = escapeJs(title)
  return `const list = workspace.windowList(); const w = list.find(x => x.caption === '${id}') || list.find(x => String(x.caption).includes('${id}')); if (w) { w.frameGeometry.x = ${Math.round(
    x
  )}; w.frameGeometry.y = ${Math.round(y)}; }`
}

/**
 * Move a child window to (x, y). Native positions apply on X11/Windows/macOS
 * automatically; on KDE Wayland we re-assert them via KWin scripting — retried
 * a few times so a late-mapped surface still lands correctly.
 */
function moveChildWindow(win: BrowserWindow, x: number, y: number): void {
  const px = Math.round(x)
  const py = Math.round(y)
  if (!isKdeWayland()) return
  const script = kwinMoveScript(win.getTitle(), px, py)
  for (let i = 0; i < 4; i++) {
    setTimeout(() => void kwinRunScript(script), 300 + i * 350)
  }
}

/**
 * Move a just-shown child window to its requested (x, y). Native positions
 * apply on X11/Windows/macOS automatically; on KDE Wayland we re-assert them
 * via KWin scripting once the compositor has mapped the window.
 */
function positionChildWindow(
  win: BrowserWindow,
  x: number | undefined,
  y: number | undefined
): void {
  if (x === undefined && y === undefined) return
  if (!isKdeWayland()) return
  moveChildWindow(win, x ?? win.getBounds().x, y ?? win.getBounds().y)
}

/**
 * Public sender-scoped move — native setPosition + KWin scripting on KDE
 * Wayland (renderer re-asserts once mounted, when the compositor definitely
 * knows the window).
 */
export function moveWindowTo(win: BrowserWindow | null, x: number, y: number): boolean {
  if (!win || win.isDestroyed()) return false
  const px = Math.round(x)
  const py = Math.round(y)
  try {
    win.setPosition(px, py)
  } catch {
    /* ignore */
  }
  moveChildWindow(win, px, py)
  return true
}

function makeChild(
  spec: WindowSpec,
  bounds?: { x?: number; y?: number; width: number; height: number }
): BrowserWindow {
  const frameless = spec.frameless === true
  const rounded = spec.rounded === true
  const transparent = spec.transparent === true || rounded
  const hasXY = spec.x !== undefined || spec.y !== undefined

  const win = new BrowserWindow({
    x: bounds?.x ?? spec.x,
    y: bounds?.y ?? spec.y,
    width: bounds?.width ?? spec.width ?? 480,
    height: bounds?.height ?? spec.height ?? 720,
    show: false,
    title: spec.id,
    frame: !frameless,
    transparent,
    hasShadow: spec.shadow !== false,
    resizable: spec.resizable !== false,
    alwaysOnTop: spec.alwaysOnTop === true,
    skipTaskbar: spec.skipTaskbar === true,
    center: bounds ? false : hasXY ? false : spec.center !== false,
    backgroundColor: transparent ? '#00000000' : '#121212',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.on('ready-to-show', () => {
    win.show()
    if (spec.alwaysOnTop === true) applyAlwaysOnTop(win, true)
    positionChildWindow(win, bounds?.x ?? spec.x, bounds?.y ?? spec.y)
  })
  // Keep the window title = spec.id: the page (shared index.html) sets
  // `Linux Cockpit`, which would otherwise override it — so the taskbar and
  // window lists always show a stable, identifiable title.
  win.on('page-title-updated', (e) => {
    e.preventDefault()
    win.setTitle(spec.id)
  })
  win.on('closed', () => {
    children.delete(spec.id)
    broadcastChanged()
  })
  win.on('resize', scheduleGeomChanged)
  win.on('move', scheduleGeomChanged)
  return win
}

/**
 * Create a child window (single instance per id): if it already exists, focus
 * it instead. Never duplicates.
 */
export function createChildWindow(
  spec: WindowSpec,
  bounds?: { x?: number; y?: number; width: number; height: number }
): { ok: boolean; created?: boolean; error?: string } {
  if (!spec.id || !spec.view) {
    return { ok: false, error: 'window create requires id + view' }
  }
  const existing = children.get(spec.id)
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore()
    existing.win.focus()
    return { ok: true, created: false }
  }
  if (existing) children.delete(spec.id)

  const win = makeChild(spec, bounds)
  children.set(spec.id, {
    win,
    spec,
    startedAt: Date.now(),
    locked: false,
    alwaysOnTop: spec.alwaysOnTop === true
  })
  loadView(win, spec.view, spec.id)
  log.info('child window created', { id: spec.id, view: spec.view })
  broadcastChanged()
  return { ok: true, created: true }
}

export function destroyChildWindow(id: string): boolean {
  const entry = children.get(id)
  if (!entry || entry.win.isDestroyed()) return false
  entry.win.close()
  return true
}

export function focusChildWindow(id: string): boolean {
  const entry = children.get(id)
  if (!entry || entry.win.isDestroyed()) return false
  entry.win.focus()
  return true
}

/**
 * Apply a control action to a child window.
 *  - `pin` toggles always-on-top (runtime-safe)
 *  - `style` ({ frameless?, rounded? }) recreates the window — `frame` and
 *    `transparent` cannot change at runtime — preserving bounds + pin state
 *  - the rest map to native window operations
 */
export function controlChildWindow(
  id: string,
  action: WindowControlAction,
  patch?: Record<string, unknown>
): boolean {
  const entry = children.get(id)
  if (!entry || entry.win.isDestroyed()) return false
  const win = entry.win
  switch (action) {
    case 'minimize':
      win.minimize()
      break
    case 'toggle-maximize':
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      break
    case 'restore':
      if (win.isMinimized()) win.restore()
      else if (win.isMaximized()) win.unmaximize()
      break
    case 'close':
      win.close()
      break
    case 'pin':
      applyAlwaysOnTop(win, !entry.alwaysOnTop)
      break
    case 'lock':
      // mouse passthrough toggle — once locked the window can't be clicked,
      // so unlock happens from the BT panel (or a style change re-creates it).
      setChildLocked(entry, !entry.locked)
      break
    case 'style': {
      const frameless =
        typeof patch?.frameless === 'boolean' ? patch.frameless : entry.spec.frameless
      const rounded = typeof patch?.rounded === 'boolean' ? patch.rounded : entry.spec.rounded
      if (frameless === entry.spec.frameless && rounded === entry.spec.rounded) return true
      const bounds = win.getBounds()
      const alwaysOnTop = entry.alwaysOnTop
      const locked = entry.locked
      const id = entry.spec.id
      win.destroy()
      createChildWindow({ ...entry.spec, frameless, rounded, alwaysOnTop }, bounds)
      if (locked) {
        const fresh = children.get(id)
        if (fresh) setChildLocked(fresh, true)
      }
      return true
    }
    default:
      return false
  }
  broadcastChanged()
  return true
}

/**
 * Apply (or remove) mouse passthrough on a child window: with ignoreMouseEvents
 * the window stops receiving any pointer input — the classic "locked desktop
 * lyrics" behavior. `forward: true` still forwards mousemove so the renderer
 * could keep hover states, but clicks/context menus pass straight through.
 */
function setChildLocked(entry: { win: BrowserWindow; locked: boolean }, locked: boolean): void {
  entry.locked = locked
  try {
    entry.win.setIgnoreMouseEvents(locked, { forward: true })
  } catch {
    // ignore
  }
}

/**
 * Sender-scoped lock toggle (used by a child window's own right-click menu —
 * the lock itself then makes the window unclickable, so unlock is via the BT
 * panel). Returns false when the sender is not a managed child window.
 */
export function setSenderWindowLocked(win: BrowserWindow | null, locked: boolean): boolean {
  for (const entry of children.values()) {
    if (entry.win === win) {
      setChildLocked(entry, locked)
      broadcastChanged()
      return true
    }
  }
  return false
}

/** Move a window by a pixel delta (manual drag from a frameless renderer). */
export function moveWindowBy(win: BrowserWindow | null, dx: number, dy: number): boolean {
  if (!win || win.isDestroyed()) return false
  const [x, y] = win.getPosition()
  win.setPosition(x + dx, y + dy)
  return true
}

/** Close every child window immediately (main window closed / app quitting). */
export function closeAllChildren(): void {
  for (const { win } of children.values()) {
    if (!win.isDestroyed()) win.destroy()
  }
  children.clear()
  if (geomTimer) {
    clearTimeout(geomTimer)
    geomTimer = null
  }
}
