/**
 * 无头宿主的 HTTP 传输：同一份命令注册表，网页 / 手机浏览器当客户端。
 *
 *   POST /api/command   { name, args, meta? }  → { ok, result } | { ok:false, error, unknown? }
 *   GET  /api/commands                          → 命令清单
 *   GET  /api/events                            → SSE，推送 broadcast(channel, ...args)
 *   GET  /*                                     → 渲染端静态文件（out/web）
 *
 * 鉴权：`Authorization: Bearer <token>` 或 `?token=`（EventSource 不能带头）。
 * 默认只监听 127.0.0.1；`--host 0.0.0.0` 才对局域网开放。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, extname, join, normalize, resolve } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { getProtocolHandler } from './electron-stub'
import { runCommand, listCommands, UnknownCommandError } from '../main/process/commands/registry'
import { withOrigin } from '../main/process/privacy'
import {
  hasBrowserClient,
  registerBrowserClient,
  submitBrowserUiReply,
  unregisterBrowserClient,
  withBrowserClient
} from '../main/process/browser-ui'
import { cliExec } from '../main/process/cli'
import { CONSENT_CHANNEL, decideFromPage, denyAllFromPage, pendingConsentFrames } from './consent'
import { makeLogger } from '../main/process/logger'
import { USER_CONFIG_DIR } from '../main/process/paths'

const log = makeLogger('headless')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

const clients = new Set<ServerResponse>()

/**
 * 广播帧补发：每帧带 `id: <进程纪元>-<序号>`，最近一段留在内存里。手机切后台 / 换网络后事件流断开，
 * 页面重连时带上最后收到的 id，这里把期间错过的帧原样补上（流式 token、工作流进度、播放指令都不丢）；
 * 补不上（太久、宿主重启过）时在 hello 帧里说明，页面再整体重新拉取状态。
 */
const EPOCH = randomBytes(4).toString('hex')
let eventSeq = 0
const backlog: { seq: number; frame: string }[] = []
let backlogBytes = 0
const BACKLOG_MAX_FRAMES = 5000
const BACKLOG_MAX_BYTES = 8 * 1024 * 1024
/** 还没有任何页面连过就不攒（纯命令行用的宿主不必为广播付内存） */
let everHadClient = false
/**
 * 单个连接积压的未发出字节上限：对端冻结（后台 WebView）或半开时 write 只会在内存里越堆越多。
 * 超过就断开它——页面回来重连时按 id 补发，比在宿主里无限堆积安全。
 */
const SSE_MAX_PENDING_BYTES = 4 * 1024 * 1024

function writeSse(res: ServerResponse, frame: string): void {
  if (res.writableEnded || res.destroyed) return
  if (res.writableLength > SSE_MAX_PENDING_BYTES) {
    log.warn('event stream stalled, dropping client', { pending: res.writableLength })
    clients.delete(res)
    res.destroy()
    return
  }
  res.write(frame)
}

function remember(frame: string): void {
  backlog.push({ seq: eventSeq, frame })
  backlogBytes += frame.length
  while (backlog.length > BACKLOG_MAX_FRAMES || backlogBytes > BACKLOG_MAX_BYTES) {
    backlogBytes -= backlog.shift()!.frame.length
  }
}

/** `<纪元>-<序号>` → 需要补发的帧；null = 补不上（纪元不同 / 已被挤出缓冲） */
function replayAfter(lastId: string): string[] | null {
  const m = /^([0-9a-f]{8})-(\d+)$/.exec(lastId)
  if (!m || m[1] !== EPOCH) return null
  const after = Number(m[2])
  if (after > eventSeq) return null
  if (after === eventSeq) return []
  const first = backlog[0]?.seq ?? eventSeq + 1
  if (after + 1 < first) return null
  return backlog.filter((f) => f.seq > after).map((f) => f.frame)
}

/**
 * 命令结果暂存：长命令（aidj.generate 等，一跑几分钟）的 HTTP 连接在手机切后台时可能断掉，
 * 宿主照样跑完，但结果写进了一个死连接。页面给每次调用带 reqId，拿不到响应时用
 * /api/command-result 取回。完成后保留一段时间。
 */
const REQ_ID_RE = /^[0-9a-z-]{8,64}$/i
const COMMAND_RESULT_TTL_MS = 15 * 60 * 1000
const COMMAND_RESULT_MAX = 200
const COMMAND_RESULT_MAX_BYTES = 8 * 1024 * 1024
const commandResults = new Map<string, { done: boolean; body?: string; at: number }>()

