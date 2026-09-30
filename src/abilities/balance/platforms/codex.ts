import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { BalanceResult, PlatformConfig } from '../types'
import { createTimeoutSignal, platformFetch, type PlatformFetcher } from './base'
import { makeLogger } from '../../../main/process/logger'

const log = makeLogger('balance:codex')

const DEFAULT_AUTH_PATH = join(homedir(), '.codex', 'auth.json')
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const USAGE_API_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

export interface CodexAuthData {
  auth_mode?: string
  OPENAI_API_KEY?: string | null
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
}

export interface WhamUsageResponse {
  user_id?: string
  account_id?: string
  email?: string
  plan_type?: string
  rate_limit?: {
    allowed?: boolean
    limit_reached?: boolean
    primary_window?: {
      used_percent?: number
      limit_window_seconds?: number
      reset_after_seconds?: number
      reset_at?: number
    }
    secondary_window?: {
      used_percent?: number
      limit_window_seconds?: number
      reset_after_seconds?: number
      reset_at?: number
    }
  }
  credits?: {
    has_credits?: boolean
    unlimited?: boolean
    overage_limit_reached?: boolean
    balance?: string
  }
  spend_control?: {
    reached?: boolean
    individual_limit?: unknown
  }
  rate_limit_reset_credits?: {
    available_count?: number
    applicable_available_count?: number
  }
}

/**
 * Parses and extracts credentials from auth.json raw string or object.
 */
export function parseCodexAuth(raw: string | object): {
  accessToken: string
  accountId: string
  refreshToken: string
  idToken?: string
  planType?: string
} {
  let data: CodexAuthData
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('{')) {
      data = JSON.parse(trimmed) as CodexAuthData
    } else {
      // Just a token string
      return { accessToken: trimmed, accountId: '', refreshToken: '' }
    }
  } else {
    data = raw as CodexAuthData
  }

  const tokens = data.tokens || {}
  const accessToken = (tokens.access_token || '').trim()
  const accountId = (tokens.account_id || '').trim()
  const refreshToken = (tokens.refresh_token || '').trim()
  const idToken = tokens.id_token

  let planType: string | undefined
  if (idToken) {
    try {
      const parts = idToken.split('.')
      if (parts.length >= 2) {
        let payload = parts[1]
        payload += '='.repeat((4 - (payload.length % 4)) % 4)
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
        const authClaim = parsed['https://api.openai.com/auth']
        if (authClaim && typeof authClaim === 'object' && authClaim.chatgpt_plan_type) {
          planType = String(authClaim.chatgpt_plan_type)
        }
      }
    } catch {
      // Ignore token parse error
    }
  }

  return { accessToken, accountId, refreshToken, idToken, planType }
}

/**
 * Refreshes an expired ChatGPT access token using OAuth refresh_token.
 */
