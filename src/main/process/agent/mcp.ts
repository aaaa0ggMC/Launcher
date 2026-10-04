/**
 * MCP 服务：Streamable HTTP，`http://127.0.0.1:<port>/mcp`（docs/agent-access-design.md §6.2）。
 * 每个 MCP 会话一个 McpServer + transport；工具调用在 `{ kind: 'mcp', session, client }` 来源下执行。
 */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { app } from 'electron'
import { withOrigin } from '../privacy'
import { withCallSignal } from './call-signal'
import { makeLogger } from '../logger'
import { getActiveAgentTools, describeError, runAgentTool, type ToolOutput } from './tools'
import { checkRequest, readBody, sendJson } from './http-guard'
import {
  endSession,
  sanitizeAvatar,
  setSessionAvatar,
  setSessionClient,
  touchSession
} from './sessions'

const log = makeLogger('agent.mcp')

const INSTRUCTIONS = `Linux Cockpit (desktop control center). Call "overview" first.
Read the UI with ui_snapshot, act with ui_click / ui_type / ui_key / ui_scroll using [ref=eN],
use ui_screenshot to see layout. Protected data shows as «redacted:<scope>»; to see it, call
request_clearance with an honest reason — the user approves in a window you cannot see.`

type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

function toMcp(out: ToolOutput): { content: McpContent[] } {
  const r = toMcpContent(out)
  // 脱敏说明单独一段文本，放最前：agent 先读到「这是脱敏 / 授权已过期」再读数据
  if (out.privacy)
    r.content.unshift({ type: 'text', text: JSON.stringify({ privacy: out.privacy }) })
  return r
}

function toMcpContent(out: ToolOutput): { content: McpContent[] } {
  if (out.kind === 'image') {
    return {
      content: [
        { type: 'image', data: out.data, mimeType: out.mimeType },
        { type: 'text', text: JSON.stringify(out.meta) }
      ]
    }
  }
  if (out.kind === 'images') {
    return {
      content: [
        { type: 'text', text: JSON.stringify(out.meta) },
        ...out.images.flatMap((im): McpContent[] => [
          { type: 'text', text: im.label },
          { type: 'image', data: im.data, mimeType: im.mimeType }
        ])
      ]
    }
  }
  const v = out.value
  // 快照文本直接给出（不转义），其余 JSON
  if (v && typeof v === 'object' && 'snapshot' in v) {
    const { snapshot, ...meta } = v as { snapshot: string }
    return { content: [{ type: 'text', text: `${JSON.stringify(meta)}\n${snapshot}` }] }
  }
  return {
    content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }]
  }
}

function buildServer(session: () => { id: string; client: string }): McpServer {
  const server = new McpServer(
    { name: 'linux-cockpit', version: app.getVersion() },
    { instructions: INSTRUCTIONS }
  )
  for (const tool of getActiveAgentTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly === true,
          destructiveHint: tool.destructive === true,
          openWorldHint: false
        }
      },
      async (args: Record<string, unknown>, extra?: { signal?: AbortSignal }) => {
        const s = session()
        touchSession(s.id, 'mcp', s.client, undefined, tool.name)
        return withOrigin({ kind: 'mcp', session: s.id, client: s.client }, () =>
          withCallSignal(extra?.signal, async () => {
            try {
              return toMcp(await runAgentTool(tool, args ?? {}))
            } catch (e) {
              log.info('tool error', { tool: tool.name, ...describeError(e) })
              return {
                isError: true,
                content: [{ type: 'text' as const, text: JSON.stringify(describeError(e)) }]
              }
            }
          })
        )
      }
    )
  }
  return server
}

interface Live {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

export class McpService {
  private http: Server | null = null
  private sessions = new Map<string, Live>()

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
    log.info('MCP listening', { url: `http://127.0.0.1:${this.port}/mcp` })
  }

  async stop(): Promise<void> {
    for (const [id, live] of this.sessions) {
      await live.transport.close().catch(() => {})
      endSession(id)
    }
    this.sessions.clear()
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()))
    this.http?.closeAllConnections?.()
    this.http = null
  }

  /** 设置页断开某个会话。 */
  close(id: string): void {
    const live = this.sessions.get(id)
    if (!live) return
    this.sessions.delete(id)
    void live.transport.close()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/mcp') return sendJson(res, 404, { error: 'not found' })
    const chk = checkRequest(req, this.port, this.token)
    if (!chk.ok) return sendJson(res, chk.status, { error: chk.error })

    const sid = req.headers['mcp-session-id']
    const existing = typeof sid === 'string' ? this.sessions.get(sid) : undefined

    if (req.method === 'POST') {
      const body = await readBody(req)
      if (existing) return existing.transport.handleRequest(req, res, body)
      // 客户端可能带着上一次进程遗留的 session id 重连。如果它发的是 initialize，
      // 就为它建新会话，而不是把重连挡回去——否则应用一重启，agent 侧永远连不上
      // （旧逻辑 `if (sid || !isInitializeRequest(body))` 会连 initialize 一起拒掉）。
      if (!isInitializeRequest(body)) {
        return sendJson(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'unknown or missing MCP session' },
          id: null
        })
      }
      if (sid) log.warn('ignoring stale MCP session on initialize', { stale: String(sid) })
      // onsessioninitialized 在 handleRequest 期间回调，那时 server 已建好；经 holder 引用
      const holder: { live?: Live } = {}
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          const live = holder.live
          if (!live) return
          this.sessions.set(id, live)
          const client = live.server.server.getClientVersion()?.name ?? 'mcp-client'
          touchSession(id, 'mcp', client, () => this.close(id))
          // 头像：initialize 请求的 X-Cockpit-Avatar 头（此刻可读）；clientInfo.icons 要等握手完成，见 oninitialized
          const hdr = req.headers['x-cockpit-avatar']
          setSessionAvatar(id, typeof hdr === 'string' ? hdr : undefined)
          log.info('MCP session opened', { id, client })
        }
      })
      transport.onclose = () => {
        const id = transport.sessionId
        if (id) {
          this.sessions.delete(id)
          endSession(id)
          log.info('MCP session closed', { id })
        }
      }
      const server = buildServer(() => ({
        id: transport.sessionId ?? 'mcp',
        client: server.server.getClientVersion()?.name ?? 'mcp-client'
      }))
      // 握手完成后才有 clientInfo：补上真实名字，并在没有 header 头像时取 icons 里的 data: 图
      server.server.oninitialized = () => {
        const id = transport.sessionId
        const cv = server.server.getClientVersion() as
          { name?: string; icons?: { src?: string }[] } | undefined
        if (!id || !cv) return
        if (cv.name) setSessionClient(id, cv.name)
        const icon = cv.icons?.map((i) => sanitizeAvatar(i?.src)).find(Boolean)
        if (icon) setSessionAvatar(id, icon, false)
      }
      holder.live = { transport, server }
      await server.connect(transport)
      return transport.handleRequest(req, res, body)
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) {
        return sendJson(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'unknown or missing MCP session' },
          id: null
        })
      }
      return existing.transport.handleRequest(req, res)
    }
    res.writeHead(405).end()
  }
}