function pruneCommandResults(): void {
  const now = Date.now()
  for (const [id, r] of commandResults) {
    if (r.done && now - r.at > COMMAND_RESULT_TTL_MS) commandResults.delete(id)
  }
  if (commandResults.size <= COMMAND_RESULT_MAX) return
  for (const [id, r] of commandResults) {
    if (commandResults.size <= COMMAND_RESULT_MAX) break
    if (r.done) commandResults.delete(id)
  }
}

function sendCommandResult(res: ServerResponse, reqId: string | null, payload: unknown): void {
  const body = JSON.stringify(payload)
  if (reqId) {
    commandResults.set(reqId, {
      done: true,
      body: body.length <= COMMAND_RESULT_MAX_BYTES ? body : undefined,
      at: Date.now()
    })
    pruneCommandResults()
  }
  if (res.destroyed || res.writableEnded) return
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(body)
}
/** 浏览器 UI 桥 clientId → 当前持有它的 SSE 连接（重连时新连接顶替旧连接） */
const bridgeOwners = new Map<string, ServerResponse>()

/** 浏览器 UI 桥 clientId（web-shim 每标签页随机生成；UI 请求按它定向发送） */
const CLIENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** 界面结果回传的体积上限（快照文本可能很大，但不该无限） */
/** 页面回传上限：截图（base64 JPEG）可能有几 MB */
const MAX_UI_REPLY_BYTES = 16 * 1024 * 1024

/** 网页端「从此设备选择」上传到宿主的位置（文件选择器把这里的路径当作选择结果返回） */
export const UPLOAD_DIR = join(USER_CONFIG_DIR, 'uploads')
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

/** 只保留文件名部分、去掉控制字符 / 路径分隔，前缀随机串避免重名，扩展名原样保留（过滤器按它判断） */
function uploadName(raw: string): string {
  const base = basename(raw.replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .slice(-120)
  return `${randomBytes(4).toString('hex')}-${base || 'file'}`
}

async function receiveUpload(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  const len = Number(req.headers['content-length'] ?? 0)
  if (len > MAX_UPLOAD_BYTES) return json(res, 413, { ok: false, error: 'file too large' })
  mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 })
  const file = join(UPLOAD_DIR, uploadName(url.searchParams.get('name') ?? 'file'))
  let size = 0
  req.on('data', (c: Buffer) => {
    size += c.length
    if (size > MAX_UPLOAD_BYTES) req.destroy(new Error('file too large'))
  })
  try {
    await pipeline(req, createWriteStream(file, { mode: 0o600 }))
  } catch (e) {
    log.warn('upload failed', String(e))
    return json(res, 400, { ok: false, error: 'upload failed' })
  }
  log.info('upload saved', { file, size })
  json(res, 200, { ok: true, path: file, size })
}

const SCHEME_RE = /^cockpit-(icon|audio|tile):\/\/(.*)$/s

/** 命令结果里的自定义协议 URL → /_p/ 路由（<img> 等拿到的就是浏览器可加载的地址） */
function rewriteUrls(v: unknown): unknown {
  if (typeof v === 'string') {
    const m = SCHEME_RE.exec(v)
    return m ? `/_p/cockpit-${m[1]}/${m[2]}` : v
  }
  if (Array.isArray(v)) return v.map(rewriteUrls)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = rewriteUrls(x)
    return out
  }
  return v
}

/** `/_p/cockpit-icon/<编码后的路径>?x` → 调用 Electron 版注册的协议处理器，把 Response 管回去 */
/**
 * 自定义协议的取数方式：无头宿主用替身记下的处理器；Electron 内嵌时由调用方注入
 * （`net.fetch` 会走 `protocol.handle` 注册的处理器）。
 */
let protocolFetch: ((scheme: string, req: Request) => Promise<Response> | null) | null = null

async function serveProtocol(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // yaya-asset 不进 rewriteUrls（命令结果里的 assetPath 是资产标识，要原样回传给宿主），
  // 只由渲染端经 hostUrl() 改写后从这里取
  const m = /^\/_p\/(cockpit-(?:icon|audio|tile)|yaya-asset)\/(.*)$/s.exec(req.url ?? '')
  const handler = m
    ? protocolFetch
      ? (r: Request) => protocolFetch!(m[1], r) as Promise<Response>
      : getProtocolHandler(m[1])
    : null
  if (!m || !handler) return json(res, 404, { error: 'unknown protocol' })
  const headers = new Headers()
  if (req.headers.range) headers.set('Range', String(req.headers.range))
  const r = await handler(new Request(`${m[1]}://${m[2]}`, { headers }))
  const out: Record<string, string> = {}
  r.headers.forEach((val, key) => (out[key] = val))
  res.writeHead(r.status, out)
  if (!r.body) return void res.end()
  // pipeline：客户端中途断开（切歌、拖动、切后台）时两端都销毁，文件句柄不泄漏
  await pipeline(Readable.fromWeb(r.body as never), res).catch(() => {})
}

