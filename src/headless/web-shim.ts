/**
 * 网页 / 手机浏览器里的 `window.cockpit`：与 Electron preload 共用 `createCockpit`，
 * 只是传输层换成 HTTP + SSE。宿主不支持的 IPC 通道（窗口、对话框、全局快捷键、截图…）一律 nop。
 */
import { createCockpit, type NativeClient } from '../preload/api'
import { initBrowserBridge } from './browser-bridge'

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

/**
 * 安卓客户端（android/，一个打开宿主网页的 WebView 壳）注入的原生桥。
 * 只补浏览器做不好的：剪贴板（WebView 的 navigator.clipboard 常因缺少用户激活而失败）、外部链接（交给系统浏览器）。
 */
interface AndroidBridge {
  copyText(text: string): void
  openExternal(url: string): void
  openConnect(): void
  version(): string
  /** 通用异步调用（0.2.0 起）；结果经 window.__cockpitNative.reply 回来 */
  call?(id: string, method: string, argsJson: string): void
}
const android = (window as unknown as { CockpitAndroid?: AndroidBridge }).CockpitAndroid

/**
 * 本标签页的浏览器 UI 桥 clientId（B5）：宿主用它把 YAYA 的界面请求**定向**发给发起工作流的
 * 这个标签页（绝不广播、绝不挑「最新」的）。重复 id 会被宿主拒绝，不会顶掉别的标签页。
 */
function randomClientId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
const clientId = randomClientId()

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    // clientId 让宿主把本次调用关联到本标签页（YAYA 工作流因此能继续操作这个页面）
    body: body === undefined ? undefined : JSON.stringify({ ...(body as object), clientId })
  })
  if (res.status === 401) throw new Error('unauthorized: 缺少或错误的 token')
  return (await res.json()) as T
}

/** 浏览器 UI 桥用：带鉴权的 POST（自动带上本标签页的 clientId）。 */
export function bridgePost<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, body)
}

type Listener = (...args: unknown[]) => void
const listeners = new Map<string, Set<Listener>>()
function emit(channel: string, ...args: unknown[]): void {
  listeners.get(channel)?.forEach((cb) => cb(...args))
}

/** 本页面向本地监听器派发事件（不经过 SSE，不会广播到其他标签页）。 */
export function emitLocal(channel: string, ...args: unknown[]): void {
  emit(channel, ...args)
}

/**
 * 安卓 App 的原生调用（`window.cockpit.client`）。协议见 android/…/MainActivity.java：
 * 页面 `CockpitAndroid.call(id, method, argsJson)` → 原生 `__cockpitNative.reply(id, ok, data)`；
 * 原生事件 `__cockpitNative.event(name, data)` → 本地频道 `cockpit:client-<name>`。
 * 原生在页面「就绪」前把事件排队；就绪信号等到有人监听 `cockpit:client-shared`（外壳挂载）
 * 时才发，否则启动时就到的分享会在没人接的时候发出去丢掉。
 */
const SHARED_CHANNEL = 'cockpit:client-shared'
let nativeReadySent = false
const nativeClient: NativeClient | null = android?.call
  ? (() => {
      const pending = new Map<
        string,
        { resolve: (v: unknown) => void; reject: (e: Error) => void }
      >()
      let seq = 0
      ;(window as unknown as { __cockpitNative: unknown }).__cockpitNative = {
        reply(id: string, ok: boolean, data: unknown) {
          const p = pending.get(id)
          if (!p) return
          pending.delete(id)
          if (ok) p.resolve(data)
          else
            p.reject(
              new Error(String((data as { error?: unknown } | null)?.error ?? 'native call failed'))
            )
        },
        event(name: string, data: unknown) {
          emit(`cockpit:client-${name}`, data)
        }
      }
      return {
        kind: 'android' as const,
        version: android.version(),
        call<T = unknown>(method: string, args: Record<string, unknown> = {}): Promise<T> {
          const id = `n${++seq}`
          return new Promise<T>((resolve, reject) => {
            pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
            android.call!(id, method, JSON.stringify(args))
          })
        }
      }
    })()
  : null

function signalNativeReady(): void {
  if (!nativeClient || nativeReadySent) return
  nativeReadySent = true
  void nativeClient.call('ready').catch(() => {})
}
// 兜底：没有任何页面监听分享（比如外壳没挂载起来）也别让原生事件永远排队
if (nativeClient) setTimeout(signalNativeReady, 10_000)

/**
 * 真实用户操作（isTrusted）立即清除 agent 输入标记：之后的命令 / IPC 按用户来源计。
 * 只认真实手势——AI 注入的是合成事件（isTrusted=false），不会误清自己的标记。
 * （与 Electron 的 inspector 不同：那边没有等价信号，只能靠时间窗口。）
 */
const clearAgentAttribution = (event: Event): void => {
  if (event.isTrusted) emitLocal('cockpit:agent-input', null)
}
window.addEventListener('pointerdown', clearAgentAttribution, { capture: true })
window.addEventListener('keydown', clearAgentAttribution, { capture: true })

/**
 * SSE 连接（宿主 → 页面的全部推送：流式 token、播放器指令、配置变化…）。
 * 断线必须自己兜底：
 * - 服务器回非 200 / 网络错误后 EventSource 可能进入 CLOSED，**不会再自动重连**；
 * - 手机切后台 / 换网络后 TCP 可能半开：readyState 仍是 OPEN，但再也收不到任何东西。
 * 所以：CLOSED 时按退避重连；宿主每 15s 发一次具名 ping，45s 没收到任何帧就主动重建连接；
 * 页面回到前台时立即检查。重连成功后本地派发 `cockpit:host-reconnected`，
 * 各页面据此重新拉取状态（断线期间错过的推送不会补发）。
 */
