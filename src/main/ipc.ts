import { ipcMain } from 'electron'
import { getManifest, watchRoots } from './registry'
import { cliExec } from './cli'
import { runCommand, listCommands } from './commands'

/**
 * window.cockpit.* IPC surface. All operations route through the CLI-first
 * command registry (commands.ts); the per-ability channels below are thin
 * passthroughs so the UI executes the exact same command handlers as the CLI.
 */
export function registerIpc(): void {
  // App chrome (not an ability operation).
  ipcMain.handle('abilities:manifest', async () => getManifest())

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
