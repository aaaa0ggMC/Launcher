/**
 * YAYA MCP 客户端（插件提供方 B1）。
 *
 * 只放「连接与协议转换」：一个 MCP 服务器一条 `McpConnection`，
 * 外加一组纯函数（URL 校验 / 请求头脱敏 / 工具名消毒 / tools/call 结果转换），
 * 供 provider.ts 与 `yaya.mcp-test` 共用；单测也只依赖这一个文件。
 *
 * 安全约定：
 *  - 自定义请求头的值是凭据：绝不进日志、不进错误信息、不进返回值（`redactSecrets`）；
 *  - 只允许 http / https（拒绝 file:// 等其它协议）；
 *  - 本文件只抛稳定的 `mcp: …` 内部原因，用户可见文案由 provider.ts 的
 *    `describeMcpError` 翻成本地化文案并脱敏。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Implementation, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig } from '../../../types'
import type { PluginTool, ToolContentPart, ToolContentResult } from '../types'

/** 连接（initialize 握手）超时 */
export const CONNECT_TIMEOUT_MS = 15_000
/** 插件未配置时的单次工具调用超时 */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000
/** instructions 拼进系统提示词的长度上限 */
export const MAX_INSTRUCTIONS_CHARS = 2000
/** tools/list 分页的最大页数（防服务器返回死循环 cursor） */
const MAX_TOOL_PAGES = 100

const CLIENT_NAME = 'linux-cockpit-yaya'
const CLIENT_VERSION = '1.0.0'
/** HTTP 头名允许的字符（token，RFC 7230）——挡住换行注入 */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/

// ---------------------------------------------------------------------------
// 纯函数：URL / 头 / 命名
// ---------------------------------------------------------------------------

/** 只允许 http / https；其它协议直接拒绝（不把用户输入回显进错误信息） */
export function safeUrl(raw: unknown): URL {
  let url: URL
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new Error('mcp: invalid url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('mcp: unsupported url scheme')
  }
  return url
}

/** 取出有效的自定义请求头（空值、非法头名、含控制字符的值一律跳过） */
export function plainHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.trim()
    if (!name || !HEADER_NAME_RE.test(name)) continue
    if (typeof value !== 'string' || !value) continue
    // 控制字符（含 CR/LF/NUL）= 头部注入，跳过；普通空格是合法的（`Bearer xx`）
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) continue
    out[name] = value
  }
  return out
}

/** 服务器 id → `[a-z0-9-]`（插件 id = `mcp-<它>`，必须过注册表的 ID_RE） */
export function sanitizeServerId(id: unknown): string {
  const cleaned = String(id ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || 'server'
}

/** 工具名前缀：`mcp_<id>`（连字符下划线化，注册表还会再过一遍 sanitize） */
export function namespaceOf(serverId: unknown): string {
  return `mcp_${sanitizeServerId(serverId).replace(/-/g, '_')}`
}

/** MCP 工具名 → 插件内裸名 `[a-zA-Z0-9_-]`；原名由 provider 留着调用时用 */
export function sanitizeToolName(name: unknown): string {
  const cleaned = String(name ?? '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return cleaned || 'tool'
}

/** 连接相关配置指纹：transport / url / headers / timeoutMs。同值 = 可以复用同一条连接 */
export function connectionSignature(server: McpServerConfig): string {
  const headers = plainHeaders(server.headers)
  const pairs = Object.keys(headers)
    .sort()
    .map((k) => `${k.toLowerCase()}=${headers[k]}`)
  return JSON.stringify([
    server.transport === 'sse' ? 'sse' : 'streamable-http',
    String(server.url ?? '').trim(),
    server.timeoutMs ?? 0,
    pairs
  ])
}

/** 同上的人类可读版：连接相关配置没变就复用同一个插件对象（注册表据此保留连接） */
export function sameConnectionConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return connectionSignature(a) === connectionSignature(b)
}

// ---------------------------------------------------------------------------
// 脱敏
// ---------------------------------------------------------------------------

/**
 * 把请求头的值从文本里抹掉（`«redacted»`）。错误信息、日志、返回值都要过一遍。
 * 非空值全部隐藏，包括短凭据。
 */
export function redactSecrets(text: string, values: readonly string[]): string {
  let out = String(text ?? '')
  for (const value of values) {
    const secret = String(value ?? '')
    if (!secret) continue
    if (!out.includes(secret)) continue
    out = out.split(secret).join('«redacted»')
  }
  return out
}

/** 已知的「内部原因码」（调用方映射成本地化文案） */
export type McpErrorCode = 'timeout' | 'url-scheme' | 'invalid-url' | 'closed'

export function mcpErrorCode(err: unknown): McpErrorCode | null {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/^mcp: connect timeout after \d+ ms$/.test(msg)) return 'timeout'
  if (/^mcp: unsupported url scheme$/.test(msg)) return 'url-scheme'
  if (/^mcp: invalid url$/.test(msg)) return 'invalid-url'
  if (/^mcp: connection closed$/.test(msg)) return 'closed'
  return null
}

