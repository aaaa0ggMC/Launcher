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
import { cliExec } from '../main/process/cli'
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
async function serveProtocol(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const m = /^\/_p\/(cockpit-(?:icon|audio|tile))\/(.*)$/s.exec(req.url ?? '')
  const handler = m && getProtocolHandler(m[1])
  if (!m || !handler) return json(res, 404, { error: 'unknown protocol' })
  const headers = new Headers()
  if (req.headers.range) headers.set('Range', String(req.headers.range))
  const r = await handler(new Request(`${m[1]}://${m[2]}`, { headers }))
  const out: Record<string, string> = {}
  r.headers.forEach((val, key) => (out[key] = val))
  res.writeHead(r.status, out)
  if (!r.body) return void res.end()
  const body = Readable.fromWeb(r.body as never)
  req.on('close', () => body.destroy())
  body.on('error', () => res.destroy())
  body.pipe(res)
}

/** broadcast(channel, ...args) → 所有 SSE 客户端 */
export function pushEvent(channel: string, ...args: unknown[]): void {
  if (!clients.size) return
  // 广播载荷里同样可能带 cockpit-*:// 地址（如 aidj 的 cockpit:aidj-webplayer 里的 audioUrl），
  // 和命令返回值一样要改写成 /_p/ 路由，否则浏览器的 <audio> / <img> 加载不了
  const frame = `data: ${JSON.stringify({ channel, args: rewriteUrls(args) })}\n\n`
  for (const res of clients) res.write(frame)
}

function authorized(req: IncomingMessage, url: URL, token: string): boolean {
  const cookie = /(?:^|;\s*)cockpit_token=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
  const h = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const given = Buffer.from(h || (url.searchParams.get('token') ?? '') || cookie)
  const want = Buffer.from(token)
  return given.length === want.length && timingSafeEqual(given, want)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 32 * 1024 * 1024) throw new Error('body too large')
    chunks.push(c as Buffer)
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function serveStatic(webRoot: string, pathname: string, res: ServerResponse): void {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
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
  createReadStream(file).pipe(res)
}

export function startServer(opts: {
  host: string
  port: number
  token: string
  webRoot: string
}): Promise<Server> {
  const { host, port, token, webRoot } = opts
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
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
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write(': ok\n\n')
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 25000)
      req.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
      })
      return
    }
    if (url.pathname === '/api/info')
      return json(res, 200, { platform: process.platform, headless: true })
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
    if (url.pathname === '/api/cli' && req.method === 'POST') {
      readJson(req)
        .then(async (body) => {
          const meta = body.meta as { agentSession?: unknown } | undefined
          const origin =
            typeof meta?.agentSession === 'string' && meta.agentSession
              ? ({ kind: 'agent-ui', session: meta.agentSession } as const)
              : ({ kind: 'cli' } as const)
          json(res, 200, {
            ok: true,
            result: await withOrigin(origin, () => cliExec(String(body.cmd ?? '')))
          })
        })
        .catch((e) =>
          json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) })
        )
      return
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      readJson(req)
        .then(async (body) => {
          const name = String(body.name ?? '')
          const args = (body.args ?? {}) as Record<string, unknown>
          log.info(name)
          try {
            // 网页客户端等同于本机 UI（用户来源）；agent 降权标记仍只能降不能升
            const meta = body.meta as { agentSession?: unknown } | undefined
            const origin =
              typeof meta?.agentSession === 'string' && meta.agentSession
                ? ({ kind: 'agent-ui', session: meta.agentSession } as const)
                : ({ kind: 'ui' } as const)
            const result = await withOrigin(origin, () => runCommand(name, args))
            json(res, 200, { ok: true, result: result === undefined ? null : rewriteUrls(result) })
          } catch (err) {
            const unknown = err instanceof UnknownCommandError
            json(res, 200, {
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
  return new Promise((resolveP, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      log.info('headless listening', { url: `http://${host}:${port}/` })
      resolveP(server)
    })
  })
}
