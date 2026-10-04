import type { CommandContext, CommandSpec } from '../../main/process/commands/types'
import { getAgentStatus, disconnectSession, restartForNewToken } from '../../main/process/agent'
import { getAgentToken, regenerateAgentToken } from '../../main/process/agent/config'
import {
  controlSession,
  listSessions,
  pauseAllSessions,
  setSessionPage,
  getAttentionDetail,
  getSession,
  type SessionAction
} from '../../main/process/agent/sessions'
import { followAgentView, unfollowAgentView } from '../../main/process/agent/views'
import { followModeSetting } from '../../main/process/agent/config'
import { currentOrigin } from '../../main/process/privacy'
import { listRunGrants, revokeRunGrants } from '../../main/process/privacy'
import { listLeases, release, takeOver } from '../../main/process/exclusive'

/** 只能由用户本人（设置页 / CLI）调用：token、断开会话、撤销授权。 */
const USER_ONLY = { agent: 'deny' } as const

/** 读取 --scope / --key；缺失时抛出清楚的中文错误（签名 + 示例）。 */
function leaseTarget(ctx: CommandContext): { scope: string; key: string } {
  const scope = String(ctx.named.scope ?? '').trim()
  const key = String(ctx.named.key ?? '').trim()
  if (!scope || !key) {
    throw new Error(
      '缺少参数：--scope 与 --key 必填，如 exclusive.take-over --scope gameboy.rom --key pokemon-red'
    )
  }
  return { scope, key }
}

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
    name: 'agent.follow',
    enabled: () => process.env.COCKPIT_HEADLESS !== '1',
    unavailableReason: '无头（Headless）模式下不支持桌面跟随视图',
    description:
      '查看某个 agent 的独立视图 (--id)：默认在主窗口里跟随（agent.ui.followMode 可改为单独窗口），没有视图就先建。agent 在这个视图里操作，不影响你自己的界面',
    usage: 'agent.follow --id <sessionId>',
    privacy: USER_ONLY,
    ui: ['标题栏 AI 图标条：点击头像'],
    run: async (ctx) => ({
      ok: await followAgentView(String(ctx.named.id ?? ''), await followModeSetting())
    })
  },
  {
    name: 'agent.unfollow',
    enabled: () => process.env.COCKPIT_HEADLESS !== '1',
    unavailableReason: '无头（Headless）模式下不支持桌面跟随视图',
    description: '结束跟随某个 agent (--id)：回到你自己的界面，它的视图继续在后台替它工作',
    usage: 'agent.unfollow --id <sessionId>',
    privacy: USER_ONLY,
    run: (ctx) => ({ ok: unfollowAgentView(String(ctx.named.id ?? '')) })
  },
  {
    name: 'agent.report-page',
    description:
      'agent 视图上报自己当前所在页面 (--page <能力id>)，仅对 agent 视图发出的调用生效，用于标题栏悬停提示',
    usage: 'agent.report-page --page aidj',
    privacy: {},
    run: (ctx) => {
      const o = currentOrigin()
      if (o.kind === 'agent-ui' && o.session) setSessionPage(o.session, ctx.named.page)
      return { ok: true }
    }
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
    name: 'agent.control',
    description:
      '暂停 / 继续 / 停止一个 agent 会话，或批准 / 拒绝它挂起的请求（--id --action pause|resume|stop|approve|reject；只对登记了控制器的会话有效，如 YAYA 的运行）',
    usage:
      'agent.control --id <sessionId> --action pause|resume|stop|approve|reject [--scope once|run|session]',
    privacy: USER_ONLY,
    run: (ctx) => {
      const action = String(ctx.named.action ?? '')
      if (!['pause', 'resume', 'stop', 'approve', 'reject'].includes(action))
        throw new Error('action must be pause | resume | stop | approve | reject')
      const scope =
        ctx.named.scope === 'run' || ctx.named.scope === 'session' ? ctx.named.scope : 'once'
      return { ok: controlSession(String(ctx.named.id ?? ''), action as SessionAction, scope) }
    }
  },
  {
    name: 'agent.attention-detail',
    description:
      '读取 agent 会话待处理事项的详情（如 YAYA 等待批准的工具调用参数），给悬浮窗展开查看',
    usage: 'agent.attention-detail --id <sessionId>',
    privacy: USER_ONLY,
    run: (ctx) => {
      const id = String(ctx.named.id ?? '')
      return {
        attention: getSession(id)?.attention ?? null,
        detail: getAttentionDetail(id) ?? null
      }
    }
  },
  {
    name: 'agent.pause-all',
    description: '暂停所有可暂停的 AI 操作（人和 AI 共用界面时的紧急叫停）',
    usage: 'agent.pause-all',
    privacy: USER_ONLY,
    run: () => ({ ok: true, paused: pauseAllSessions() })
  },
  {
    name: 'agent.revoke-grants',
    description: '撤销「关闭 Cockpit 前都允许」的授权 (--scope <id>，缺省全部)',
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
  },
  {
    name: 'exclusive.list',
    description:
      '列出当前所有独占租约（scope、key、能力名、拥有者是人还是哪个 AI、epoch、已持有毫秒数 heldMs、空闲毫秒数 idleMs）。只读：不获取也不释放租约。界面据此显示「该页面的资源正被 AI 占用」窄条',
    usage: 'exclusive.list',
    privacy: {},
    related: ['exclusive.release', 'exclusive.take-over'],
    ui: ['外壳页面顶部窄条（资源被 AI 占用时）'],
    run: () => {
      const now = Date.now()
      return listLeases().map((l) => ({
        scope: l.scope,
        key: l.key,
        ability: l.ability,
        label: l.label,
        owner: l.owner,
        epoch: l.epoch,
        acquiredAt: l.acquiredAt,
        lastActive: l.lastActive,
        heldMs: now - l.acquiredAt,
        idleMs: now - l.lastActive,
        ...(l.host === undefined ? {} : { host: l.host })
      }))
    }
  },
  {
    name: 'exclusive.release',
    description:
      '释放一份独占资源 (--scope <能力id.名> --key <资源键>)。AI 只能释放自己持有的租约，用户可以释放任意租约；没有该租约或无权释放时返回 { ok: false }。用户被 AI 告知占用时，让 AI 释放即可，不要抢占',
    usage: 'exclusive.release --scope gameboy.rom --key pokemon-red',
    privacy: {},
    related: ['exclusive.list', 'exclusive.take-over'],
    run: (ctx) => {
      const { scope, key } = leaseTarget(ctx)
      return { ok: release(scope, key) }
    }
  },
  {
    name: 'exclusive.take-over',
    description:
      '用户接管一份独占资源 (--scope --key)：占用它的 AI 立即失去占用，它下一次调用会收到 lease_lost。用户永远优先，只能由用户本人调用',
    usage: 'exclusive.take-over --scope gameboy.rom --key pokemon-red',
    privacy: USER_ONLY,
    related: ['exclusive.list', 'exclusive.release'],
    ui: ['外壳页面顶部窄条「接管」按钮'],
    run: (ctx) => {
      const { scope, key } = leaseTarget(ctx)
      const l = takeOver(scope, key)
      return {
        ok: true,
        scope: l.scope,
        key: l.key,
        ability: l.ability,
        owner: l.owner,
        epoch: l.epoch,
        acquiredAt: l.acquiredAt,
        heldMs: 0,
        idleMs: 0
      }
    }
  }
] satisfies CommandSpec[]