const SSE_STALE_MS = 45_000
let es: EventSource | null = null
let lastFrameAt = Date.now()
let everOpened = false
let lostSince = 0
let retryDelay = 1000
let retryTimer: ReturnType<typeof setTimeout> | null = null

function openEvents(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  es?.close()
  const source = new EventSource(
    `/api/events?token=${encodeURIComponent(token)}&clientId=${clientId}`
  )
  es = source
  lastFrameAt = Date.now()
  source.onopen = () => {
    lastFrameAt = Date.now()
    retryDelay = 1000
    if (everOpened && lostSince) {
      console.warn(`[web-shim] event stream reconnected after ${Date.now() - lostSince} ms`)
      emit('cockpit:host-reconnected', { downMs: Date.now() - lostSince })
    }
    everOpened = true
    lostSince = 0
  }
  source.onerror = () => {
    if (!lostSince) lostSince = Date.now()
    // CONNECTING = 浏览器自己在重连；CLOSED = 它放弃了，由我们接手
    if (source.readyState === EventSource.CLOSED) scheduleReconnect()
  }
  source.addEventListener('ping', () => {
    lastFrameAt = Date.now()
  })
  source.onmessage = onEventFrame
}

function scheduleReconnect(): void {
  if (retryTimer) return
  retryTimer = setTimeout(openEvents, retryDelay)
  retryDelay = Math.min(retryDelay * 2, 15_000)
}

function checkStale(): void {
  if (Date.now() - lastFrameAt < SSE_STALE_MS) return
  if (!lostSince) lostSince = lastFrameAt
  openEvents()
}
setInterval(checkStale, 5000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkStale()
})
window.addEventListener('online', () => {
  if (es?.readyState !== EventSource.OPEN) openEvents()
})
/**
 * 隐私授权（网页版）：宿主随每个待处理请求下发一次性 nonce（只走 SSE）。nonce 留在这里，
 * 页面组件拿到的列表不含它；提交决定时由这里附上（见 src/headless/consent.ts）。
 */
let consentList: Record<string, unknown>[] = []
const consentNonces = new Map<string, string>()
function onConsentFrame(raw: unknown): Record<string, unknown>[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
  consentNonces.clear()
  consentList = list.map(({ nonce, ...rest }) => {
    if (typeof rest.id === 'string' && typeof nonce === 'string') consentNonces.set(rest.id, nonce)
    return rest
  })
  return consentList
}

function onEventFrame(ev: MessageEvent): void {
  lastFrameAt = Date.now()
  try {
    const { channel, args } = JSON.parse(ev.data) as { channel: string; args: unknown[] }
    if (channel === 'privacy:pending') {
      emit(channel, onConsentFrame(args?.[0]))
      return
    }
    emit(channel, ...(args ?? []))
  } catch {
    /* 忽略坏帧 */
  }
}
openEvents()

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
  'dialog:pick-files': [],
  'dialog:save-file': null,
  'shortcut:sync-global': {},
  'screenshot:capture': null,
  'screenshot:save': null,
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
      case 'privacy:pending':
        return consentList
      case 'privacy:decide': {
        const [id, decision] = args as [string, string]
        const nonce = consentNonces.get(id)
        if (!nonce) return false
        const r = await api<{ ok: boolean }>('/api/privacy/decide', { id, nonce, decision })
        if (r.ok) consentNonces.delete(id)
        return r.ok
      }
      case 'privacy:deny-all': {
        const r = await api<{ ok: boolean; count?: number }>('/api/privacy/deny-all', {})
        return r.count ?? 0
      }
      case 'dialog:pick-file':
      case 'dialog:pick-files':
      case 'dialog:save-file':
        // 浏览器拿不到宿主机路径：交给 HostFilePicker.vue 浏览宿主文件系统
        return new Promise((resolve) =>
          window.dispatchEvent(
            new CustomEvent('cockpit:host-pick', {
              detail: {
                mode:
                  channel === 'dialog:save-file'
                    ? 'save'
                    : channel === 'dialog:pick-files'
                      ? 'open-multi'
                      : 'open',
                opts: args[0],
                resolve
              }
            })
          )
        )
      case 'clipboard:write':
        if (android) android.copyText(String(args[0] ?? ''))
        else await navigator.clipboard?.writeText(String(args[0] ?? ''))
        return
      case 'shell:open-external':
        if (android) android.openExternal(String(args[0] ?? ''))
        else window.open(String(args[0] ?? ''), '_blank', 'noopener')
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
    if (channel === SHARED_CHANNEL) queueMicrotask(signalNativeReady)
    return () => set!.delete(cb)
  },
  client: nativeClient,
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
    // 授权弹窗：外壳悬浮窗（Outsider SDK，PrivacyConsentPopup.vue）
    'privacy.consent': 'web',
    // 浏览器有等价实现；安卓客户端走原生
    clipboard: android ? 'native' : 'web',
    external: android ? 'native' : 'web'
  },
  hostUrl: (u) => u.replace(/^(cockpit-(?:icon|audio|tile)|yaya-asset):\/\//, '/_p/$1/'),
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

// 浏览器 UI 桥（B5）：登记本标签页，等待宿主把固定方法的界面请求定向发过来
initBrowserBridge(cockpit)
