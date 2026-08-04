import { app, shell, BrowserWindow, protocol } from 'electron'
import { join } from 'path'
import icon from '../../resources/icon.png?asset'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc, startWatching } from './process/ipc'
import { registerIconProtocol } from './process/icon-protocol'
import { loadExternalAbilities } from './process/ability-loader'
import { registerAbilityCommands } from './process/abilities-loader'
import { setRegistryBroadcast } from '../abilities/apps/registry'
import { setOutputBroadcast } from '../abilities/apps/launcher'
import { readJson } from './process/util'
import { CONFIG_JSON } from './process/paths'

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

  mainWindow.on('maximize', () => broadcast('cockpit:window-maximized', true))
  mainWindow.on('unmaximize', () => broadcast('cockpit:window-maximized', false))

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

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.aaaa0ggmc.linux-cockpit')

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerIconProtocol()
    setRegistryBroadcast(broadcast)
    setOutputBroadcast((event) => broadcast('cockpit:proc-output', event))
    // Register every built-in ability's commands before any IPC dispatch.
    registerAbilityCommands()
    registerIpc()
    startWatching()

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
