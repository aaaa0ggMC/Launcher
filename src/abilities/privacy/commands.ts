import { is } from '@electron-toolkit/utils'
import type { CommandSpec } from '../../main/process/commands/types'
import { runCommand } from '../../main/process/commands/registry'
import {
  listPrivacyScopes,
  hasClearance,
  isGrantable,
  requestClearance,
  waitClearance,
  listPendingRequests,
  listRunGrants,
  getPrivacyPolicy,
  currentOrigin,
  withOrigin
} from '../../main/process/privacy'

/** `--scopes a,b` (CLI) 或 `scopes: ['a','b']` (结构化) */
function scopesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  if (typeof v === 'string')
    return v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  return []
}

/** 单次请求等待上限：低于常见 MCP 客户端 60s 超时，到点返回 pending。 */
const WAIT_MS = 45_000

/**
 * privacy.* —— 隐私 SDK 的命令面。注意：**没有「批准」命令**，批准只能在授权窗口里由用户点。
 */
export default [
  {
    name: 'privacy.scopes',
    description: '列出全部隐私 scope（级别 / 是否可申请 / 当前来源是否已持有）',
    usage: 'privacy.scopes',
    privacy: {},
    run: () =>
      listPrivacyScopes().map((s) => ({
        id: s.id,
        ability: s.ability,
        level: s.level,
        capability: s.capability,
        grantable: isGrantable(s.id),
        held: hasClearance(s.id)
      }))
  },
  {
    name: 'privacy.status',
    description: '当前调用来源、隐私策略、本次运行的授权与待处理请求',
    usage: 'privacy.status',
    privacy: {},
    run: () => ({
      origin: currentOrigin(),
      policy: getPrivacyPolicy(),
      runGrants: listRunGrants(),
      pending: listPendingRequests().map((r) => ({
        id: r.id,
        scopes: r.scopes,
        client: r.origin.client,
        expiresAt: r.expiresAt
      }))
    })
  },
  {
    name: 'privacy.request',
    description:
      '申请隐私许可 (--scopes a,b --reason "...")；用户在授权窗口决定，最多等待 45 秒，未决返回 pending + requestId',
    usage: 'privacy.request --scopes campusinfo.identity --reason "核对学号"',
    privacy: {},
    run: async (ctx) => {
      const scopes = scopesOf(ctx.named.scopes)
      if (scopes.length === 0) return { ok: false, error: '需要 --scopes' }
      const res = await requestClearance(scopes, String(ctx.named.reason ?? ''), {
        waitMs: WAIT_MS
      })
      return { ok: res.status === 'granted', ...res }
    }
  },
  {
    name: 'privacy.wait',
    description: '继续等待一个 pending 的授权请求 (--id)，最多 45 秒',
    usage: 'privacy.wait --id <requestId>',
    privacy: {},
    run: async (ctx) => {
      const id = String(ctx.named.id ?? '')
      if (!id) return { ok: false, error: '需要 --id' }
      const res = await waitClearance(id, WAIT_MS)
      return { ok: res.status === 'granted', ...res }
    }
  },
  {
    name: 'privacy.debug-request',
    description: '[dev] 以模拟 agent 身份申请许可，用于手动测试授权窗口 (--scopes --reason)',
    usage: 'privacy.debug-request --scopes campusinfo.identity --reason "测试"',
    // 只在开发模式暴露；且 agent 不可调用（避免 agent 借它伪造来源）
    enabled: () => is.dev,
    privacy: { agent: 'deny' },
    run: async (ctx) => {
      const scopes = scopesOf(ctx.named.scopes)
      if (scopes.length === 0) return { ok: false, error: '需要 --scopes' }
      return await withOrigin({ kind: 'mcp', session: 'debug', client: 'debug-cli' }, () =>
        requestClearance(scopes, String(ctx.named.reason ?? ''), { waitMs: WAIT_MS })
      )
    }
  },
  {
    name: 'privacy.debug-as-agent',
    description:
      '[dev] 以模拟 agent（mcp）身份执行任意命令，查看 AI 视角下的结果 (--cmd <name> [--args <json>])',
    usage: 'privacy.debug-as-agent --cmd ui.snapshot --args \'{"mode":"full"}\'',
    enabled: () => is.dev,
    privacy: { agent: 'deny' },
    run: async (ctx) => {
      const name = String(ctx.named.cmd ?? '')
      if (!name) return { ok: false, error: '需要 --cmd' }
      let args: Record<string, unknown> = {}
      const raw = ctx.named.args
      if (typeof raw === 'string' && raw.trim()) {
        try {
          args = JSON.parse(raw) as Record<string, unknown>
        } catch {
          return { ok: false, error: '--args 不是合法 JSON' }
        }
      } else if (raw && typeof raw === 'object') {
        args = raw as Record<string, unknown>
      }
      return await withOrigin({ kind: 'mcp', session: 'debug', client: 'debug-cli' }, () =>
        runCommand(name, args)
      )
    }
  }
] satisfies CommandSpec[]