/** broadcast(channel, ...args) → 所有 SSE 客户端 */
export function pushEvent(channel: string, ...args: unknown[]): void {
  if (!everHadClient) return
  // 广播载荷里同样可能带 cockpit-*:// 地址（如 aidj 的 cockpit:aidj-webplayer 里的 audioUrl），
  // 和命令返回值一样要改写成 /_p/ 路由，否则浏览器的 <audio> / <img> 加载不了
  eventSeq++
  const frame = `data: ${JSON.stringify({ channel, args: rewriteUrls(args) })}\nid: ${EPOCH}-${eventSeq}\n\n`
  remember(frame)
  for (const res of clients) writeSse(res, frame)
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const cookie = /(?:^|;\s*)cockpit_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
  const h = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const given = Buffer.from(h || (url.searchParams.get('token') ?? '') || cookie)
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

async function readJson(
  req: IncomingMessage,
  maxBytes = 32 * 1024 * 1024
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(c as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * 请求体里声明的浏览器 clientId → 只有格式合法且**当前连着**的才采用
 * （否则当作没有浏览器上下文：界面桥会因「没有目标」而明确失败，不会乱找标签页）。
 */
function browserClientOf(body: Record<string, unknown>): string | null {
  const id = body.clientId
  return typeof id === 'string' && CLIENT_ID_RE.test(id) && hasBrowserClient(id) ? id : null
}

function serveStatic(webRoot: string, pathname: string, res: ServerResponse): void {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return json(res, 400, {
      ok: false,
      error: 'bad_request',
      message: '拒绝访问：URL 编码解析失败'
    })
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, '')
  let file = resolve(webRoot, rel || 'index.html')
  if (!file.startsWith(webRoot)) return json(res, 403, { error: 'forbidden' })
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, 'index.html')
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    // 跨源隔离（self.crossOriginIsolated）：掌机的 mGBA wasm 用 SharedArrayBuffer，没有它会
    // DataCloneError。Electron 里靠启动开关，网页里只能靠这两个头。COEP 用 credentialless 而不是
    // require-corp：后者会挡掉没带 CORP 头的跨源图片 / 媒体。（注意 crossOriginIsolated 还要求安全上下文：
    // https 或 localhost——手机本机 127.0.0.1 访问可以，经局域网 IP 的 http 访问则不行。）
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'credentialless'
  })
  // pipeline 而不是 .pipe()：页面加载到一半被打断时 .pipe() 不会关掉读流，文件句柄会一直漏
  pipeline(createReadStream(file), res).catch(() => {})
}

