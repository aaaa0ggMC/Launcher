import { ipcMain, BrowserWindow, dialog, clipboard } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { readFile } from 'fs/promises'
import { getManifest, watchRoots } from './registry'
import { cliExec } from './cli'
import { runCommand, listCommands } from './commands'

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

  // Clipboard write (copy current view as markdown etc).
  ipcMain.handle('clipboard:write', (_e, text: string) => {
    clipboard.writeText(text ?? '')
  })

  // CLI-first dispatcher: single source of truth for every ability action.
  ipcMain.handle('command:run', async (_e, name: string, args: Record<string, unknown>) =>
    runCommand(name, args ?? {})
  )
  ipcMain.handle('command:list', async () =>
    listCommands().map(({ name, description, usage }) => ({ name, description, usage }))
  )

  // CLI REPL.
  ipcMain.handle('cli:exec', async (_e, cmd: string) => cliExec(cmd))
}

export function startWatching(): void {
  watchRoots()
}