/** 超时毫秒数（`mcpErrorCode(err) === 'timeout'` 时才有） */
export function mcpErrorMs(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return Number(msg.match(/^mcp: connect timeout after (\d+) ms$/)?.[1]) || undefined
}

/** 脱敏后的原始错误信息（未知原因的兜底文案用） */
export function mcpErrorMessage(err: unknown, secrets: readonly string[] = []): string {
  const raw = err instanceof Error ? err.message : String(err ?? '')
  return redactSecrets(raw, secrets).replace(/^mcp: /, '')
}

/** 连接类错误（断开 / 网络中断）→ 工具调用可以重连一次再试 */
export function isTransportError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  return /not connected|connection closed|connection.*closed|fetch failed|terminated|ECONNRESET|EPIPE|socket hang up|network error|timed? ?out/i.test(
    msg
  )
}

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------

/** tools/call 的返回（SDK 的 CallToolResult，或旧协议的 task 变体） */
export interface McpToolResultLike {
  content?: unknown
  structuredContent?: Record<string, unknown>
  isError?: boolean
  toolResult?: unknown
  [key: string]: unknown
}

export interface McpConnectOptions {
  /** 握手超时，默认 15s */
  timeoutMs?: number
  /** 服务器推送 notifications/tools/list_changed */
  onToolsChanged?: () => void
}

/** 一条到 MCP 服务器的连接（Client + Transport + initialize 拿到的自报信息） */
export class McpConnection {
  closed = false
  readonly serverInfo: Implementation | undefined
  readonly instructions: string | undefined

  private constructor(
    private readonly client: Client,
    private readonly transport: { close(): Promise<void> }
  ) {
    this.serverInfo = client.getServerVersion()
    this.instructions = client.getInstructions()
  }

  static async open(server: McpServerConfig, opts: McpConnectOptions = {}): Promise<McpConnection> {
    const url = safeUrl(server.url)
    const headers = plainHeaders(server.headers)
    if (Object.values(headers).some((v) => /^enc:v[12]:/.test(v))) {
      throw new Error('mcp: credentials could not be decrypted')
    }
    const client = new Client(
      { name: CLIENT_NAME, version: CLIENT_VERSION },
      {
        capabilities: {},
        // 工具列表变化自己拉（要处理分页），不用 SDK 的 autoRefresh
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: (err) => {
              if (err) return
              opts.onToolsChanged?.()
            }
          }
        }
      }
    )
    const transport =
      server.transport === 'sse'
        ? new SSEClientTransport(url, {
            requestInit: { headers },
            // SSE 那条 GET 流的请求头由 SDK 从 requestInit 合并，无需另给
            eventSourceInit: { fetch: globalThis.fetch.bind(globalThis) }
          })
        : new StreamableHTTPClientTransport(url, { requestInit: { headers } })

    try {
      await withTimeout(client.connect(transport), opts.timeoutMs ?? CONNECT_TIMEOUT_MS)
    } catch (e) {
      await closeQuietly(transport)
      await closeQuietly(client)
      throw e
    }
    return new McpConnection(client, transport)
  }

  /** tools/list（带 cursor 分页） */
  async listTools(): Promise<McpTool[]> {
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    const out: McpTool[] = []
    const used = new Set<string>()
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`mcp: connect timeout after ${CONNECT_TIMEOUT_MS} ms`)
      const res = await this.client.listTools(cursor ? { cursor } : undefined, {
        timeout: remaining
      })
      out.push(...(res.tools ?? []))
      const next = res.nextCursor
      if (!next || used.has(next)) break
      used.add(next)
      cursor = next
    }
    return out
  }

  /** tools/call；`timeoutMs` / `signal` 由调用方（registry 已包一层超时）传入 */
  async callTool(
    rawName: string,
    args: Record<string, unknown>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<McpToolResultLike> {
    const res = await this.client.callTool({ name: rawName, arguments: args }, undefined, {
      signal: opts.signal,
      timeout: opts.timeoutMs
    })
    return res as McpToolResultLike
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await closeQuietly(this.transport)
    await closeQuietly(this.client)
  }
}

