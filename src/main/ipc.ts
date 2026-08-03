import { ipcMain, BrowserWindow } from 'electron'
import { getManifest, watchRoots } from './registry'
import { cliExec } from './cli'
import { runCommand, listCommands } from './commands'

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
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
