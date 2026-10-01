/**
 * Remote 服务：给自己写的脚本用的轻量 JSON-RPC 2.0 over HTTP（docs/agent-access-design.md §6.3）。
 *
 *   POST http://127.0.0.1:<port>/rpc   { "jsonrpc":"2.0", "id":1, "method":"ui_snapshot", "params":{} }
 *   头：Authorization: Bearer <token>，可选 X-Cockpit-Client / X-Cockpit-Session
 *
 * 方法名与 MCP 工具一一对应，另有 `tools/list`。curl 即可调用，不需要 WebSocket 依赖。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { withOrigin } from '../privacy'
import { makeLogger } from '../logger'
import { AGENT_TOOLS, describeError, runAgentTool } from './tools'
import { checkRequest, readBody, sendJson } from './http-guard'
import { touchSession } from './sessions'

const log = makeLogger('agent.remote')

interface RpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name]
  return (Array.isArray(v) ? v[0] : (v ?? '')).toString().slice(0, 80)
}

export class RemoteService {
  private http: Server | null = null

  constructor(
    readonly port: number,
    private readonly token: string
  ) {}

  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        log.warn('request failed', describeError(e))
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject)
      this.http!.listen(this.port, '127.0.0.1', () => resolve())
    })
    log.info('Remote listening', { url: `http://127.0.0.1:${this.port}/rpc` })
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()))
    this.http?.closeAllConnections?.()
    this.http = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/rpc') return sendJson(res, 404, { error: 'not found' })
    const chk = checkRequest(req, this.port, this.token)
    if (!chk.ok) return sendJson(res, chk.status, { error: chk.error })
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' })

    let body: RpcRequest
    try {
      body = (await readBody(req)) as RpcRequest
    } catch (e) {
      return sendJson(res, 400, rpcError(null, -32700, describeError(e).error as string))
    }
    const id = body?.id ?? null
    const client = header(req, 'x-cockpit-client') || 'remote'
    const session = header(req, 'x-cockpit-session') || `remote:${client}`

    if (body?.method === 'tools/list') {
      return sendJson(res, 200, {
        jsonrpc: '2.0',
        id,
        result: AGENT_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: z.toJSONSchema(z.object(t.shape))
        }))
      })
    }
    const tool = AGENT_TOOLS.find((t) => t.name === body?.method)
    if (!tool) return sendJson(res, 200, rpcError(id, -32601, `unknown method: ${body?.method}`))
    const parsed = z.object(tool.shape).safeParse(body.params ?? {})
    if (!parsed.success) {
      return sendJson(res, 200, rpcError(id, -32602, parsed.error.message))
    }
    touchSession(session, 'remote', client)
    try {
      const out = await withOrigin({ kind: 'remote', session, client }, () =>
        runAgentTool(tool, parsed.data as Record<string, unknown>)
      )
      const base =
        out.kind === 'image'
          ? { image: { mimeType: out.mimeType, data: out.data }, ...((out.meta as object) ?? {}) }
          : out.value
      // 有脱敏时附 `_privacy`；非对象结果（数组 / 字符串）包一层，保证说明不丢
      const result = !out.privacy
        ? base
        : base && typeof base === 'object' && !Array.isArray(base)
          ? { ...base, _privacy: out.privacy }
          : { result: base, _privacy: out.privacy }
      return sendJson(res, 200, { jsonrpc: '2.0', id, result })
    } catch (e) {
      return sendJson(res, 200, rpcError(id, -32000, 'tool failed', describeError(e)))
    }
  }
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }
}
