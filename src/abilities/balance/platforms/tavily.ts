import type { BalanceResult, PlatformConfig } from '../types'
import { createTimeoutSignal, type PlatformFetcher } from './base'

export class TavilyFetcher implements PlatformFetcher {
  readonly type = 'tavily'
  readonly defaultName = 'Tavily'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()
    if (!config.apiKey) {
      throw new Error('未配置 Tavily API Key')
    }

    const url = config.baseUrl || 'https://api.tavily.com/usage'
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json'
      },
      signal: createTimeoutSignal(timeoutMs)
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`)
    }

    const data = (await res.json()) as {
      account?: {
        plan_limit?: number | string
        plan_usage?: number | string
      }
    }

    const acct = data.account
    if (!acct) {
      throw new Error('返回结构中缺少 account 字段')
    }

    const limit = Number(acct.plan_limit ?? 0)
    const usage = Number(acct.plan_usage ?? 0)
    const remaining = Math.max(0, limit - usage)

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: 'Credits',
      amount: remaining,
      total: limit,
      used: usage,
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: data as Record<string, unknown>
    }
  }
}
