import { app, shell, BrowserWindow, protocol, ipcMain } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './process/ipc'
import { registerIconProtocol } from './process/icon-protocol'
import { loadExternalAbilities } from './process/ability-loader'
import { registerAbilityCommands } from './process/abilities-loader'
import { setBroadcast } from './process/broadcast'
import { runStartupHooks } from './process/startup'
import {
  setBackgroundBroadcast,
  shutdownBackgroundTasks,
  runningTaskCount
} from './process/background-tasks'
import { setMainWindow, setWindowBroadcast, closeAllChildren } from './process/windows'
import { readJson } from './process/util'
import { CONFIG_JSON } from './process/paths'
import { setLogBroadcast, log } from './process/logger'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cockpit-icon',
    // NOTE: must NOT be `standard: true`. With a standard scheme, the encoded
    // absolute path (`cockpit-icon://%2Fhome%2F...`) puts `%2F` in the URL
    // authority, which Chromium rejects → no request ever reaches the handler.
    // As a non-standard (opaque) scheme the whole URL is passed through as-is.
    privileges: { secure: true, supportFetchAPI: true, stream: true }
  }
])

let mainWindow: BrowserWindow | null = null
// Once the user has confirmed quitting (or confirmed via the renderer), the
// next close request is allowed to proceed without re-prompting.
let quitApproved = false

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

async function createWindow(): Promise<void> {
  const cfg = await readJson<{
    window?: {
      width?: number
      height?: number
      frameless?: boolean
      rounded?: boolean
      fuseAlpha?: number
    }
  }>(CONFIG_JSON)
  const { width = 1280, height = 800 } = cfg?.window ?? {}
  // Frameless + rounded corners are config options (settings → 显示) applied on
  // next launch. rounded needs a transparent window so the CSS border-radius
  // corners reveal the desktop behind them (like Konsole on Wayland/KDE).
  // A sub-100% fuse alpha or an image background also makes the window
  // translucent, so transparency must be on for those too.
  const frameless = cfg?.window?.frameless !== false
  const rounded = frameless && cfg?.window?.rounded !== false
  const fuseAlpha = Number(cfg?.window?.fuseAlpha ?? 1)
  const translucent = fuseAlpha < 1
  const transparent = frameless && (rounded || translucent)

  mainWindow = new BrowserWindow({
    width,
    height,
    show: false,
    icon,
    frame: !frameless,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#121212',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // If background tasks are still running, ask the renderer before closing
  // (the user may want to keep the window open / be warned that tasks die).
  // The renderer replies via `window:confirm-close`, which sets quitApproved.
  mainWindow.on('close', (e) => {
    if (quitApproved) return
    const n = runningTaskCount()
    if (n > 0) {
      e.preventDefault()
      broadcast('cockpit:confirm-quit', n)
    }
  })

  mainWindow.on('maximize', () => broadcast('cockpit:window-maximized', true))
  mainWindow.on('unmaximize', () => broadcast('cockpit:window-maximized', false))
  // Child windows live and die with the main shell.
  mainWindow.on('closed', () => closeAllChildren())
  setMainWindow(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Single instance: second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    electronApp.setAppUserModelId('com.aaaa0ggmc.linux-cockpit')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerIconProtocol()
    // The shell owns the window broadcast; framework modules and abilities pull
    // it via the broadcast hub (setBroadcast/getBroadcast).
    setBroadcast(broadcast)
    setLogBroadcast((entry) => broadcast('cockpit:log', entry))
    setBackgroundBroadcast((event) => broadcast('cockpit:bt', event))
    setWindowBroadcast((event) => broadcast('cockpit:windows', event))
    // Register every built-in ability's commands before any IPC dispatch.
    registerAbilityCommands()
    registerIpc()
    // Abilities self-start (watchers, eager bindings) via registered hooks.
    await runStartupHooks()
    // Renderer confirmed it's OK to close despite running tasks.
    ipcMain.handle('window:confirm-close', (e) => {
      // Only the main shell may authorize quitting; a child window must never
      // trigger it (its own close is sender-scoped via window:close).
      if (BrowserWindow.fromWebContents(e.sender) !== mainWindow) return
      quitApproved = true
      mainWindow?.close()
    })
    log.info('app started', {
      platform: process.platform,
      version: process.versions.electron,
      mode: is.dev ? 'dev' : 'prod'
    })

    // Load external backend abilities before showing any window.
    loadExternalAbilities().catch((e) => console.error('[cockpit] external abilities:', e))

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// Ensure running background task children are killed when the app exits
// (tasks are attached to this program, not left orphaned).
app.on('will-quit', () => {
  shutdownBackgroundTasks()
  closeAllChildren()
})
