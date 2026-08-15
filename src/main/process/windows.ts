import { BrowserWindow, app, screen } from 'electron'
import { execFile } from 'child_process'
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
  /** optional window title (KWin-rules friendly pattern, e.g. `[AIDJ-Lyrics] <player>`).
   *  Defaults to `id`. Kept stable against the page's <title>. */
  title?: string
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
  /** true = treat the window as an OSD / notification on X11 (EWMH window type
   *  `_NET_WM_WINDOW_TYPE_NOTIFICATION`), so KWin applies OSD rules. No-op on
   *  Wayland (xdg-shell has no window type). */
  osd?: boolean
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

/**
 * Window geometry debug — `COCKPIT_WINDOW_DEBUG=1` enables a 0.5s heartbeat
 * logging every child window's bounds, the display it's on, and the horizontal
 * centering deltas (left/right gaps, offset from the exact center). Used to
 * diagnose the lyrics-window "drifts right" on Windows; harmless when off.
 */
const windowDebug = process.env.COCKPIT_WINDOW_DEBUG === '1'

function debugWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const b = win.getBounds()
  const disp = screen.getDisplayMatching(b)
  const area = disp.workArea
  const expectedX = area.x + Math.round((area.width - b.width) / 2)
  const left = b.x - area.x
  const right = area.x + area.width - (b.x + b.width)
  log.info('[win-debug] geometry', {
    id: win.getTitle(),
    pos: win.getPosition(),
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
    workArea: { x: area.x, y: area.y, width: area.width, height: area.height },
    scale: disp.scaleFactor,
    expectedCenterX: expectedX,
    leftGap: left,
    rightGap: right,
    centerOffset: b.x - expectedX, // >0 = window sits RIGHT of center
    minimized: win.isMinimized()
  })
}

if (windowDebug) {
  setInterval(() => {
    for (const { win } of children.values()) {
      if (!win.isDestroyed()) debugWindow(win)
    }
  }, 500)
  setInterval(() => {
    for (const { win } of children.values()) {
      if (!win.isDestroyed()) void queryKwinGeo(win, 'heartbeat')
    }
  }, 1000)
}

// ---------------------------------------------------------------------------
// KWin ground-truth tap (COCKPIT_WINDOW_DEBUG=1 only). Electron's getBounds()
// lags behind compositor moves on Wayland, so to find out where a window
// REALLY is we load a probe script into KWin which reports the compositor's
// own frameGeometry back to us over D-Bus (KWin scripts expose callDBus).
// ---------------------------------------------------------------------------
let geoTapBus: { disconnect: () => void } | null = null

async function initKwinGeoTap(): Promise<void> {
  if (!isKdeWayland()) return
  try {
    const { sessionBus, interface: ifx } = await import('dbus-next')
    const bus = sessionBus()
    geoTapBus = bus
    class GeoInterface extends ifx.Interface {
      constructor() {
        super('org.linuxcockpit.windebug')
      }
      Geo(caption: string, x: number, y: number, w: number, h: number): void {
        log.info('[win-debug] kwin-geo', { caption, x, y, w, h })
      }
    }
    GeoInterface.configureMembers({
      methods: { Geo: { inSignature: 'siiii', outSignature: '' } }
    })
    const reply: number = await bus.requestName('org.linuxcockpit.windebug', 0)
    bus.export('/Windebug', new GeoInterface())
    log.info('[win-debug] kwin-geo tap', {
      reply,
      owned: reply === 1 || reply === 4,
      busAttached: Boolean(geoTapBus)
    })
  } catch (e) {
    log.info('[win-debug] kwin-geo tap failed', { error: String(e) })
  }
}

