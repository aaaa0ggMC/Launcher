import { app, shell, BrowserWindow, protocol } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc, startWatching } from './ipc'
import { registerIconProtocol } from './icon-protocol'
import { loadExternalAbilities } from './ability-loader'
import { setRegistryBroadcast } from './registry'
import { readJson } from './util'
import { CONFIG_JSON } from './paths'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cockpit-icon',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
  }
])

let mainWindow: BrowserWindow | null = null

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args)
  }
}

async function createWindow(): Promise<void> {
  const cfg = await readJson<{ window?: { width?: number; height?: number } }>(CONFIG_JSON)
  const { width = 1280, height = 800 } = cfg?.window ?? {}

  mainWindow = new BrowserWindow({
    width,
    height,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#121212',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

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