export function startServer(opts: {
  host: string
  port: number
  token: string
  webRoot: string
  /** Electron 内嵌：自定义协议改由 net.fetch 取（缺省用无头替身记下的处理器） */
  protocolFetch?: (scheme: string, req: Request) => Promise<Response>
}): Promise<Server> {
  const { host, port, token, webRoot } = opts
  if (opts.protocolFetch) protocolFetch = opts.protocolFetch
  const server = createServer((req, res) => {
    let url: URL
    try {
      const raw = req.url ?? '/'
      // 拒绝非正常或畸形的 URL 请求（如以 '//' 开头、包含空字节、以反斜杠开头等），防止 WHATWG URL 崩溃与越权穿透
      if (
        !raw ||
        raw.startsWith('//') ||
        raw.startsWith('/\\') ||
        raw.startsWith('\\') ||
        raw.includes('\0')
      ) {
        return json(res, 400, {
          ok: false,
          error: 'bad_request',
          message: '拒绝访问：无效或非法的 URL 请求'
        })
      }
      url = new URL(raw, 'http://127.0.0.1')
      if (url.pathname.startsWith('//')) {
        return json(res, 400, {
          ok: false,
          error: 'bad_request',
          message: '拒绝访问：非法 URL 路径'
        })
      }
    } catch {
      return json(res, 400, {
        ok: false,
        error: 'bad_request',
        message: '拒绝访问：URL 解析失败'
      })
    }
    const api = url.pathname.startsWith('/api/')
    if (url.pathname.startsWith('/_p/')) {
      if (!authorized(req, url, token)) return json(res, 401, { ok: false, error: 'unauthorized' })
      serveProtocol(req, res).catch((e) => {
        log.warn('protocol failed', String(e))
        if (!res.headersSent) json(res, 500, { error: 'protocol error' })
        else res.destroy()
      })
      return
    }
    // 静态页面不要求 token（页面本身不含数据）；所有 /api/* 都要
    if (!api) return serveStatic(webRoot, url.pathname, res)
    if (!authorized(req, url, token)) return json(res, 401, { ok: false, error: 'unauthorized' })

    if (url.pathname === '/api/events') {
      // Old SSE clients still receive broadcasts; only identified pages are UI targets.
      const bridgeId = url.searchParams.get('clientId') ?? ''
      if (bridgeId && !CLIENT_ID_RE.test(bridgeId)) {
        return json(res, 400, { ok: false, error: 'invalid clientId' })
      }
      if (bridgeId) {
        const send = (channel: string, args: unknown[]): void =>
          writeSse(res, `data: ${JSON.stringify({ channel, args })}\n\n`)
        // EventSource 断线后会用同一个 clientId 自动重连，此时旧连接的 close 可能还没触发：
        // 新连接顶替旧连接（同 token 才能走到这里），绝不能回 409——浏览器收到非 200 会永久放弃重连
        const old = bridgeOwners.get(bridgeId)
        registerBrowserClient(bridgeId, send, { replace: true })
        bridgeOwners.set(bridgeId, res)
        if (old && old !== res) {
          clients.delete(old)
          old.end()
        }
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // 经反向代理（nginx 等）访问时不要缓冲事件流
        'x-accel-buffering': 'no'
      })
      req.socket.setNoDelay(true)
      // 半开连接（对端已消失但没发 FIN/RST）靠 TCP 保活尽快发现
      req.socket.setKeepAlive(true, 30_000)
      // 断线重连：EventSource 自动重连带 Last-Event-ID 头，页面手动重建连接带 ?lastEventId=
      const lastId = String(
        req.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? ''
      )
      const replay = lastId ? replayAfter(lastId) : null
      // hello：告诉页面这次是否接上了（resumed=false 且之前连过 → 页面需要整体重新拉取状态）
      res.write(`: ok\n\nevent: hello\ndata: ${JSON.stringify({ resumed: replay !== null })}\n\n`)
      if (replay?.length) {
        log.info('event stream resumed', { replayed: replay.length })
        res.write(replay.join(''))
      } else if (lastId && !replay) log.info('event stream gap, client will resync')
      clients.add(res)
      everHadClient = true
      // 新连上的页面补发待处理的授权请求（含一次性 nonce，只走 SSE）
      const pendingConsent = pendingConsentFrames()
      if (pendingConsent.length)
        res.write(
          `data: ${JSON.stringify({ channel: CONSENT_CHANNEL, args: [pendingConsent] })}\n\n`
        )
      // 具名 ping 事件（注释行 EventSource 读不到）：页面靠它判断连接是否还活着——
      // 手机切后台 / 换网络后 TCP 可能半开，readyState 仍是 OPEN 却再也收不到东西
      const ping = setInterval(() => writeSse(res, 'event: ping\ndata: {}\n\n'), 15000)
      // 半开 / 被顶替的连接上写失败不能变成未处理的 error 事件
      res.on('error', () => {})
      res.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
        // 已被新连接顶替的旧连接关闭时，不能注销新连接
        if (bridgeId && bridgeOwners.get(bridgeId) === res) {
          bridgeOwners.delete(bridgeId)
          unregisterBrowserClient(bridgeId)
        }
      })
      return
    }
    if (url.pathname === '/api/info') {
      // App 连接前的探测也走这里：日志里有它，才能分清「请求没到宿主」还是「宿主没回」
      log.info('info probe')
      return json(res, 200, { platform: process.platform, headless: true })
    }
    if (url.pathname === '/api/commands' && req.method === 'GET') {
      return json(
        res,
        200,
        listCommands().map(({ name, description, usage, privacy }) => ({
          name,
          description,
          usage,
          privacy
        }))
      )
    }
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      receiveUpload(req, url, res).catch(() =>
        json(res, 500, { ok: false, error: 'internal error' })
      )
      return
    }
    if (url.pathname === '/api/privacy/decide' && req.method === 'POST') {
      // 授权决定：token + 随请求下发的一次性 nonce（见 consent.ts）；不是命令
      readJson(req, 4096)
        .then((body) => {
          const r = decideFromPage(body)
          json(res, r.ok ? 200 : 400, r)
        })
        .catch(() => json(res, 400, { ok: false, error: 'bad request' }))
      return
    }
    if (url.pathname === '/api/privacy/deny-all' && req.method === 'POST') {
      return json(res, 200, { ok: true, count: denyAllFromPage() })
    }
    if (url.pathname === '/api/ui-result' && req.method === 'POST') {
      // 页面回传界面请求结果：必须来自同一个 clientId 且 id 仍在 pending（否则拒绝）
      readJson(req, MAX_UI_REPLY_BYTES)
        .then((body) => {
          const r = submitBrowserUiReply(body)
          if (!r.ok) {
            log.warn('browser-ui reply rejected', r.error)
            return json(res, 400, { ok: false, error: r.error })
          }
          json(res, 200, { ok: true })
        })
        .catch((e) => json(res, 400, { ok: false, error: String(e) }))
      return
    }
    if (url.pathname === '/api/cli' && req.method === 'POST') {
      readJson(req)
        .then(async (body) => {
          const meta = body.meta as { agentSession?: unknown } | undefined
          const origin =
            typeof meta?.agentSession === 'string' && meta.agentSession
              ? ({ kind: 'agent-ui', session: meta.agentSession } as const)
              : ({ kind: 'cli' } as const)
          const result = await withBrowserClient(browserClientOf(body), () =>
            withOrigin(origin, () => cliExec(String(body.cmd ?? '')))
          )
          json(res, 200, { ok: true, result })
        })
        .catch((e) =>
          json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) })
        )
      return
    }
    if (url.pathname === '/api/command-result' && req.method === 'POST') {
      readJson(req, 4096)
        .then((body) => {
          const id = typeof body.reqId === 'string' ? body.reqId : ''
          const r = REQ_ID_RE.test(id) ? commandResults.get(id) : undefined
          if (!r) return json(res, 200, { state: 'unknown' })
          if (!r.done) return json(res, 200, { state: 'pending' })
          if (r.body === undefined) return json(res, 200, { state: 'lost' })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(`{"state":"done","response":${r.body}}`)
        })
        .catch(() => json(res, 400, { ok: false, error: 'bad request' }))
      return
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      readJson(req)
        .then(async (body) => {
          const name = String(body.name ?? '')
          const args = (body.args ?? {}) as Record<string, unknown>
          const reqId =
            typeof body.reqId === 'string' && REQ_ID_RE.test(body.reqId) ? body.reqId : null
          if (reqId) commandResults.set(reqId, { done: false, at: Date.now() })
          log.info(name)
          try {
            // 网页客户端等同于本机 UI（用户来源）；agent 降权标记仍只能降不能升
            const meta = body.meta as { agentSession?: unknown } | undefined
            const origin =
              typeof meta?.agentSession === 'string' && meta.agentSession
                ? ({ kind: 'agent-ui', session: meta.agentSession } as const)
                : ({ kind: 'ui' } as const)
            // 调用链关联到发起它的浏览器标签页（YAYA 工作流据此继续操作这个页面）
            const result = await withBrowserClient(browserClientOf(body), () =>
              withOrigin(origin, () => runCommand(name, args))
            )
            sendCommandResult(res, reqId, {
              ok: true,
              result: result === undefined ? null : rewriteUrls(result)
            })
          } catch (err) {
            const unknown = err instanceof UnknownCommandError
            sendCommandResult(res, reqId, {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              unknown,
              silent: unknown ? (err as UnknownCommandError).silent : undefined
            })
          }
        })
        .catch((e) => json(res, 400, { ok: false, error: String(e) }))
      return
    }
    json(res, 404, { ok: false, error: 'not found' })
  })
  server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    // 对端已经没了（手机切后台 / 断网后连接被系统回收）：EPIPE / ECONNRESET 只是连接死了，
    // 不是坏请求。直接销毁，不能再往死连接里写 400（那只会再触发一次错误）。
    if (
      err.code === 'EPIPE' ||
      err.code === 'ECONNRESET' ||
      err.code === 'ETIMEDOUT' ||
      !socket.writable
    ) {
      log.info('client connection lost', { code: err.code ?? String(err), streams: clients.size })
      socket.destroy()
      return
    }
    log.warn('client error', String(err))
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })
  return new Promise((resolveP, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      log.info('headless listening', { url: `http://${host}:${port}/` })
      resolveP(server)
    })
  })
}
