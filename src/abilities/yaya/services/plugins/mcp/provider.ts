/**
 * MCP 插件提供方（YAYA B1）。
 *
 * 每个 `config.mcpServers` 条目 = 一个插件（`mcp-<id>`），工具来自服务器的
 * `tools/list`，`instructions` 来自 initialize 握手时服务器自报的说明。
 *
 * 连接生命周期：
 *  - `sync()` 只做「配置 → 插件对象」的映射；连接相关配置（transport / url /
 *    headers / timeoutMs）没变时**返回同一个插件对象**，注册表据此保留连接；
 *    变了就返回新对象，注册表会 stop 旧的（关掉旧连接）；
 *  - 插件被启用后，注册表在第一次需要工具前调 `start()` 建连；
 *  - 禁用的服务器也生成插件对象（设置页要看得到），`defaultEnabled = server.enabled`。
 */
import { makeLogger } from '../../../../../main/process/logger'
import { t, te } from '../../../../../main/process/i18n'
import { getBroadcast } from '../../../../../main/process/broadcast'
import type { McpServerConfig, YayaConfig } from '../../../types'
import { registerPluginProvider } from '../registry'
import type { PluginProvider, PluginStatus, PluginTool, ToolRunContext, YayaPlugin } from '../types'
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_INSTRUCTIONS_CHARS,
  McpConnection,
  convertCallToolResult,
  isTransportError,
  mcpErrorCode,
  mcpErrorMessage,
  mcpErrorMs,
  normalizeTools,
  namespaceOf,
  plainHeaders,
  sameConnectionConfig,
  sanitizeServerId,
  toPluginTool
} from './client'

const log = makeLogger('yaya-mcp')

/** 插件状态 + 连接 + 工具缓存（一个插件对象一份，配置变了就换新的） */
interface McpEntry {
  server: McpServerConfig
  plugin: YayaPlugin
  conn: McpConnection | null
  /** 建连进行中的 Promise（并发 start() 只连一次） */
  connecting: Promise<void> | null
  status: PluginStatus
  tools: PluginTool[]
  /** 裸工具名 → MCP 原名（调用时要传回去） */
  rawNames: Map<string, string>
  /** initialize 拿到的服务器 instructions（原文截断后缓存，同连接内稳定） */
  instructions: string
  /** 连接代号：stop() / 换配置时 +1，进行中的建连任务据此发现自己已作废 */
  gen: number
}

const entries = new Map<string, McpEntry>()

/** 错误 → 用户可见文案（header 值已脱敏，绝不外泄） */
export function describeMcpError(err: unknown, secrets: readonly string[] = []): string {
  const code = mcpErrorCode(err)
  if (code === 'timeout') {
    return te(
      'yaya.mcp.err_timeout',
      { ms: String(mcpErrorMs(err) ?? CONNECT_TIMEOUT_MS) },
      '连接超时（{ms} 毫秒）'
    )
  }
  if (code === 'url-scheme') return t('yaya.mcp.err_scheme', '只支持 http / https 地址')
  if (code === 'invalid-url') return t('yaya.mcp.err_bad_url', '无效的服务器地址')
  if (code === 'closed') return t('yaya.mcp.err_closed', 'MCP 连接已关闭')
  return mcpErrorMessage(err, secrets)
}

function secretsOf(server: McpServerConfig): string[] {
  return Object.values(plainHeaders(server.headers))
}

function connectError(entry: McpEntry, err: unknown): string {
  return te(
    'yaya.mcp.err_connect',
    { reason: describeMcpError(err, secretsOf(entry.server)) },
    '连接 MCP 服务器失败：{reason}'
  )
}

// ---------------------------------------------------------------------------
// 插件对象
// ---------------------------------------------------------------------------

