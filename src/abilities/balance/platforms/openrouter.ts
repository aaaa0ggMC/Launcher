import type { BalanceResult, PlatformConfig } from '../types'
import { createTimeoutSignal, type PlatformFetcher } from './base'

export class OpenRouterFetcher implements PlatformFetcher {
  readonly type = 'openrouter'
  readonly defaultName = 'OpenRouter'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()
    if (!config.apiKey) {
      throw new Error('未配置 OpenRouter API Key')
    }

    const url = config.baseUrl || 'https://openrouter.ai/api/v1/credits'
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
      data?: {
        total_credits?: number
        total_usage?: number
      }
    }

    if (!data.data) {
      throw new Error('返回结构中缺少 data 字段')
    }

    const total = Number(data.data.total_credits ?? 0)
    const used = Number(data.data.total_usage ?? 0)
    const remaining = total - used

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: 'USD',
      amount: remaining,
      total,
      used,
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: data as Record<string, unknown>
    }
  }
}
