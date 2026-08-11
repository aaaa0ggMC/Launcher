import { ipcMain, BrowserWindow, dialog, clipboard } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { cliExec } from './cli'
import { runCommand, listCommands, UnknownCommandError } from './commands/registry'

/** Argument keys whose values should never land in the log (config patches,
 *  file payloads, credentials). */
const SENSITIVE_KEYS = new Set(['patch', 'data', 'password', 'token', 'secret', 'apiKey', 'env'])

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args ?? {})) {
    out[k] = SENSITIVE_KEYS.has(k) ? '<redacted>' : v
  }
  return out
}
import { makeLogger } from './logger'
import {
  createChildWindow,
  destroyChildWindow,
  focusChildWindow,
  controlChildWindow,
  listChildWindows,
  setSenderWindowLocked,
  moveWindowBy,
  moveWindowTo,
  resizeWindowTo,
  getPrimaryWorkArea,
  centerChildWindow,
  resizeAndCenterChildWindow,
  type WindowSpec,
  type WindowControlAction
} from './windows'

const log = makeLogger('ipc')

/** The window that actually sent a request (main or a managed child window). */
function senderWindow(e: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

/**
 * Resolve the current KDE desktop wallpaper path by parsing
 * ~/.config/plasma-org.kde.plasma.desktop-appletsrc (Image=file://...).
 * Used for the `wallpaper` background preset. Returns null if not found.
 */
async function kdeWallpaperPath(): Promise<string | null> {
  try {
    const cfg = join(homedir(), '.config', 'plasma-org.kde.plasma.desktop-appletsrc')
    const raw = await readFile(cfg, 'utf-8')
    const m = raw.match(/Image=file:\/\/([^\s#]+)/)
    return m ? decodeURIComponent(m[1]) : null
  } catch {
    return null
  }
}
/**
 * window.cockpit.* IPC surface. All operations route through the CLI-first
 * command registry (commands.ts); the per-ability channels below are thin
 * passthroughs so the UI executes the exact same command handlers as the CLI.
 */
export function registerIpc(): void {
  // Frameless window controls (Linux/Wayland: no native title bar). These are
  // sender-scoped: a child window (lyrics etc.) controls ITSELF, never the main
  // shell — the BT panel manages children cross-window via `window:control`.
  ipcMain.handle('window:minimize', (e) => {
    senderWindow(e)?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', (e) => {
    const win = senderWindow(e)
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', (e) => {
    senderWindow(e)?.close()
  })
  ipcMain.handle('window:is-maximized', (e) => senderWindow(e)?.isMaximized() ?? false)
  // Mouse passthrough + manual drag — self-service ops for frameless children
  // (desktop lyrics). Lock makes the window unclickable; unlock is via the BT
  // panel (`window:control --action lock`) since the window itself can't.
  ipcMain.handle('window:lock', (e, locked: boolean) =>
    setSenderWindowLocked(senderWindow(e), locked === true)
  )
  ipcMain.handle('window:move', (e, dx: number, dy: number) =>
    moveWindowBy(senderWindow(e), Number(dx) || 0, Number(dy) || 0)
  )
  // Absolute reposition — a child window re-asserts its configured
  // anchor/margin placement once mounted (KWin scripting on KDE Wayland).
  ipcMain.handle('window:move-to', (e, x: number, y: number) =>
    moveWindowTo(senderWindow(e), Number(x) || 0, Number(y) || 0)
  )
  // Programmatic resize — used by the lyrics window to auto-expand to fit long
  // lines (works even when the window was created non-resizable).
  ipcMain.handle('window:resize', (e, w: number, h: number) =>
    resizeWindowTo(senderWindow(e), Number(w) || 0, Number(h) || 0)
  )
  // Primary display work area — the renderer's window.screen is unreliable on
  // Wayland, so anchor/center placement queries it from the main process.
  ipcMain.handle('window:work-area', () => getPrimaryWorkArea())
  // Center horizontally + place per anchor/margin, computed in the main process
  // from the window's real bounds + the display it is on.
  ipcMain.handle('window:center', (e, anchor: string, margin: number) =>
    centerChildWindow(
      senderWindow(e),
      anchor === 'bottom' ? 'bottom' : anchor === 'top' ? 'top' : 'center',
      Number(margin) || 0
    )
  )
  // Resize + re-center atomically using the TARGET dimensions (avoids the
  // stale-bounds drift on Wayland).
  ipcMain.handle('window:auto-fit', (e, w: number, h: number, anchor: string, margin: number) =>
    resizeAndCenterChildWindow(
      senderWindow(e),
      Number(w) || 0,
      Number(h) || 0,
      anchor === 'bottom' ? 'bottom' : anchor === 'top' ? 'top' : 'center',
      Number(margin) || 0
    )
  )

  // Child window manager — BrowserWindows can only be created in the main
  // process; the renderer sends a declarative spec and this owns lifecycle.
  ipcMain.handle('window:create', (_e, spec: WindowSpec) => createChildWindow(spec))
  ipcMain.handle('window:destroy', (_e, id: string) => destroyChildWindow(id))
  ipcMain.handle('window:focus', (_e, id: string) => focusChildWindow(id))
  ipcMain.handle('window:list', () => listChildWindows())
  ipcMain.handle(
    'window:control',
    (_e, id: string, action: WindowControlAction, patch?: Record<string, unknown>) =>
      controlChildWindow(id, action, patch)
  )

  // Desktop wallpaper for the `wallpaper` background preset.
  ipcMain.handle('window:wallpaper', async () => kdeWallpaperPath())

  // Native file/directory picker (image paths for backgrounds/icons, or an
  // app search root). `directory: true` opens the folder chooser instead,
  // `any: true` allows selecting either a file or a folder.
  ipcMain.handle(
    'dialog:pick-file',
    async (
      _e,
      opts?: {
        title?: string
        directory?: boolean
        any?: boolean
        filters?: { name: string; extensions: string[] }[]
      }
    ) => {
      const isDir = opts?.directory === true
      const isAny = opts?.any === true
      const properties: Array<'openFile' | 'openDirectory'> = isAny
        ? ['openFile', 'openDirectory']
        : isDir
          ? ['openDirectory']
          : ['openFile']
      const res = await dialog.showOpenDialog(senderWindow(_e) ?? undefined!, {
        title: opts?.title ?? (isDir ? '选择目录' : '选择文件'),
        properties,
        filters: isDir || isAny ? undefined : (opts?.filters ?? [])
      })
      return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
    }
  )

  // Save-as dialog (e.g. exporting a vectors JSON file).
  ipcMain.handle(
    'dialog:save-file',
    async (
      _e,
      opts?: {
        title?: string
        defaultPath?: string
        filters?: { name: string; extensions: string[] }[]
      }
    ) => {
      const res = await dialog.showSaveDialog(senderWindow(_e) ?? undefined!, {
        title: opts?.title ?? '保存文件',
        defaultPath: opts?.defaultPath,
        filters: opts?.filters
      })
      return res.canceled || !res.filePath ? null : res.filePath
    }
  )

  // Clipboard write (copy current view as markdown etc).
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text ?? '')
  })

  // CLI-first dispatcher: single source of truth for every ability action.
  ipcMain.handle('command:run', async (_e, name: string, args: Record<string, unknown>) => {
    // Log the concrete command + its (redacted) args. The file always keeps
    // these (even `logs.*`) — the logs ability filters them via `excludeSelf`.
    log.info(name, { args: redactArgs(args ?? {}) })
    try {
      return await runCommand(name, args ?? {})
    } catch (err) {
      // Command not registered (backing ability removed etc.) — notify every
      // window so the renderer can show a friendly toast, then rethrow so
      // existing callers keep their current error semantics.
      if (err instanceof UnknownCommandError) {
        log.warn('unknown command', err.commandName)
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('cockpit:command-error', err.commandName)
        }
      } else {
        log.error(`${name} failed`, err instanceof Error ? err.message : String(err))
      }
      throw err
    }
  })
  ipcMain.handle('command:list', async () =>
    listCommands().map(({ name, description, usage }) => ({ name, description, usage }))
  )

  // CLI REPL.
  ipcMain.handle('cli:exec', async (_e, cmd: string) => cliExec(cmd))
}
