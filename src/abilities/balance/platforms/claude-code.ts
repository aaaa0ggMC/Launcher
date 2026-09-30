import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { BalanceResult, PlatformConfig } from '../types'
import { createTimeoutSignal, platformFetch, type PlatformFetcher } from './base'

const DEFAULT_CRED_PATH = join(homedir(), '.claude', '.credentials.json')
const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage'

interface UsageWindow {
  utilization?: number | null
  resets_at?: string | null
}

interface ClaudeUsageResponse {
  five_hour?: UsageWindow | null
  seven_day?: UsageWindow | null
  seven_day_opus?: UsageWindow | null
  seven_day_sonnet?: UsageWindow | null
  extra_usage?: {
    is_enabled?: boolean
    monthly_limit?: number | null
    used_credits?: number | null
    currency?: string | null
  } | null
}

interface ClaudeCredentials {
  accessToken: string
  expiresAt?: number
  subscriptionType?: string
}

function readCredentials(path: string): ClaudeCredentials | null {
  if (!existsSync(path)) return null
  const oauth = JSON.parse(readFileSync(path, 'utf8'))?.claudeAiOauth
  if (!oauth?.accessToken) return null
  return {
    accessToken: String(oauth.accessToken),
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    subscriptionType: oauth.subscriptionType ? String(oauth.subscriptionType) : undefined
  }
}

/** 输出与 Codex 相同形状的 summary，前端配额卡片复用。 */
function windowSummary(
  w: UsageWindow | null | undefined,
  seconds: number
): Record<string, unknown> | null {
  if (!w || w.utilization == null) return null
  const used = Math.min(100, Math.max(0, Math.round(w.utilization)))
  const resetAt = w.resets_at ? Date.parse(w.resets_at) : NaN
  const after = isNaN(resetAt) ? 0 : Math.max(0, Math.round((resetAt - Date.now()) / 1000))
  return {
    usedPercent: used,
    remainingPercent: 100 - used,
    windowHours: Math.round(seconds / 3600),
    windowDays: Math.round(seconds / 86400),
    resetAfterSeconds: after,
    resetAfterMinutes: Math.round(after / 60),
    resetAfterHours: Math.round(after / 3600),
    resetAt: isNaN(resetAt) ? null : resetAt
  }
}

export class ClaudeCodeFetcher implements PlatformFetcher {
  readonly type = 'claude_code'
  readonly defaultName = 'Claude Code (订阅配额)'
  readonly defaultIcon = 'default/lightning/padding'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()
    const pasted = config.apiKey?.trim() || ''
    let token = pasted
    let planType = ''

    // 不主动刷新：refresh_token 会轮换，抢在 Claude Code 之前刷新会让它掉登录。每次直接读最新文件。
    if (!token) {
      const path = (config.extra?.credentialsPath as string) || DEFAULT_CRED_PATH
      const cred = readCredentials(path)
      if (!cred) throw new Error(`未找到 Claude Code 凭据：${path}（先运行一次 claude 登录）`)
      if (cred.expiresAt && cred.expiresAt < Date.now()) {
        throw new Error('Claude Code 登录已过期，请运行一次 claude 让它自动刷新后再试')
      }
      token = cred.accessToken
      planType = cred.subscriptionType || ''
    }

    const resp = await platformFetch(USAGE_API_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.0.0',
        Accept: 'application/json'
      },
      signal: createTimeoutSignal(timeoutMs)
    })
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errText || resp.statusText}`)
    }
    const data = (await resp.json()) as ClaudeUsageResponse

    const primary = windowSummary(data.five_hour, 5 * 3600)
    const secondary = windowSummary(data.seven_day, 7 * 86400)
    const primaryUsed = (primary?.usedPercent as number) ?? 0
    const extra = data.extra_usage

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: '%',
      amount: 100 - primaryUsed,
      total: 100,
      used: primaryUsed,
      unit: '%',
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: {
        ...data,
        summary: {
          planType: (planType || 'claude').toUpperCase(),
          allowed: true,
          limitReached: primaryUsed >= 100 || ((secondary?.usedPercent as number) ?? 0) >= 100,
          primaryWindow: primary,
          secondaryWindow: secondary,
          credits:
            extra?.is_enabled && extra.monthly_limit != null
              ? {
                  balance: String(
                    Math.max(0, (extra.monthly_limit - (extra.used_credits ?? 0)) / 100).toFixed(2)
                  ),
                  hasCredits: true
                }
              : null,
          resetCredits: null,
          subscription: null,
          email: null
        }
      }
    }
  }
}
