/**
 * MCP 相关命令（主进程，YAYA B1）。
 *
 *  - `yaya.mcp-test`：用给定配置**临时**连接一个 MCP 服务器（不影响已保存的连接），
 *    返回服务器自报信息、instructions 与工具列表，用完即关。设置页「测试连接」用。
 *
 * 渲染端拿不到请求头明文（`config-get` 只回传头名），所以 `server.id` 与已保存服务器
 * 相同时，空值的 header 用已保存的明文补上。该命令会向任意 URL 发带凭据的请求
 * → `privacy: { agent: 'deny' }`，且参数不进 IPC 日志（`logArgs: false`）。
 */
import { makeLogger } from '../../../../../main/process/logger'
import { t } from '../../../../../main/process/i18n'
import type { CommandSpec } from '../../../../../main/process/commands/types'
import { loadYayaConfig, normalizeMcpServers } from '../../config'
import type { McpServerConfig } from '../../../types'
import { CONNECT_TIMEOUT_MS, McpConnection, plainHeaders } from './client'
import { describeMcpError } from './provider'

const log = makeLogger('yaya-mcp')

/** 已保存的同名服务器 → 用明文补上渲染端留下的空 header 值 */
function mergeSavedHeaders(server: McpServerConfig): McpServerConfig {
  const saved = loadYayaConfig().mcpServers.find((m) => m.id === server.id)
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    const name = key.trim()
    if (!name) continue
    const fallback =
      saved?.headers?.[name] ??
      Object.entries(saved?.headers ?? {}).find(
        ([k]) => k.toLowerCase() === name.toLowerCase()
      )?.[1] ??
      ''
    headers[name] = value || fallback
  }
  return { ...server, headers }
}

/** 校验入参并补明文 header；失败给出本地化原因 */
function resolveServer(raw: unknown): { server: McpServerConfig } | { error: string } {
  const [server] = normalizeMcpServers([raw])
  if (!server) return { error: t('yaya.mcp.err_bad_server', '无效的 MCP 服务器配置') }
  if (!server.url) return { error: t('yaya.mcp.err_no_url', '缺少 MCP 服务器地址（url）') }
  return { server: mergeSavedHeaders(server) }
}

export const mcpCommands: CommandSpec[] = [
  {
    name: 'yaya.mcp-test',
    description: t(
      'yaya.mcp.cmd_test_desc',
      '临时连接一个 MCP 服务器，返回它自报的信息与工具列表（不影响已保存的连接）'
    ),
    usage: t('yaya.mcp.cmd_test_usage', 'yaya.mcp-test --server <MCP 服务器配置 JSON>'),
    // 配置里可能带凭据（Authorization 等）→ 参数不写 IPC 日志
    logArgs: false,
    privacy: { agent: 'deny' },
    run: async (ctx) => {
      const resolved = resolveServer(ctx.named.server)
      if ('error' in resolved) return { ok: false, error: resolved.error }

      const server = resolved.server
      const secrets = Object.values(plainHeaders(server.headers))
      let conn: McpConnection | null = null
      try {
        conn = await McpConnection.open(server, { timeoutMs: CONNECT_TIMEOUT_MS })
        const tools = (await conn.listTools()).map((tool) => ({
          name: String(tool.name ?? ''),
          description: String(tool.description ?? '').trim()
        }))
        return {
          ok: true,
          serverInfo: conn.serverInfo,
          instructions: conn.instructions || undefined,
          tools
        }
      } catch (e) {
        const error = describeMcpError(e, secrets)
        log.info('mcp test connection failed', { server: server.id, error })
        return { ok: false, error }
      } finally {
        if (conn) await conn.close().catch(() => {})
      }
    }
  }
]
