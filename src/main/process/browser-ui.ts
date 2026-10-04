/**
 * 无头浏览器 UI 桥（主进程侧）—— YAYA headless B5（见 `src/abilities/yaya/PLAN.md` B5 行）。
 *
 * 无头宿主的「界面」在用户的浏览器标签页里：Agent（只有 YAYA，即 `local-agent` 来源）的
 * `ui.*` 工具不能走 Electron 的 CDP，改为经 HTTP 传输把**固定方法 + 固定参数**的请求发给
 * 「发起本次工作流的那个标签页」，由页面里的 DOM 桥（`src/headless/browser-bridge.ts`）执行，
 * 结果经同一个 pending id 回传。
 *
 * 边界（全部在这里强制）：
 *  - 只有 `local-agent` 来源（带非空 session）且**发起工作流时登记过的、仍连着**的浏览器能用；
 *    CLI / remote / MCP / script-agent 一律明确报错，绝不用任意 / 最新的标签页顶包；
 *  - 浏览器 id 只来自 AsyncLocalStorage（服务器在 `/api/command`、`/api/cli` 入口按 body.clientId
 *    包一层），**绝不从工具参数里读**；请求按客户端定向发送，不广播；
 *  - 请求 id 随机、有超时；应答必须来自同一个 clientId 且 id 仍在 pending 里，否则丢弃
 *    （不接受来路不明 / 张冠李戴的应答）；客户端断开时 pending 全部失败并清理；
 *  - 页面数据只回给发起方，不做截图、不请页面执行任意代码（固定方法表）。
 *
 * 隐私：快照在页面侧按 DOM 标签脱敏（与用户是否点开明文无关）；受保护动作先由页面预检
 * （不执行），主机 `guard()` 通过后带许可重试，页面复核同一个目标。授权 / 来源判定一律
 * 走 privacy SDK，不信任任何来自页面或工具参数的说法。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { makeLogger } from './logger'
import { currentOrigin, guard, hasClearance } from './privacy'
import { t, te } from './i18n'

const log = makeLogger('browser-ui')

/** 宿主 → 页面：固定方法请求（与 `pushEvent` 同一帧格式，但按客户端定向发送，不广播） */
export const BROWSER_UI_CHANNEL = 'cockpit:browser-ui'

/** 页面向宿主回传结果的长连接发送器（server.ts 在 SSE 上注册）。 */
export type BrowserUiSender = (channel: string, args: unknown[]) => void

const clients = new Map<string, BrowserUiSender>()

/** 注册一个浏览器客户端；同一 id 已存在（重复连接）时拒绝，不顶掉另一个标签页。 */
export function registerBrowserClient(
  clientId: string,
  send: BrowserUiSender,
  opts: { replace?: boolean } = {}
): boolean {
  if (clients.has(clientId)) {
    if (!opts.replace) return false
    // 同一标签页断线重连（旧连接的 close 可能还没触发）：换成新通道，进行中的请求不失败
    clients.set(clientId, send)
    log.info('browser client reconnected', { clientId })
    return true
  }
  clients.set(clientId, send)
  log.info('browser client connected', { clientId })
  return true
}

/** 断开清理：同时失败掉该客户端所有 pending 请求。 */
export function unregisterBrowserClient(clientId: string): void {
  if (!clients.delete(clientId)) return
  log.info('browser client disconnected', { clientId })
  for (const [id, entry] of [...pending]) {
    if (entry.clientId !== clientId) continue
    clearTimeout(entry.timer)
    pending.delete(id)
    entry.fail(
      new BrowserUiError(
        'browser_disconnected',
        t(
          'browserUi.disconnected',
          '发起本次操作的浏览器标签页已断开连接，请重试（工作流需要它在线）'
        )
      )
    )
  }
}

/** 是否有（任意 / 指定）浏览器客户端在线——供命令可用性门控使用。 */
export function hasBrowserClient(clientId?: string): boolean {
  return clientId ? clients.has(clientId) : clients.size > 0
}

export function browserClientCount(): number {
  return clients.size
}

// ---------------------------------------------------------------------------
// 调用关联（AsyncLocalStorage）
// ---------------------------------------------------------------------------

const browserStore = new AsyncLocalStorage<{ clientId: string; signal?: AbortSignal }>()

/** 当前调用链上的浏览器客户端 id（没有 = 不在浏览器上下文里）。 */
export function currentBrowserClient(): string | null {
  return browserStore.getStore()?.clientId ?? null
}