export async function refreshChatGPTToken(
  refreshToken: string,
  timeoutMs = 15000
): Promise<{
  accessToken: string
  refreshToken: string
  idToken?: string
}> {
  if (!refreshToken) {
    throw new Error('缺少 refresh_token，无法自动刷新凭据')
  }

  const res = await platformFetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }),
    signal: createTimeoutSignal(timeoutMs)
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Token 刷新失败 (HTTP ${res.status}): ${errText || res.statusText}`)
  }

  const data = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    id_token?: string
  }

  if (!data.access_token) {
    throw new Error('OAuth 刷新响应中缺少 access_token')
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    idToken: data.id_token
  }
}

export class CodexFetcher implements PlatformFetcher {
  readonly type = 'codex'
  readonly defaultName = 'Codex (ChatGPT 配额)'
  readonly defaultIcon = 'default/lightning/padding'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()

    let accessToken = config.apiKey?.trim() || ''
    let accountId = String(config.extra?.accountId || '').trim()
    let refreshToken = String(config.extra?.refreshToken || '').trim()

    // 1. If accessToken looks like a full JSON or auth.json content was pasted
    if (accessToken.startsWith('{')) {
      try {
        const parsed = parseCodexAuth(accessToken)
        accessToken = parsed.accessToken
        if (parsed.accountId && !accountId) accountId = parsed.accountId
        if (parsed.refreshToken && !refreshToken) refreshToken = parsed.refreshToken
      } catch {
        // Continue with raw token
      }
    }

    // 2. If missing token or accountId, attempt reading from ~/.codex/auth.json or custom path
    if (!accessToken || !accountId) {
      const authPath = (config.extra?.authJsonPath as string) || DEFAULT_AUTH_PATH
      if (existsSync(authPath)) {
        try {
          const raw = readFileSync(authPath, 'utf8')
          const parsed = parseCodexAuth(raw)
          if (!accessToken && parsed.accessToken) accessToken = parsed.accessToken
          if (!accountId && parsed.accountId) accountId = parsed.accountId
          if (!refreshToken && parsed.refreshToken) refreshToken = parsed.refreshToken
        } catch (e) {
          log.warn('Failed to read local auth.json:', e)
        }
      }
    }

    if (!accessToken) {
      throw new Error('未配置 Access Token，请在平台设置中填入或点击「导入 ~/.codex/auth.json」')
    }

    // Helper to send query
    const sendQuery = async (token: string, acctId: string): Promise<Response> => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'codex/0.149.1',
        Accept: 'application/json'
      }
      if (acctId) {
        headers['ChatGPT-Account-Id'] = acctId
      }

      const url = config.baseUrl?.trim() || USAGE_API_URL
      return await platformFetch(url, {
        method: 'GET',
        headers,
        signal: createTimeoutSignal(timeoutMs)
      })
    }

    let resp = await sendQuery(accessToken, accountId)

    // 3. Handle 401 Unauthorized -> Refresh token
    if (resp.status === 401 && refreshToken) {
      log.info('Codex access token expired (401), attempting refresh...')
      try {
        const refreshed = await refreshChatGPTToken(refreshToken, timeoutMs)
        accessToken = refreshed.accessToken
        refreshToken = refreshed.refreshToken

        // Update in-memory config extra
        config.apiKey = accessToken
        if (!config.extra) config.extra = {}
        config.extra.refreshToken = refreshToken
        if (refreshed.idToken) config.extra.idToken = refreshed.idToken

        // Retry request
        resp = await sendQuery(accessToken, accountId)
      } catch (refreshErr) {
        log.error('Failed to auto-refresh Codex token:', refreshErr)
        throw new Error(
          `Token 已失效且自动刷新失败: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`
        )
      }
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}: ${errText || resp.statusText}`)
    }

    const data = (await resp.json()) as WhamUsageResponse

    const rate = data.rate_limit || {}
    const pw = rate.primary_window
    const sw = rate.secondary_window
    const credits = data.credits
    const resetCredits = data.rate_limit_reset_credits

    // Compute remaining percentage for primary window (5 hours) and secondary window (weekly)
    const primaryUsed = pw?.used_percent ?? 0
    const primaryRemaining = Math.max(0, 100 - primaryUsed)

    const secondaryUsed = sw?.used_percent ?? 0
    const secondaryRemaining = Math.max(0, 100 - secondaryUsed)

    const planName = (data.plan_type || 'unknown').toUpperCase()

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: '%',
      amount: primaryRemaining,
      total: 100,
      used: primaryUsed,
      unit: '%',
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: {
        ...data,
        summary: {
          planType: planName,
          allowed: rate.allowed !== false,
          limitReached: !!rate.limit_reached,
          primaryWindow: pw
            ? {
                usedPercent: pw.used_percent ?? 0,
                remainingPercent: primaryRemaining,
                windowHours: Math.round((pw.limit_window_seconds ?? 18000) / 3600),
                resetAfterSeconds: pw.reset_after_seconds ?? 0,
                resetAfterMinutes: Math.round((pw.reset_after_seconds ?? 0) / 60),
                resetAt: pw.reset_at ? pw.reset_at * 1000 : null
              }
            : null,
          secondaryWindow: sw
            ? {
                usedPercent: sw.used_percent ?? 0,
                remainingPercent: secondaryRemaining,
                windowDays: Math.round((sw.limit_window_seconds ?? 604800) / 86400),
                resetAfterSeconds: sw.reset_after_seconds ?? 0,
                resetAfterHours: Math.round((sw.reset_after_seconds ?? 0) / 3600),
                resetAt: sw.reset_at ? sw.reset_at * 1000 : null
              }
            : null,
          credits: credits
            ? {
                balance: credits.balance || '0',
                hasCredits: !!credits.has_credits,
                unlimited: !!credits.unlimited
              }
            : null,
          resetCredits: resetCredits
            ? {
                availableCount: resetCredits.available_count ?? 0,
                applicableCount: resetCredits.applicable_available_count ?? 0
              }
            : null,
          email: data.email || null,
          accountId: data.account_id || null
        }
      }
    }
  }
}