/** KWin probe that reports the window's compositor-side frameGeometry. */
function kwinGeoScript(title: string): string {
  const id = escapeJs(title)
  return `const list = workspace.windowList(); const w = list.find(x => x.caption === '${id}') || list.find(x => String(x.caption).includes('${id}')); if (w) { const g = w.frameGeometry; callDBus('org.linuxcockpit.windebug', '/Windebug', 'org.linuxcockpit.windebug', 'Geo', String(w.caption), Math.round(g.x), Math.round(g.y), Math.round(g.width), Math.round(g.height)); } else { callDBus('org.linuxcockpit.windebug', '/Windebug', 'org.linuxcockpit.windebug', 'Geo', 'NOT_FOUND ${id}', 0, 0, 0, 0); }`
}

/** Ask KWin for the window's real geometry (the Geo tap logs it). */
async function queryKwinGeo(win: BrowserWindow, tag: string): Promise<void> {
  if (!windowDebug || !isKdeWayland() || win.isDestroyed()) return
  await kwinRunScript(kwinGeoScript(win.getTitle()))
  log.info('[win-debug] kwin-geo-query', { tag, title: win.getTitle() })
}

/** Debug-mode startup facts (env, session backend, all displays + scales). */
export function startWindowDebug(): void {
  if (!windowDebug) return
  log.info('[win-debug] env', {
    xdgSessionType: process.env.XDG_SESSION_TYPE ?? '',
    kdeFullSession: process.env.KDE_FULL_SESSION ?? '',
    kdeWayland: isKdeWayland(),
    ozone: app.commandLine.getSwitchValue('ozone-platform') || 'unset',
    displays: screen.getAllDisplays().map((d) => ({
      bounds: d.bounds,
      workArea: d.workArea,
      scale: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id
    }))
  })
  void initKwinGeoTap()
}

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
  entry: {
    win: BrowserWindow
    spec: WindowSpec
    startedAt: number
    locked: boolean
    alwaysOnTop: boolean
  }
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

/**
 * Set an EWMH window type on X11 (e.g. `_NET_WM_WINDOW_TYPE_NOTIFICATION` =
 * KWin's OSD/Notification class) so the window manager treats it accordingly.
 * Electron exposes no window-type API, so drive `xprop` with the native handle.
 */
function setX11WindowType(win: BrowserWindow, type: string): void {
  try {
    const handle = win.getNativeWindowHandle()
    const wid = handle.readUInt32LE(0)
    execFile('xprop', [
      '-id',
      String(wid),
      '-f',
      '_NET_WM_WINDOW_TYPE',
      '32a',
      '-set',
      '_NET_WM_WINDOW_TYPE',
      type
    ])
  } catch {
    /* xprop missing / handle unavailable — non-fatal */
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
  // Detect the ACTUAL backend, not the session: the app may run on X11/XWayland
  // (forced via --ozone-platform=x11) inside a Wayland session — then native
  // setPosition/setAlwaysOnTop work and KWin scripting must NOT run.
  const forced = app.commandLine.getSwitchValue('ozone-platform')
  if (forced === 'x11') return false
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
      const scripting = (await bus.getProxyObject('org.kde.KWin', '/Scripting')).getInterface(
        'org.kde.kwin.Scripting'
      ) as unknown as {
        loadScript: (filePath: string) => Promise<number>
        unloadScript: (scriptPath: string) => Promise<void>
      }
      const id = await scripting.loadScript(tmpFile)
      // KWin returns the script id (int) on Plasma 6 / an object path on older
      // versions — handle both.
      const scriptPath = typeof id === 'number' ? `/Scripting/Script${id}` : String(id)
      if (windowDebug) {
        log.info('[win-debug] kwin script loaded', { id: scriptPath, script })
      }
      const scriptIface = (await bus.getProxyObject('org.kde.KWin', scriptPath)).getInterface(
        'org.kde.kwin.Script'
      ) as unknown as { run: () => Promise<void> }
      await scriptIface.run()
      try {
        // unloadScript takes the object PATH string — passing the numeric id
        // (Plasma 6's loadScript return) fails to marshal and leaks the script.
        await scripting.unloadScript(scriptPath)
      } catch {
        // a lingering one-liner is harmless
      }
      log.info('kwin script ran', { id: scriptPath })
    } finally {
      try {
        bus.disconnect()
      } catch {
        /* ignore */
      }
    }
  } catch (e) {
    if (windowDebug) log.info('[win-debug] kwin scripting unavailable', { error: String(e) })
    else log.debug('kwin scripting unavailable', { error: String(e) })
  } finally {
    try {
      await unlink(tmpFile)
    } catch {
      /* ignore */
    }
  }
}