/** 在指定浏览器上下文里执行（null = 不包，原样执行——Electron 路径）。 */
export function withBrowserClient<T>(
  clientId: string | null | undefined,
  fn: () => T,
  signal?: AbortSignal
): T {
  return clientId ? browserStore.run({ clientId, signal }, fn) : fn()
}

function checkCancelled(): void {
  browserStore.getStore()?.signal?.throwIfAborted()
}

// ---------------------------------------------------------------------------
// 目标守卫
// ---------------------------------------------------------------------------

export class BrowserUiError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BrowserUiError'
    this.code = code
  }
}

/**
 * 谁能用这座桥：只有 YAYA（`local-agent`，非空 session）且**发起工作流的那个浏览器仍在线**。
 * CLI / remote / MCP / script-agent / renderer 一律拒绝——错误信息说清原因，绝不退化成
 * 「用某个标签页试试」。
 */
export function browserUiTarget(): { clientId: string; session: string } {
  const o = currentOrigin()
  if (o.kind !== 'local-agent' || !o.session) {
    throw new BrowserUiError(
      'browser_ui_unsupported',
      t(
        'browserUi.unsupported',
        '界面操作在无头（网页）宿主里只对 YAYA 开放（且必须由发起该工作流的浏览器标签页执行）；CLI / 远程 Agent 不能操作这个标签页'
      )
    )
  }
  const clientId = currentBrowserClient()
  if (!clientId) {
    throw new BrowserUiError(
      'browser_ui_no_target',
      t(
        'browserUi.no_target',
        '没有可操作的浏览器标签页：本次调用不是由浏览器页面发起的（YAYA 工作流必须在网页里启动才能操作界面）'
      )
    )
  }
  if (!clients.has(clientId)) {
    throw new BrowserUiError(
      'browser_disconnected',
      t(
        'browserUi.disconnected',
        '发起本次操作的浏览器标签页已断开连接，请重试（工作流需要它在线）'
      )
    )
  }
  return { clientId, session: o.session }
}

// ---------------------------------------------------------------------------
// 请求 / 应答
// ---------------------------------------------------------------------------

export interface BrowserUiRequest {
  id: string
  method: string
  args: Record<string, unknown>
  /** 发起本次操作的 YAYA 会话（页面据此把后续 IPC 标成 agent-ui） */
  session: string
}

export interface BrowserUiReply {
  ok: boolean
  result?: unknown
  error?: string
  /** 预检要求授权：带上 scopes 与 target token，主机 guard 后重试 */
  code?: string
  scopes?: string[]
  token?: string
  /** 目标的安全描述（只用于授权理由，不回给模型） */
  label?: string
}

export const BROWSER_UI_DEFAULT_TIMEOUT_MS = 20_000
export const BROWSER_UI_MAX_TIMEOUT_MS = 70_000

interface PendingEntry {
  clientId: string
  timer: ReturnType<typeof setTimeout>
  fail: (e: Error) => void
  settle: (r: BrowserUiReply) => void
}

const pending = new Map<string, PendingEntry>()

export interface BrowserUiCallOpts {
  method: string
  args?: Record<string, unknown>
  timeoutMs?: number
}