/** 插件描述：未连接给 URL，连上给服务器自报的 name / version + instructions 摘要 */
function describeEntry(entry: McpEntry): string {
  const info = entry.conn?.serverInfo
  if (!info?.name) return te('yaya.mcp.desc_idle', { url: entry.server.url }, 'MCP 服务器：{url}')
  const version = info.version ? ` ${info.version}` : ''
  const hint = entry.instructions ? ` · ${excerpt(entry.instructions)}` : ''
  return (
    te('yaya.mcp.desc_ready', { server: `${info.name}${version}` }, 'MCP 服务器 {server}') + hint
  )
}

/** instructions 摘要（描述里只放第一行的一小截） */
function excerpt(text: string, max = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** 拼进系统提示词的片段：`MCP server "<名字>":` + 服务器 instructions（已截断） */
function promptInstructions(entry: McpEntry): string {
  if (!entry.instructions) return ''
  return `MCP server "${entry.server.name || entry.server.id}":\n${entry.instructions}`
}

/** 服务器 instructions 截断到上限（缓存进 entry，保证同连接内逐字节稳定） */
function clipInstructions(raw: string | undefined): string {
  const text = (raw ?? '').trim()
  if (!text) return ''
  return text.length > MAX_INSTRUCTIONS_CHARS ? `${text.slice(0, MAX_INSTRUCTIONS_CHARS)}…` : text
}

/** 配置里的非连接字段（名字 / 启用态）变化时同步到插件对象上 */
function refreshMeta(entry: McpEntry): void {
  entry.plugin.label = entry.server.name || entry.server.id
  entry.plugin.defaultEnabled = entry.server.enabled !== false
  entry.plugin.description = describeEntry(entry)
}

function buildEntry(server: McpServerConfig): McpEntry {
  const entry: McpEntry = {
    server,
    plugin: null as unknown as YayaPlugin, // 下面立刻赋值（插件闭包里要引用 entry）
    conn: null,
    connecting: null,
    status: { state: 'idle' },
    tools: [],
    rawNames: new Map(),
    instructions: '',
    gen: 0
  }
  entry.plugin = {
    id: `mcp-${sanitizeServerId(server.id)}`,
    kind: 'mcp',
    label: server.name || server.id,
    description: describeEntry(entry),
    icon: 'mdi-server-network',
    namespace: namespaceOf(server.id),
    defaultEnabled: server.enabled !== false,
    instructions: (): string => promptInstructions(entry),
    tools: (): PluginTool[] => entry.tools,
    status: (): PluginStatus => entry.status,
    start: async (): Promise<void> => {
      await ensureConnected(entry)
    },
    stop: async (): Promise<void> => {
      await closeEntry(entry)
    }
  }
  return entry
}

// ---------------------------------------------------------------------------
// 连接与工具缓存
// ---------------------------------------------------------------------------

async function ensureConnected(entry: McpEntry): Promise<void> {
  if (entry.conn && !entry.conn.closed) return
  if (entry.connecting) return entry.connecting
  entry.status = { state: 'connecting' }
  const gen = ++entry.gen
  const task = (async (): Promise<void> => {
    let opened: McpConnection | null = null
    try {
      opened = await McpConnection.open(entry.server, {
        timeoutMs: CONNECT_TIMEOUT_MS,
        onToolsChanged: () => void refreshTools(entry)
      })
      // 建连期间被 stop() / 换了配置 → 这条连接没人要，立刻关掉
      if (gen !== entry.gen) {
        await opened.close().catch(() => {})
        return
      }
      entry.conn = opened
      entry.instructions = clipInstructions(opened.instructions)
      // tools/list 失败 = 这个插件没有工具可用，按连接失败处理
      applyTools(entry, await opened.listTools())
      entry.status = { state: 'ready' }
      refreshMeta(entry)
    } catch (e) {
      // 已被 stop() / 换配置接手，状态由那边管
      if (gen !== entry.gen) return
      if (opened) await opened.close().catch(() => {})
      entry.conn = null
      entry.tools = []
      entry.rawNames = new Map()
      entry.instructions = ''
      const message = connectError(entry, e)
      entry.status = { state: 'error', message }
      refreshMeta(entry)
      log.warn('mcp connect failed', { server: entry.server.id, error: message })
      throw new Error(message)
    }
  })()
  entry.connecting = task
  void task.then(
    () => {
      entry.connecting = null
    },
    () => {
      entry.connecting = null
    }
  )
  return task
}

/** tools/list_changed 通知 → 重新拉取并广播（失败保留旧列表） */
async function refreshTools(entry: McpEntry): Promise<void> {
  const conn = entry.conn
  if (!conn || conn.closed) return
  try {
    applyTools(entry, await conn.listTools())
    refreshMeta(entry)
    getBroadcast()('cockpit:yaya-plugins-changed', {})
  } catch (e) {
    log.warn('mcp tools/list failed', {
      server: entry.server.id,
      error: describeMcpError(e, secretsOf(entry.server))
    })
  }
}

function applyTools(entry: McpEntry, raw: Awaited<ReturnType<McpConnection['listTools']>>): void {
  const timeoutMs = entry.server.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  const names = new Map<string, string>()
  const tools: PluginTool[] = []
  for (const spec of normalizeTools(raw, timeoutMs)) {
    names.set(spec.name, spec.rawName)
    tools.push(toPluginTool(spec, (args, ctx) => runTool(entry, spec.name, args, ctx)))
  }
  entry.rawNames = names
  entry.tools = tools
}

async function closeEntry(entry: McpEntry): Promise<void> {
  entry.gen++
  const conn = entry.conn
  entry.conn = null
  entry.tools = []
  entry.rawNames = new Map()
  entry.instructions = ''
  entry.status = { state: 'idle' }
  refreshMeta(entry)
  if (conn) await conn.close().catch(() => {})
}

/** 断线只清理连接，下一次调用重新连接；不重放结果未知的写操作。 */
async function runTool(
  entry: McpEntry,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolRunContext
): Promise<unknown> {
  const rawName = entry.rawNames.get(name) ?? name
  const timeoutMs = entry.server.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  const attempt = async (): Promise<unknown> => {
    if (!entry.conn || entry.conn.closed) await ensureConnected(entry)
    const conn = entry.conn
    if (!conn) throw new Error('mcp: connection closed')
    return convertCallToolResult(
      await conn.callTool(rawName, args, { signal: ctx.signal, timeoutMs })
    )
  }
  try {
    return await attempt()
  } catch (e) {
    if (isTransportError(e) && !ctx.signal.aborted) await closeEntry(entry)
    throw new Error(describeMcpError(e, secretsOf(entry.server)))
  }
}

// ---------------------------------------------------------------------------
// 提供方
// ---------------------------------------------------------------------------

export const mcpProvider: PluginProvider = {
  id: 'mcp',
  sync(config: YayaConfig): YayaPlugin[] {
    const out: YayaPlugin[] = []
    const alive = new Set<string>()
    for (const server of config.mcpServers ?? []) {
      const id = `mcp-${sanitizeServerId(server.id)}`
      if (alive.has(id)) {
        log.warn('mcp server id collides after sanitize, skipped', { id })
        continue
      }
      alive.add(id)
      const existing = entries.get(id)
      // 连接相关配置没变 → 复用同一个插件对象（注册表不会 stop，连接继续用）
      if (existing && sameConnectionConfig(existing.server, server)) {
        existing.server = server
        refreshMeta(existing)
        out.push(existing.plugin)
        continue
      }
      const entry = buildEntry(server)
      entries.set(id, entry)
      out.push(entry.plugin)
    }
    // 配置里已经没有的服务器：丢掉条目（旧插件对象的 stop() 会关掉它的连接）
    for (const [id, entry] of [...entries]) {
      if (alive.has(id)) continue
      entries.delete(id)
      void closeEntry(entry)
    }
    return out
  }
}

registerPluginProvider(mcpProvider)
