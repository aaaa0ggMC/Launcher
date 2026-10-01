/**
 * 本地 HTTP 服务的入口检查（Remote / MCP 共用）—— docs/agent-access-design.md §6.1。
 *
 * - 只接受 Host 为 127.0.0.1:<port> / localhost:<port>：防 DNS rebinding；
 * - 拒绝带 Origin 头的请求：浏览器网页发起的跨源请求一定带 Origin，脚本 / MCP 客户端不会带 → 防 CSRF；
 * - Bearer token 比对用常数时间比较。
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

export function checkRequest(
  req: IncomingMessage,
  port: number,
  token: string
): { ok: true } | { ok: false; status: number; error: string } {
  const host = String(req.headers.host ?? '')
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    return { ok: false, status: 421, error: 'invalid Host' }
  }
  const origin = req.headers.origin
  if (origin !== undefined && origin !== 'null') {
    return { ok: false, status: 403, error: 'browser origins are not allowed' }
  }
  const auth = String(req.headers.authorization ?? '')
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (!m || !safeEqual(m[1].trim(), token)) {
    return { ok: false, status: 401, error: 'missing or invalid bearer token' }
  }
  return { ok: true }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export async function readBody(req: IncomingMessage, limit = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > limit) throw new Error('request body too large')
    chunks.push(c as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  return text ? JSON.parse(text) : undefined
}