/** 发送一个固定方法请求并等待页面应答（超时 / 断开都会失败，绝不假成功）。 */
export async function browserUiCall(opts: BrowserUiCallOpts): Promise<BrowserUiReply> {
  checkCancelled()
  const signal = browserStore.getStore()?.signal
  const { clientId, session } = browserUiTarget()
  const send = clients.get(clientId)
  if (!send) throw new BrowserUiError('browser_disconnected', 'browser client is gone')
  const id = randomUUID()
  const timeoutMs = Math.min(
    Math.max(opts.timeoutMs ?? BROWSER_UI_DEFAULT_TIMEOUT_MS, 1000),
    BROWSER_UI_MAX_TIMEOUT_MS
  )
  const request: BrowserUiRequest = { id, method: opts.method, args: opts.args ?? {}, session }
  // agent 输入标记由页面在真正执行操作时自己打（browser-bridge.ts），窗口只覆盖这次操作；
  // 主机不预先打，否则排队 / 等待期间用户自己的操作也会被算成 agent。
  return new Promise<BrowserUiReply>((resolve, reject) => {
    let done = false
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      signal?.removeEventListener('abort', cancel)
      fn()
    }
    const sendCancel = (): void => {
      try {
        send('cockpit:browser-ui-cancel', [id])
      } catch {
        // A closed transport must not prevent cancellation from settling.
      }
    }
    const cancel = (): void => {
      clearTimeout(timer)
      pending.delete(id)
      try {
        sendCancel()
      } finally {
        finish(() => reject(signal?.reason ?? new Error('aborted')))
      }
    }
    const timer = setTimeout(() => {
      pending.delete(id)
      sendCancel()
      finish(() =>
        reject(
          new BrowserUiError(
            'browser_ui_timeout',
            te(
              'browserUi.timeout',
              { sec: String(Math.round(timeoutMs / 1000)) },
              '页面没有在 {sec} 秒内响应界面请求（标签页可能已被关闭或卡住）'
            )
          )
        )
      )
    }, timeoutMs)
    pending.set(id, {
      clientId,
      timer,
      settle: (r) => finish(() => resolve(r)),
      fail: (e) => finish(() => reject(e))
    })
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      send(BROWSER_UI_CHANNEL, [request])
    } catch (e) {
      clearTimeout(timer)
      pending.delete(id)
      finish(() =>
        reject(
          new BrowserUiError(
            'browser_send_failed',
            `发送界面请求失败：${e instanceof Error ? e.message : String(e)}`
          )
        )
      )
    }
  })
}

/** 页面回传结果：clientId 与 pending id 都必须对得上，否则拒绝（不接受来路不明 / 冒名应答）。 */
export function submitBrowserUiReply(body: unknown): { ok: true } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const id = typeof b.id === 'string' ? b.id : ''
  const clientId = typeof b.clientId === 'string' ? b.clientId : ''
  if (!id || !clientId) return { ok: false, error: 'missing clientId / id' }
  const entry = pending.get(id)
  if (!entry) return { ok: false, error: 'no pending browser-ui request with this id' }
  if (entry.clientId !== clientId)
    return { ok: false, error: 'reply clientId does not match the requesting client' }
  clearTimeout(entry.timer)
  pending.delete(id)
  entry.settle({
    ok: b.ok === true,
    ...(b.ok === true
      ? { result: b.result }
      : {
          error: typeof b.error === 'string' ? b.error : 'browser error',
          ...(typeof b.code === 'string' ? { code: b.code } : {}),
          ...(Array.isArray(b.scopes) ? { scopes: b.scopes.map(String) } : {}),
          ...(typeof b.token === 'string' ? { token: b.token } : {}),
          ...(typeof b.label === 'string' ? { label: b.label } : {})
        })
  })
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 受保护动作：预检 → 主机 guard → 带许可重试（页面复核同一个目标）
// ---------------------------------------------------------------------------

const CLEARANCE_CODE = 'clearance_required'

function unwrap(reply: BrowserUiReply): unknown {
  if (reply.ok) return reply.result
  throw new BrowserUiError(reply.code ?? 'browser_error', reply.error ?? 'browser error')
}

/**
 * 受保护动作的统一入口：页面先预检（**不执行**），落在隐私区 / 揭示类按钮上时返回
 * scopes；主机 `guard()`（Privacy SDK，弹授权窗口）通过后，用「当前确实持有的许可」
 * 重试，页面复核同一个目标与许可仍然匹配才真正执行。
 */
export async function browserUiGuardedCall(
  opts: BrowserUiCallOpts & { action: string }
): Promise<unknown> {
  const pre = await browserUiCall(opts)
  if (pre.ok || pre.code !== CLEARANCE_CODE) return unwrap(pre)
  const scopes = [...new Set((pre.scopes ?? []).filter(Boolean))]
  if (!scopes.length) throw new BrowserUiError(CLEARANCE_CODE, pre.error ?? 'clearance required')
  await guard(scopes, pre.label ? `${opts.action}「${pre.label}」` : opts.action)
  checkCancelled()
  // 许可以主机当前状态为准（不信任页面 / 工具参数传来的说法）
  const permitted = scopes.filter((s) => hasClearance(s))
  if (!permitted.length) throw new BrowserUiError(CLEARANCE_CODE, 'clearance no longer held')
  const retry = await browserUiCall({
    ...opts,
    args: { ...(opts.args ?? {}), permitted, ...(pre.token ? { token: pre.token } : {}) }
  })
  return unwrap(retry)
}
