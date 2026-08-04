import { ipcMain, BrowserWindow, dialog, clipboard } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { getManifest } from './manifest'
import { watchRoots } from '../../abilities/apps/registry'
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

const log = makeLogger('ipc')

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
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
  // App chrome (not an ability operation).
  ipcMain.handle('abilities:manifest', async () => getManifest())

  // Frameless window controls (Linux/Wayland: no native title bar).
  ipcMain.handle('window:minimize', () => {
    mainWindow()?.minimize()
  })
  ipcMain.handle('window:toggle-maximize', () => {
    const win = mainWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  ipcMain.handle('window:close', () => {
    mainWindow()?.close()
  })
  ipcMain.handle('window:is-maximized', () => mainWindow()?.isMaximized() ?? false)

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
      const res = await dialog.showOpenDialog(mainWindow() ?? undefined!, {
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
      const res = await dialog.showSaveDialog(mainWindow() ?? undefined!, {
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
    // these (even `logs.*`) — the UI just filters them via `excludeSelf`.
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

export function startWatching(): void {
  log.info('start watching app roots')
  watchRoots()
}
