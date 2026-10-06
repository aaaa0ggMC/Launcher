/**
 * 网页 / 手机浏览器里的 `window.cockpit`：与 Electron preload 共用 `createCockpit`，
 * 只是传输层换成 HTTP + SSE。宿主不支持的 IPC 通道（窗口、对话框、全局快捷键、截图…）一律 nop。
 */
import { installNativeMedia } from './native-media'
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
  /** 直接读系统剪贴板（老版本也有的 @JavascriptInterface；新版本优先走 client.call('clipboard.get')） */
  pasteText?(): string
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

async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    // clientId 让宿主把本次调用关联到本标签页（YAYA 工作流因此能继续操作这个页面）
    body: body === undefined ? undefined : JSON.stringify({ ...(body as object), clientId }),
    signal
  })
  if (res.status === 401) throw new Error('unauthorized: 缺少或错误的 token')
  return (await res.json()) as T
}

/**
 * 命令调用，带结果找回。长命令（aidj.generate 一跑几分钟）期间手机切后台 / 换网络，
 * 承载它的连接可能已经死了：宿主照样跑完，结果却写进了死连接，页面永远等不到（界面卡在「思考中」）。
 * 所以每次调用带一个 reqId；等得久了、或连接报错时，改用 /api/command-result 向宿主取结果。
 */
const RECOVER_AFTER_MS = 20_000
const RECOVER_EVERY_MS = 10_000
type CommandReply = {
  ok: boolean
  result?: unknown
  error?: string
  unknown?: boolean
  silent?: boolean
}
const inflight = new Map<string, () => void>()

function commandCall(body: Record<string, unknown>): Promise<CommandReply> {
  const reqId = randomClientId()
  const ctl = new AbortController()
  return new Promise<CommandReply>((resolve, reject) => {
    let settled = false
    let networkError: unknown = null
    let unknownCount = 0
    let checking = false
    const timers: {
      first?: ReturnType<typeof setTimeout>
      poll?: ReturnType<typeof setInterval>
    } = {}
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timers.first)
      clearInterval(timers.poll)
      inflight.delete(reqId)
      fn()
    }
    const check = async (): Promise<void> => {
      if (settled || checking) return
      checking = true
      try {
        // 取结果的请求自己也可能落在死连接上：限时，下一轮重试
        const r = await api<{ state: string; response?: CommandReply }>(
          '/api/command-result',
          { reqId },
          AbortSignal.timeout(8000)
        )
        if (r.state === 'done' && r.response) {
          ctl.abort()
          finish(() => resolve(r.response!))
        } else if (r.state === 'lost') {
          ctl.abort()
          finish(() => reject(new Error('命令已完成，但结果太大无法找回（连接中断过）')))
        } else if (r.state === 'unknown') {
          // 宿主不认识这个 reqId：请求没送到，或宿主重启过。连着两次才算（请求可能还在路上）
          if (++unknownCount >= 2 || networkError) {
            ctl.abort()
            finish(() =>
              reject(networkError ?? new Error('与宿主的连接中断，命令结果丢失（宿主可能已重启）'))
            )
          }
        } else unknownCount = 0
      } catch {
        /* 宿主暂时连不上：下一轮再问 */
      } finally {
        checking = false
      }
    }
    const startPolling = (): void => {
      if (timers.poll !== undefined || settled) return
      timers.poll = setInterval(() => void check(), RECOVER_EVERY_MS)
      void check()
    }
    timers.first = setTimeout(startPolling, RECOVER_AFTER_MS)
    // 页面从后台回来 / 事件流重连时立即问一次（见 recoverInflight）
    inflight.set(reqId, () => {
      if (timers.poll === undefined) startPolling()
      else void check()
    })
    api<CommandReply>('/api/command', { ...body, reqId }, ctl.signal).then(
      (r) => finish(() => resolve(r)),
      (e) => {
        if (settled) return
        // 连接被重置（EPIPE / 切网络）：命令可能仍在宿主上执行或已完成——去取结果
        networkError = e
        startPolling()
      }
    )
  })
}

