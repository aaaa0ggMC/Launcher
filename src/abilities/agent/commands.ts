import type { CommandSpec } from '../../main/process/commands/types'
import { getAgentStatus, disconnectSession, restartForNewToken } from '../../main/process/agent'
import { getAgentToken, regenerateAgentToken } from '../../main/process/agent/config'
import { listSessions } from '../../main/process/agent/sessions'
import { listRunGrants, revokeRunGrants } from '../../main/process/privacy'

/** 只能由用户本人（设置页 / CLI）调用：token、断开会话、撤销授权。 */
const USER_ONLY = { agent: 'deny' } as const

/**
 * agent.* —— Remote / MCP 网关的状态与管理（设置页「AI 与远程」使用）。
 * 开关与端口写在 config.json 的 `agent.*`（settings 的 config.set 拒绝 agent 写入）。
 */
export default [
  {
    name: 'agent.status',
    description: 'Remote / MCP 服务状态（是否运行、端口、地址、启动参数开启、错误）',
    usage: 'agent.status',
    privacy: {},
    run: () => getAgentStatus()
  },
  {
    name: 'agent.sessions',
    description: '当前连接的 agent 会话与本次运行的授权',
    usage: 'agent.sessions',
    privacy: {},
    run: () => ({ sessions: listSessions(), runGrants: listRunGrants() })
  },
  {
    name: 'agent.token',
    description: '读取 Remote / MCP 的访问 token',
    usage: 'agent.token',
    privacy: USER_ONLY,
    run: async () => ({ token: await getAgentToken() })
  },
  {
    name: 'agent.token.regenerate',
    description: '重新生成访问 token（旧 token 立即失效，已连接的会话断开）',
    usage: 'agent.token.regenerate',
    privacy: USER_ONLY,
    run: async () => {
      const token = await regenerateAgentToken()
      await restartForNewToken()
      return { ok: true, token }
    }
  },
  {
    name: 'agent.disconnect',
    description: '断开一个 agent 会话 (--id)，并撤销它的「允许本次」授权',
    usage: 'agent.disconnect --id <sessionId>',
    privacy: USER_ONLY,
    run: (ctx) => ({ ok: disconnectSession(String(ctx.named.id ?? '')) })
  },
  {
    name: 'agent.revoke-grants',
    description: '撤销「本次运行始终允许」的授权 (--scope <id>，缺省全部)',
    usage: 'agent.revoke-grants [--scope campusinfo.identity]',
    privacy: USER_ONLY,
    run: (ctx) => {
      revokeRunGrants(ctx.named.scope ? String(ctx.named.scope) : undefined)
      return { ok: true, runGrants: listRunGrants() }
    }
  },
  {
    name: 'agent.mcp-config',
    description: '生成接入 MCP 客户端的配置（Claude Code 命令 / JSON），含 token',
    usage: 'agent.mcp-config',
    privacy: USER_ONLY,
    run: async () => {
      const st = getAgentStatus().mcp
      const token = await getAgentToken()
      const url = `http://127.0.0.1:${st.port}/mcp`
      return {
        url,
        claudeCode: `claude mcp add --transport http cockpit ${url} --header "Authorization: Bearer ${token}"`,
        json: {
          mcpServers: {
            cockpit: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } }
          }
        }
      }
    }
  }
] satisfies CommandSpec[]
