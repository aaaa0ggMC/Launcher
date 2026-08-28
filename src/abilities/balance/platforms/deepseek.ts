import type { BalanceResult, PlatformConfig } from '../types'
import { createTimeoutSignal, type PlatformFetcher } from './base'

export class DeepSeekFetcher implements PlatformFetcher {
  readonly type = 'deepseek'
  readonly defaultName = 'DeepSeek'
  readonly defaultIcon = 'gi:settings'

  async fetchBalance(config: PlatformConfig, timeoutMs: number): Promise<BalanceResult> {
    const start = performance.now()
    if (!config.apiKey) {
      throw new Error('未配置 DeepSeek API Key')
    }

    const url = config.baseUrl || 'https://api.deepseek.com/user/balance'
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
      is_available?: boolean
      balance_infos?: Array<{
        currency: string
        total_balance: string | number
        granted_balance?: string | number
        topped_up_balance?: string | number
      }>
    }

    const info = data.balance_infos?.[0]
    if (!info) {
      throw new Error('未找到 balance_infos 余额信息')
    }

    const total = parseFloat(String(info.total_balance ?? 0))
    const granted = parseFloat(String(info.granted_balance ?? 0))
    const toppedUp = parseFloat(String(info.topped_up_balance ?? total - granted))

    return {
      id: config.id,
      name: config.name || this.defaultName,
      type: this.type,
      icon: config.icon || this.defaultIcon,
      currency: info.currency || 'CNY',
      amount: toppedUp,
      voucher: granted > 0 ? granted : undefined,
      total,
      latencyMs: Math.round(performance.now() - start),
      updatedAt: Date.now(),
      raw: data as Record<string, unknown>
    }
  }
}