/** 连接可能刚断过：所有还在等的命令立即去宿主取一次结果 */
function recoverInflight(): void {
  for (const kick of inflight.values()) kick()
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
// App 回到前台（原生 onResume）：检查事件流、找回等待中的命令结果。onResumed 在下面定义，调用时已初始化
if (nativeClient) {
  let set = listeners.get('cockpit:client-resume')
  if (!set) listeners.set('cockpit:client-resume', (set = new Set()))
  set.add(() => onResumed())
}

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
/** 最后收到的广播帧 id：手动重建连接时带给宿主，补发断线期间错过的帧 */
let lastEventId = ''
let retryDelay = 1000
let retryTimer: ReturnType<typeof setTimeout> | null = null

function openEvents(): void {
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
  es?.close()
  const resume = lastEventId ? `&lastEventId=${encodeURIComponent(lastEventId)}` : ''
  const source = new EventSource(
    `/api/events?token=${encodeURIComponent(token)}&clientId=${clientId}${resume}`
  )
  es = source
  lastFrameAt = Date.now()
  source.onopen = () => {
    lastFrameAt = Date.now()
    retryDelay = 1000
  }
  // 宿主连上后的第一帧：resumed = 断线期间的广播已按 lastEventId 补发，页面状态是连续的；
  // 否则（宿主重启过 / 断太久）派发 host-reconnected，各页面整体重新拉取
  source.addEventListener('hello', (ev) => {
    lastFrameAt = Date.now()
    let resumed = false
    try {
      resumed = Boolean((JSON.parse((ev as MessageEvent).data) as { resumed?: boolean }).resumed)
    } catch {
      /* 旧宿主 */
    }
    if (everOpened && lostSince) {
      const downMs = Date.now() - lostSince
      console.warn(`[web-shim] event stream reconnected after ${downMs} ms, resumed=${resumed}`)
      if (!resumed) emit('cockpit:host-reconnected', { downMs })
      recoverInflight()
    }
    everOpened = true
    lostSince = 0
  })
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

function checkStale(staleMs = SSE_STALE_MS): void {
  if (Date.now() - lastFrameAt < staleMs) return
  if (!lostSince) lostSince = lastFrameAt
  openEvents()
}
setInterval(() => checkStale(), 5000)
/**
 * 回到前台：宿主每 15s 发一次 ping，20s 没收到任何帧就说明连接在后台断过，立即重建（带 lastEventId 补帧），
 * 不再等 45s。安卓 App 保活时页面在后台也保持「可见」（为了视频能在后台继续放），
 * 收不到 visibilitychange，由原生在 onResume 时发 resume 事件。
 */
function onResumed(): void {
  checkStale(20_000)
  recoverInflight()
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') onResumed()
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
  if (ev.lastEventId) lastEventId = ev.lastEventId
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
        const r = await commandCall({ name, args: cmdArgs ?? {}, meta })
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
      case 'clipboard:read': {
        // 安卓客户端优先走原生（WebView 在 http 下没有 navigator.clipboard）
        if (nativeClient) {
          try {
            const r = await nativeClient.call<{ text?: string }>('clipboard.get')
            if (typeof r?.text === 'string') return r.text
          } catch {
            /* 老版本 App 没有 clipboard.get：退回下面的直连桥 */
          }
        }
        if (android?.pasteText) {
          try {
            return String(android.pasteText() ?? '')
          } catch {
            /* ignore */
          }
        }
        try {
          return (await navigator.clipboard?.readText()) ?? ''
        } catch {
          return ''
        }
      }
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

// 安卓 App：把 navigator.mediaSession 转给原生（通知栏 / 锁屏媒体控制）；浏览器里由浏览器自己处理
if (nativeClient) installNativeMedia(nativeClient, cockpit.on)
