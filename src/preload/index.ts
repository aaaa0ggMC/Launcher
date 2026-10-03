import { contextBridge, ipcRenderer, webFrame, IpcRendererEvent } from 'electron'
import { createCockpit } from './api'

const cockpit = createCockpit({
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, cb) => {
    const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...args)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  platform: process.platform,
  /** Wayland session (no input passthrough → locked lyrics window shrinks to
   *  the card so it doesn't block a wide strip; other platforms grow-only). */
  wayland: !!process.env.WAYLAND_DISPLAY,
  /** Window-geometry debug heartbeat (COCKPIT_WINDOW_DEBUG=1) — lyrics-window drift diagnosis. */
  windowDebug: process.env.COCKPIT_WINDOW_DEBUG === '1',
  /** yarj 地图能力调试日志 (COCKPIT_YARJ_DEBUG=1) — 输出实际生效的 style/filter/LOD 状态。 */
  yarjDebug: process.env.COCKPIT_YARJ_DEBUG === '1',
  // ui zoom (true uniform zoom via Electron webFrame)
  setZoom: (factor) => webFrame.setZoomFactor(factor)
})

export type { CockpitApi } from './api'

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('cockpit', cockpit)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.cockpit = cockpit
}