/**
 * KWin 6 move script. VERIFIED via probe: `w.frameGeometry.x = X` is a NO-OP in
 * the QJSEngine (frameGeometry reads as a JS copy), but assigning the WHOLE
 * object `w.frameGeometry = { x, y, width, height }` moves the window to the
 * absolute position. This is the only reliable way.
 *
 * `size` pins width/height explicitly; without it the script preserves KWin's
 * current geometry — which can REVERT a client resize that the compositor has
 * not applied yet (the "shrink never lands" race).
 */
function kwinMoveScript(
  title: string,
  x: number,
  y: number,
  size?: { w: number; h: number }
): string {
  const id = escapeJs(title)
  const dims =
    size !== undefined
      ? `width: ${Math.round(size.w)}, height: ${Math.round(size.h)}`
      : 'width: g.width, height: g.height'
  return `const list = workspace.windowList(); const w = list.find(x => x.caption === '${id}') || list.find(x => String(x.caption).includes('${id}')); if (w) { const g = w.frameGeometry; w.frameGeometry = { x: ${Math.round(
    x
  )}, y: ${Math.round(y)}, ${dims} }; }`
}

/**
 * Move a child window to (x, y) — optionally with an explicit size. Native
 * positions apply on X11/Windows/macOS automatically; on KDE Wayland we
 * re-assert them via KWin scripting — retried a few times so a late-mapped
 * surface still lands correctly.
 */