/** 超时Promise：先到的赢，后到的结果被丢弃但不能变成 unhandled rejection */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mcp: connect timeout after ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** 关闭失败无所谓：连接本来就要丢 */
async function closeQuietly(target: { close(): Promise<void> }): Promise<void> {
  try {
    await target.close()
  } catch {
    // 关闭失败无所谓：连接本来就要丢
  }
}

// ---------------------------------------------------------------------------
// tools/call 结果 → 插件结果（纯函数，单测覆盖）
// ---------------------------------------------------------------------------

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** content 的单个片段 → 交给模型的片段；音频 / 二进制资源降级成文本占位 */
export function convertContentPart(item: unknown): ToolContentPart | null {
  if (!item || typeof item !== 'object') return null
  const part = item as Record<string, unknown>
  switch (part.type) {
    case 'text':
      return { type: 'text', text: typeof part.text === 'string' ? part.text : '' }
    case 'image':
      return {
        type: 'image',
        mimeType: String(part.mimeType ?? 'image/png'),
        data: String(part.data ?? '')
      }
    case 'audio':
      return { type: 'text', text: `[audio: ${String(part.mimeType ?? 'audio/*')}]` }
    case 'resource': {
      const res = (part.resource ?? {}) as Record<string, unknown>
      if (typeof res.text === 'string') return { type: 'text', text: res.text }
      const mime = String(res.mimeType ?? 'application/octet-stream')
      return { type: 'text', text: `[resource: ${String(res.uri ?? '')} (${mime})]` }
    }
    case 'resource_link':
      return { type: 'text', text: `[link: ${String(part.name ?? '')} ${String(part.uri ?? '')}]` }
    default:
      return { type: 'text', text: safeJson(item) }
  }
}

/**
 * MCP `CallToolResult` → `ToolContentResult`：
 * 文本 / 图片交给模型；音频、二进制资源、resource_link 降级成文本占位；
 * `structuredContent` 进 `display`（content 为空时同时 JSON 化给模型一份）。
 */
export function convertCallToolResult(result: McpToolResultLike): ToolContentResult {
  const parts: ToolContentPart[] = []
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      const part = convertContentPart(item)
      if (part) parts.push(part)
    }
  } else if (result.toolResult !== undefined) {
    // 旧协议的 task 变体：没有 content，只有 toolResult
    parts.push({ type: 'text', text: safeJson(result.toolResult) })
  }

  const structured = result.structuredContent
  if (structured !== undefined && parts.length === 0) {
    parts.push({ type: 'text', text: safeJson(structured) })
  }

  const out: ToolContentResult = { content: parts, isError: result.isError === true }
  if (structured !== undefined) out.display = structured
  return out
}

// ---------------------------------------------------------------------------
// MCP 工具 → 插件工具（供 provider 与 yaya.mcp-test 预览）
// ---------------------------------------------------------------------------

/** 工具入参 schema：不是对象就用空 schema */
export function schemaOf(inputSchema: unknown): Record<string, unknown> {
  if (inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>
  }
  return { type: 'object', properties: {} }
}

/** 只读提示 = 直接执行，其余 = 每次确认 */
export function approvalOf(annotations: unknown): 'ask' | 'auto' {
  const readOnly = (annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint
  return readOnly === true ? 'auto' : 'ask'
}

export interface McpToolSpec {
  /** 插件内裸名（已消毒） */
  name: string
  /** 调用时要用的 MCP 原名 */
  rawName: string
  description: string
  parameters: Record<string, unknown>
  approval: 'ask' | 'auto'
  timeoutMs: number
}

/** 归一化 tools/list 的结果（重名去重、消毒、补齐缺省字段） */
export function normalizeTools(
  tools: readonly McpTool[] | undefined,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS
): McpToolSpec[] {
  const out: McpToolSpec[] = []
  const seen = new Set<string>()
  for (const item of tools ?? []) {
    const rawName = String(item?.name ?? '')
    if (!rawName) continue
    const name = sanitizeToolName(rawName)
    if (seen.has(name)) continue
    seen.add(name)
    out.push({
      name,
      rawName,
      description: String(item?.description ?? '').trim(),
      parameters: schemaOf(item?.inputSchema),
      approval: approvalOf(item?.annotations),
      timeoutMs
    })
  }
  return out
}

/** 归一化后的描述 → `PluginTool`（run 由调用方提供，见 provider.ts） */
export function toPluginTool(spec: McpToolSpec, run: PluginTool['run']): PluginTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    approval: spec.approval,
    timeoutMs: spec.timeoutMs,
    run
  }
}
