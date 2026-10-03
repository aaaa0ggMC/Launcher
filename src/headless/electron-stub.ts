/**
 * 无头模式的 `electron` 替身（vite 构建时 alias 过来）。
 *
 * 设计：不支持的 Electron 能力一律 nop——属性访问返回另一个 nop，调用返回 undefined，
 * 这样 27 个直接 `import 'electron'` 的文件无需改动就能在纯 Node / Termux 里加载；
 * 真正会被业务逻辑消费返回值的少数成员（窗口列表、net.fetch、safeStorage 等）在下面显式给出。
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-function, @typescript-eslint/explicit-function-return-type */
import { homedir, tmpdir } from 'node:os'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'

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
const FILE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mbtiles': 'application/octet-stream'
}
/** Electron 的 net.fetch 能读 file://，Node 的 fetch 不能——这里补上（其余 URL 走全局 fetch） */
export const net = {
  fetch: async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(input instanceof Request ? input.url : input)
    if (!u.startsWith('file://')) return fetch(input, init)
    try {
      const path = decodeURIComponent(u.slice('file://'.length))
      const st = await stat(path)
      if (!st.isFile()) return new Response(null, { status: 404 })
      return new Response(Readable.toWeb(createReadStream(path)) as never, {
        headers: {
          'Content-Type': FILE_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
          'Content-Length': String(st.size),
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  }
}
/** protocol.handle 注册的处理器——标准 (Request) => Response，网页宿主经 /_p/<scheme>/... 路由过去 */
type ProtocolHandler = (req: Request) => Response | Promise<Response>
const protocolHandlers = new Map<string, ProtocolHandler>()
export function getProtocolHandler(scheme: string): ProtocolHandler | undefined {
  return protocolHandlers.get(scheme)
}
export const protocol = {
  handle: (scheme: string, fn: ProtocolHandler): void => void protocolHandlers.set(scheme, fn),
  registerSchemesAsPrivileged: noop,
  registerFileProtocol: noop,
  unhandle: (scheme: string): void => void protocolHandlers.delete(scheme)
}
export const session = makeNop()
export const shell = makeNop()
export const nativeImage = makeNop()
export const Notification = makeNop()
export const WebContentsView = makeNop()
export const globalShortcut = makeNop()
export const dialog = makeNop()
export const clipboard = makeNop()

export default { app, BrowserWindow, ipcMain, safeStorage, screen, net }
