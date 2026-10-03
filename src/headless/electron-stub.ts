/**
 * 无头模式的 `electron` 替身（vite 构建时 alias 过来）。
 *
 * 设计：不支持的 Electron 能力一律 nop——属性访问返回另一个 nop，调用返回 undefined，
 * 这样 27 个直接 `import 'electron'` 的文件无需改动就能在纯 Node / Termux 里加载；
 * 真正会被业务逻辑消费返回值的少数成员（窗口列表、net.fetch、safeStorage 等）在下面显式给出。
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-function, @typescript-eslint/explicit-function-return-type */
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

function makeNop(): any {
  const fn = function () {}
  return new Proxy(fn, {
    get: (_t, key) => (key === 'then' || typeof key === 'symbol' ? undefined : makeNop()),
    apply: () => undefined,
    construct: () => makeNop(),
    set: () => true
  })
}

const noop = (): void => {}

export const app = new Proxy(
  {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getVersion: () => process.env.npm_package_version ?? '0.0.0',
    getName: () => 'linux-cockpit',
    getPath: (name: string) =>
      name === 'home'
        ? homedir()
        : name === 'temp'
          ? tmpdir()
          : join(homedir(), name === 'pictures' ? 'Pictures' : '.config/LinuxCockpit'),
    whenReady: () => Promise.resolve(),
    requestSingleInstanceLock: () => true,
    on: noop,
    once: noop,
    quit: () => process.exit(0),
    commandLine: { appendSwitch: noop }
  } as Record<string, unknown>,
  { get: (t, k) => (k in t ? t[k as string] : makeNop()) }
)

export const BrowserWindow = Object.assign(function BrowserWindow() {}, {
  getAllWindows: () => [],
  fromWebContents: () => null,
  fromId: () => null,
  getFocusedWindow: () => null
})
export const webContents = { getAllWebContents: () => [], fromId: () => undefined }
export const ipcMain = { handle: noop, on: noop, once: noop, removeHandler: noop }
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => ''
}
export const screen = {
  getPrimaryDisplay: () => ({
    workArea: { x: 0, y: 0, width: 1280, height: 800 },
    bounds: { x: 0, y: 0, width: 1280, height: 800 },
    scaleFactor: 1
  }),
  getAllDisplays: () => [],
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
  on: noop
}
export const net = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) }
export const protocol = makeNop()
export const session = makeNop()
export const shell = makeNop()
export const nativeImage = makeNop()
export const Notification = makeNop()
export const WebContentsView = makeNop()
export const globalShortcut = makeNop()
export const dialog = makeNop()
export const clipboard = makeNop()

export default { app, BrowserWindow, ipcMain, safeStorage, screen, net }
