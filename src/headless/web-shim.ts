/**
 * 网页 / 手机浏览器里的 `window.cockpit`：与 Electron preload 共用 `createCockpit`，
 * 只是传输层换成 HTTP + SSE。宿主不支持的 IPC 通道（窗口、对话框、全局快捷键、截图…）一律 nop。
 */
import { createCockpit } from '../preload/api'

const TOKEN_KEY = 'cockpit-headless-token'
const url = new URL(location.href)
let token = url.searchParams.get('token') ?? ''
try {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token)
    url.searchParams.delete('token')
    history.replaceState(null, '', url.toString())
  } else token = localStorage.getItem(TOKEN_KEY) ?? ''
} catch {
  /* 隐私模式：只在内存里保留 */
}

try {
  // <img> / <audio> / MapLibre 发的 /_p/ 请求带不了 Authorization 头，用 Cookie 鉴权（SameSite=Strict）
  if (token) document.cookie = `cockpit_token=${token}; path=/; SameSite=Strict`
} catch {
  /* ignore */
}

const authHeaders = { authorization: `Bearer ${token}` }

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  if (res.status === 401) throw new Error('unauthorized: 缺少或错误的 token')
  return (await res.json()) as T
}

type Listener = (...args: unknown[]) => void
const listeners = new Map<string, Set<Listener>>()
function emit(channel: string, ...args: unknown[]): void {
  listeners.get(channel)?.forEach((cb) => cb(...args))
}

const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`)
es.onmessage = (ev) => {
  try {
    const { channel, args } = JSON.parse(ev.data) as { channel: string; args: unknown[] }
    emit(channel, ...(args ?? []))
  } catch {
    /* 忽略坏帧 */
  }
}

const info = await api<{ platform: string }>('/api/info').catch(() => ({ platform: 'linux' }))

/** 宿主没有的能力：返回值按「什么都没发生」处理。 */
const NOP_RESULT: Record<string, unknown> = {
  'window:is-maximized': false,
  'window:toggle-maximize': false,
  'window:lock': false,
  'window:move': false,
  'window:move-to': false,
  'window:resize': false,
  'window:center': false,
  'window:auto-fit': false,
  'window:create': { ok: false, error: 'unsupported' },
  'window:destroy': false,
  'window:focus': false,
  'window:list': [],
  'window:control': false,
  'window:wallpaper': null,
  'dialog:pick-file': null,
  'dialog:save-file': null,
  'shortcut:sync-global': {},
  'screenshot:capture': null,
  'screenshot:save': null,
  'privacy:pending': [],
  'privacy:deny-all': 0,
  'agent-view:control': false
}

const cockpit = createCockpit({
  async invoke(channel, ...args) {
    switch (channel) {
      case 'command:run': {
        const [name, cmdArgs, meta] = args as [string, Record<string, unknown>, unknown]
        const r = await api<{
          ok: boolean
          result?: unknown
          error?: string
          unknown?: boolean
          silent?: boolean
        }>('/api/command', { name, args: cmdArgs ?? {}, meta })
        if (r.ok) return r.result
        if (r.unknown && !r.silent) emit('cockpit:command-error', name)
        throw new Error(r.error ?? 'command failed')
      }
      case 'cli:exec': {
        const r = await api<{ ok: boolean; result?: string; error?: string }>('/api/cli', {
          cmd: args[0],
          meta: args[1]
        })
        if (r.ok) return r.result ?? ''
        throw new Error(r.error ?? 'cli failed')
      }
      case 'command:list':
        return api('/api/commands')
      case 'dialog:pick-file':
      case 'dialog:save-file':
        // 浏览器拿不到宿主机路径：交给 HostFilePicker.vue 浏览宿主文件系统
        return new Promise((resolve) =>
          window.dispatchEvent(
            new CustomEvent('cockpit:host-pick', {
              detail: {
                mode: channel === 'dialog:save-file' ? 'save' : 'open',
                opts: args[0],
                resolve
              }
            })
          )
        )
      case 'clipboard:write':
        await navigator.clipboard?.writeText(String(args[0] ?? ''))
        return
      case 'shell:open-external':
        window.open(String(args[0] ?? ''), '_blank', 'noopener')
        return
      case 'window:work-area':
        return { x: 0, y: 0, width: innerWidth, height: innerHeight }
      default:
        return channel in NOP_RESULT ? NOP_RESULT[channel] : null
    }
  },
  on(channel, cb) {
    let set = listeners.get(channel)
    if (!set) listeners.set(channel, (set = new Set()))
    set.add(cb)
    return () => set!.delete(cb)
  },
  caps: {
    // 浏览器本身就是窗口：不画最小化 / 最大化 / 关闭
    'window.frame': 'none',
    'window.child': 'none',
    // 桌面壁纸来自宿主桌面环境（KDE），网页 / Termux 没有
    'host.wallpaper': 'none',
    // 浏览器拿不到宿主机的绝对路径：用宿主文件选择器（HostFilePicker）
    'file.pick': 'web',
    'file.save': 'web',
    'shortcut.global': 'none',
    screenshot: 'none',
    'privacy.consent': 'none',
    // 浏览器有等价实现
    clipboard: 'web',
    external: 'web'
  },
  hostUrl: (u) => u.replace(/^cockpit-(icon|audio|tile):\/\//, '/_p/cockpit-$1/'),
  platform: info.platform,
  wayland: false,
  windowDebug: false,
  yarjDebug: false,
  // Electron 用 webFrame.setZoomFactor；浏览器没有等价 API，用 CSS zoom（Chromium 已标准化）
  setZoom: (factor) => {
    const root = document.documentElement.style
    root.zoom = factor === 1 ? '' : String(factor)
    // CSS zoom 不改变视口的 CSS 尺寸（Electron 的真缩放会）：让 viewport.ts 重算 --app-vh（会除以 zoom）
    window.dispatchEvent(new Event('resize'))
  }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(window as any).cockpit = cockpit