function moveChildWindow(
  win: BrowserWindow,
  x: number,
  y: number,
  size?: { w: number; h: number }
): void {
  const px = Math.round(x)
  const py = Math.round(y)
  if (!isKdeWayland()) return
  const script = kwinMoveScript(win.getTitle(), px, py, size)
  if (windowDebug) {
    log.info('[win-debug] kwin move scheduled', {
      title: win.getTitle(),
      x: px,
      y: py,
      size,
      electronPos: win.getPosition(),
      electronBounds: win.getBounds()
    })
  }
  // First attempt fast (80ms) to minimize the show→center gap; one retry for
  // the case the compositor hadn't mapped/placed the window yet.
  for (let i = 0; i < 2; i++) {
    setTimeout(
      async () => {
        if (win.isDestroyed()) return
        if (windowDebug) {
          log.info('[win-debug] kwin move attempt', { n: i, title: win.getTitle() })
          await queryKwinGeo(win, `pre-move-${i}`)
        }
        await kwinRunScript(script)
        if (windowDebug) {
          await queryKwinGeo(win, `post-move-${i}`)
          log.info('[win-debug] electron after move', {
            n: i,
            title: win.getTitle(),
            pos: win.getPosition(),
            bounds: win.getBounds()
          })
        }
      },
      80 + i * 400
    )
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
  if (windowDebug) {
    log.info('[win-debug] positionChildWindow', {
      title: win.getTitle(),
      specX: x,
      specY: y,
      bounds: win.getBounds(),
      pos: win.getPosition()
    })
  }
  moveChildWindow(win, x ?? win.getBounds().x, y ?? win.getBounds().y)
}

/**
 * Public sender-scoped move — native setPosition + KWin scripting on KDE
 * Wayland (renderer re-asserts once mounted, when the compositor definitely
 * knows the window). `size` pins the KWin-scripted width/height (auto-fit).
 */
export function moveWindowTo(
  win: BrowserWindow | null,
  x: number,
  y: number,
  size?: { w: number; h: number }
): boolean {
  if (!win || win.isDestroyed()) return false
  const px = Math.round(x)
  const py = Math.round(y)
  if (windowDebug) {
    log.info('[win-debug] moveWindowTo request', {
      title: win.getTitle(),
      x: px,
      y: py,
      size,
      electronPos: win.getPosition(),
      electronBounds: win.getBounds()
    })
  }
  try {
    win.setPosition(px, py)
  } catch {
    /* ignore */
  }
  moveChildWindow(win, px, py, size)
  return true
}

/** Resize a child window (works even with `resizable: false`). */
export function resizeWindowTo(win: BrowserWindow | null, w: number, h: number): boolean {
  if (!win || win.isDestroyed()) return false
  const cw = Math.max(120, Math.round(w))
  const ch = Math.max(60, Math.round(h))
  try {
    // A resizable:false window clamps setSize to its CURRENT minimum — a
    // window that auto-grew can never shrink again, so the lyrics window
    // stayed wide while re-centering by the (smaller) requested width and
    // visibly drifted right. Seen on Windows AND Linux (Wayland logs: shrink
    // requests silently ignored, grows always land). Lower the minimum first
    // so SHRINK takes effect; the next grow re-raises it.
    if (process.platform === 'win32' || process.platform === 'linux') {
      win.setMinimumSize(cw, ch)
    }
    win.setSize(cw, ch)
  } catch (e) {
    log.warn('resizeWindowTo failed', { error: String(e) })
    return false
  }
  return true
}

/** Primary display work area — the renderer's `window.screen` is unreliable on
 *  Wayland, so the main process provides the authoritative geometry. */
export function getPrimaryWorkArea(): { x: number; y: number; width: number; height: number } {
  const a = screen.getPrimaryDisplay().workArea
  return { x: a.x, y: a.y, width: a.width, height: a.height }
}

/**
 * Center a child window horizontally (and place vertically per anchor/margin)
 * using AUTHORITATIVE main-process data: the window's real bounds and the
 * display it's actually on. Skips when the REQUESTED size+position are
 * unchanged (getBounds() is unreliable on Wayland, so never compare against it).
 */
const lastCenter = new WeakMap<BrowserWindow, { x: number; y: number; w: number; h: number }>()
export function centerChildWindow(
  win: BrowserWindow | null,
  anchor: 'top' | 'center' | 'bottom',
  margin: number
): boolean {
  if (!win || win.isDestroyed()) return false
  const b = win.getBounds()
  const area = screen.getDisplayMatching(b).workArea
  const x = area.x + Math.round((area.width - b.width) / 2)
  let y: number
  if (anchor === 'bottom') y = area.y + area.height - b.height - margin
  else if (anchor === 'top') y = area.y + margin
  else y = area.y + Math.round((area.height - b.height) / 2)
  const last = lastCenter.get(win)
  if (last && last.x === x && last.y === y && last.w === b.width && last.h === b.height) {
    if (windowDebug) {
      log.info('[win-debug] centerChildWindow skip (same target + same electron bounds)', {
        id: win.getTitle(),
        target: { x, y },
        electronBounds: { x: b.x, y: b.y, width: b.width, height: b.height }
      })
    }
    return false
  }
  lastCenter.set(win, { x, y, w: b.width, h: b.height })
  if (windowDebug) {
    log.info('[win-debug] centerChildWindow request', {
      id: win.getTitle(),
      anchor,
      margin,
      fromBounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      target: { x, y }
    })
    setTimeout(() => debugWindow(win), 300)
    void queryKwinGeo(win, 'post-center')
  }
  return moveWindowTo(win, x, y)
}

/**
 * Atomically resize a child window to (w, h) AND center it horizontally, using
 * the TARGET dimensions for the centering math — the previous flow re-centered
 * with win.getBounds(), which lags on Wayland after setSize, so every auto-fit
 * grow drifted the window right.
 */
export function resizeAndCenterChildWindow(
  win: BrowserWindow | null,
  w: number,
  h: number,
  anchor: 'top' | 'center' | 'bottom',
  margin: number
): boolean {
  if (!win || win.isDestroyed()) return false
  const cw = Math.max(120, Math.round(w))
  const ch = Math.max(60, Math.round(h))
  const b = win.getBounds()
  const area = screen.getDisplayMatching(b).workArea
  const x = area.x + Math.round((area.width - cw) / 2)
  let y: number
  if (anchor === 'bottom') y = area.y + area.height - ch - margin
  else if (anchor === 'top') y = area.y + margin
  else y = area.y + Math.round((area.height - ch) / 2)
  const last = lastCenter.get(win)
  if (last && last.x === x && last.y === y && last.w === cw && last.h === ch) {
    if (windowDebug) {
      log.info('[win-debug] auto-fit skip (same target)', {
        id: win.getTitle(),
        target: { x, y, width: cw, height: ch }
      })
    }
    return false
  }
  lastCenter.set(win, { x, y, w: cw, h: ch })
  if (windowDebug) {
    log.info('[win-debug] auto-fit request', {
      id: win.getTitle(),
      anchor,
      margin,
      fromBounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      target: { x, y, width: cw, height: ch }
    })
    setTimeout(() => debugWindow(win), 300)
    void queryKwinGeo(win, 'post-autofit')
  }
  resizeWindowTo(win, cw, ch)
  // Pin the KWin script to the TARGET dims — otherwise the script preserves
  // KWin's current (pre-shrink) geometry and reverts the resize if the
  // compositor has not applied it within the 80ms attempt window.
  return moveWindowTo(win, x, y, { w: cw, h: ch })
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
    title: spec.title ?? spec.id,
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
    // X11: advertise the window as an OSD / notification so KWin treats it as
    // one (non-focus-stealing, matching OSD window rules). Wayland has no
    // window type — every xdg-toplevel is "Normal".
    if (spec.osd === true && process.platform === 'linux' && !isKdeWayland()) {
      setX11WindowType(win, '_NET_WM_WINDOW_TYPE_NOTIFICATION')
    }
    if (spec.alwaysOnTop === true) applyAlwaysOnTop(win, true)
    positionChildWindow(win, bounds?.x ?? spec.x, bounds?.y ?? spec.y)
  })
  // Keep the window title stable: the page (shared index.html) sets
  // `Linux Cockpit`, which would otherwise override it — so the taskbar and
  // window lists always show the spec title / id.
  win.on('page-title-updated', (e) => {
    e.preventDefault()
    win.setTitle(spec.title ?? spec.id)
  })
  win.on('closed', () => {
    children.delete(spec.id)
    broadcastChanged()
  })
  win.on('resize', scheduleGeomChanged)
  win.on('move', scheduleGeomChanged)
  if (windowDebug) {
    // Electron's OWN notion of moves/resizes — compared against the KWin geo
    // tap this shows whether/where bounds updates lag behind the compositor.
    win.on('move', () => {
      log.info('[win-debug] electron move event', {
        id: win.getTitle(),
        pos: win.getPosition(),
        bounds: win.getBounds()
      })
    })
    win.on('resize', () => {
      log.info('[win-debug] electron resize event', {
        id: win.getTitle(),
        pos: win.getPosition(),
        bounds: win.getBounds()
      })
    })
  }
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
  log.info('setIgnoreMouseEvents', {
    locked,
    display: process.env.DISPLAY ?? '',
    ozone: process.env.ELECTRON_OZONE_PLATFORM_HINT ?? 'unset'
  })
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
  if (windowDebug) {
    log.info('[win-debug] moveWindowBy', {
      title: win.getTitle(),
      dx,
      dy,
      posBefore: { x, y },
      bounds: win.getBounds()
    })
  }
  win.setPosition(x + dx, y + dy)
  if (windowDebug) {
    log.info('[win-debug] moveWindowBy after setPosition', {
      title: win.getTitle(),
      pos: win.getPosition(),
      bounds: win.getBounds()
    })
  }
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
