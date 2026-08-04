import { ipcMain, BrowserWindow, dialog, clipboard } from 'electron'
import { homedir } from 'os'
import { join } from 'path'
import { readFile, access } from 'fs/promises'
import { getManifest, watchRoots } from './registry'
import { cliExec } from './cli'
import { runCommand, listCommands, UnknownCommandError } from './commands'

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

/** Expand `$HOME` / `~/` in a config value. */
function expandHome(p: string): string {
  if (!p) return p
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  if (p.includes('$HOME')) return p.replaceAll('$HOME', homedir())
  return p
}

/**
 * Resolve the current KDE desktop wallpaper path by parsing
 * ~/.config/plasma-org.kde.plasma.desktop-appletsrc.
 * Used for the `wallpaper` background preset. Returns null if not found.
 *
 * Two wallpaper backends are supported:
 *  1. Standard `org.kde.image` → `Image=file://...`
 *  2. kde-wallpaper-engine (com.github.catsout.wallpaperEngineKde) →
 *     derives the Steam Workshop `preview.jpg` from WallpaperSource /
 *     SteamLibraryPath + WallpaperWorkShopId (the plugin stores no static
 *     Image= line; the preview frame is the closest static still).
 */
async function kdeWallpaperPath(): Promise<string | null> {
  try {
    const cfg = join(homedir(), '.config', 'plasma-org.kde.plasma.desktop-appletsrc')
    const raw = await readFile(cfg, 'utf-8')

    // 1. Standard image wallpaper.
    const img = raw.match(/Image=file:\/\/([^\s#]+)/)
    if (img) return decodeURIComponent(img[1])

    // 2. kde-wallpaper-engine: no Image= line, so resolve the workshop
    //    preview frame.
    const src = raw.match(/WallpaperSource\[\$e\]=file:([^\n]+)/)
    const steamLib = raw.match(/SteamLibraryPath\[\$e\]=file:([^\n]+)/)
    const workshopId = raw.match(/WallpaperWorkShopId=(\d+)/)
    if (src) {
      // e.g. file:$HOME/.local/share/Steam/.../content/431960/<id>/scene.json+scene
      const p = expandHome(src[1].trim())
      const contentIdx = p.indexOf('steamapps/workshop/content/')
      if (contentIdx >= 0) {
        const base = p.slice(0, contentIdx)
        // scene.json+scene may not exist; the plugin ships preview.jpg.
        const preview = join(base, 'steamapps', 'workshop', 'content', '431960')
        const idDir = workshopId ? workshopId[1] : null
        if (idDir) {
          const candidate = join(preview, idDir, 'preview.jpg')
          try {
            await access(candidate)
            return candidate
          } catch {
            /* preview not shipped for this wallpaper */
          }
        }
      }
      // Fallback: nearest dir from the source path + preview.jpg.
      const dir = p.slice(0, p.indexOf('scene.json') >= 0 ? p.indexOf('scene.json') : p.length)
      const fb = join(dir.trim().replace(/\+scene$/, ''), 'preview.jpg')
      try {
        await access(fb)
        return fb
      } catch {
        /* ignore */
      }
    }
    if (steamLib && workshopId) {
      const base = expandHome(steamLib[1].trim())
      const candidate = join(
        base,
        'steamapps',
        'workshop',
        'content',
        '431960',
        workshopId[1],
        'preview.jpg'
      )
      try {
        await access(candidate)
        return candidate
      } catch {
        /* ignore */
      }
    }
    return null
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
  ipcMain.handle('command:run', async (_e, name: string, args: Record<string, unknown>) => {
    try {
      return await runCommand(name, args ?? {})
    } catch (err) {
      // Command not registered (backing ability removed etc.) — notify every
      // window so the renderer can show a friendly toast, then rethrow so
      // existing callers keep their current error semantics.
      if (err instanceof UnknownCommandError) {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('cockpit:command-error', err.commandName)
        }
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
  watchRoots()
}
